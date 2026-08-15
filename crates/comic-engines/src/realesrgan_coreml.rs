//! In-process Real-ESRGAN Anime 4× via Core ML (macOS).

use crate::{
    EngineAvailability, EngineError, EngineKind, EngineStatus, EnhanceBatchRequest,
    EnhanceBatchResult, GpuInfo, UpscaleEngine,
};
use async_trait::async_trait;
use image::RgbImage;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

const SCALE: u32 = 4;

#[cfg(target_os = "macos")]
mod ffi {
    use std::os::raw::{c_char, c_int, c_uchar};
    unsafe extern "C" {
        pub fn comic_esrgan_coreml_load(model_path: *const c_char) -> c_int;
        pub fn comic_esrgan_coreml_enhance_rgb(
            rgb: *const c_uchar,
            width: c_int,
            height: c_int,
            out_rgb: *mut c_uchar,
            out_cap: c_int,
            out_w: *mut c_int,
            out_h: *mut c_int,
            cancel_flag: *const c_int,
        ) -> c_int;
    }
}

#[derive(Clone)]
pub struct RealEsrganCoreMlEngine {
    pub model_path: PathBuf,
}

impl RealEsrganCoreMlEngine {
    pub fn new(model_path: PathBuf) -> Self {
        Self { model_path }
    }

    fn load(&self) -> Result<(), EngineError> {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = &self.model_path;
            return Err(EngineError::Process("仅 macOS 支持 Core ML".into()));
        }
        #[cfg(target_os = "macos")]
        {
            use std::ffi::CString;
            let c = CString::new(self.model_path.to_string_lossy().as_bytes())
                .map_err(|e| EngineError::Process(e.to_string()))?;
            let rc = unsafe { ffi::comic_esrgan_coreml_load(c.as_ptr()) };
            if rc != 0 {
                return Err(EngineError::Process(format!(
                    "Real-ESRGAN Core ML 加载失败 ({rc}): {}",
                    self.model_path.display()
                )));
            }
            Ok(())
        }
    }
}

fn open_rgb(input: &Path) -> Result<RgbImage, EngineError> {
    let dynimg = image::ImageReader::open(input)
        .map_err(|e| EngineError::Image(e.to_string()))?
        .with_guessed_format()
        .map_err(|e| EngineError::Image(e.to_string()))?
        .decode()
        .map_err(|e| EngineError::Image(e.to_string()))?;
    Ok(dynimg.to_rgb8())
}

fn run_file(input: &Path, output: &Path, cancel: &CancellationToken) -> Result<(), EngineError> {
    if cancel.is_cancelled() {
        return Err(EngineError::Cancelled);
    }
    let t0 = Instant::now();
    let rgb = open_rgb(input)?;
    let src_w = rgb.width();
    let src_h = rgb.height();
    if src_w == 0 || src_h == 0 {
        return Err(EngineError::Image("空图像".into()));
    }
    let out_w = src_w.saturating_mul(SCALE);
    let out_h = src_h.saturating_mul(SCALE);
    let cap = (out_w as usize)
        .checked_mul(out_h as usize)
        .and_then(|n| n.checked_mul(3))
        .ok_or_else(|| EngineError::Image("输出尺寸过大".into()))?;
    let mut out_buf = vec![0u8; cap];
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut ow = 0i32;
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut oh = 0i32;
    let cancel_flag: i32 = if cancel.is_cancelled() { 1 } else { 0 };

    #[cfg(target_os = "macos")]
    let rc = unsafe {
        ffi::comic_esrgan_coreml_enhance_rgb(
            rgb.as_raw().as_ptr(),
            src_w as i32,
            src_h as i32,
            out_buf.as_mut_ptr(),
            cap as i32,
            &mut ow,
            &mut oh,
            &cancel_flag,
        )
    };
    #[cfg(not(target_os = "macos"))]
    let rc = {
        let _ = (&out_buf, &ow, &oh, &cancel_flag, &rgb);
        -1
    };

    if cancel.is_cancelled() || rc == -9 {
        return Err(EngineError::Cancelled);
    }
    if rc != 0 {
        return Err(EngineError::Process(format!(
            "Real-ESRGAN Core ML 推理失败 ({rc})"
        )));
    }
    let ow = if ow > 0 { ow as u32 } else { out_w };
    let oh = if oh > 0 { oh as u32 } else { out_h };
    out_buf.truncate(ow as usize * oh as usize * 3);
    let cropped = RgbImage::from_raw(ow, oh, out_buf)
        .ok_or_else(|| EngineError::Image("无法组装输出".into()))?;

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| EngineError::Io(e.to_string()))?;
    }
    {
        use std::io::BufWriter;
        let file = std::fs::File::create(output).map_err(|e| EngineError::Io(e.to_string()))?;
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(BufWriter::new(file), 94);
        enc.encode(
            cropped.as_raw(),
            cropped.width(),
            cropped.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| EngineError::Image(e.to_string()))?;
    }
    info!(
        w = src_w,
        h = src_h,
        out_w = ow,
        out_h = oh,
        ms = t0.elapsed().as_millis() as u64,
        "realesrgan-coreml page"
    );
    Ok(())
}

#[async_trait]
impl UpscaleEngine for RealEsrganCoreMlEngine {
    fn id(&self) -> EngineKind {
        EngineKind::RealEsrganCoreMl
    }

    fn is_available(&self) -> EngineAvailability {
        if !cfg!(target_os = "macos") {
            return EngineAvailability::Unavailable("仅 macOS".into());
        }
        if self.model_path.is_file() || self.model_path.is_dir() {
            EngineAvailability::Ready
        } else {
            EngineAvailability::MissingBinary
        }
    }

    fn status(&self) -> EngineStatus {
        match self.is_available() {
            EngineAvailability::Ready => EngineStatus {
                id: "realesrgan-coreml".into(),
                available: true,
                detail: format!("Core ML 就绪 · {}", self.model_path.display()),
                version: Some("anime-6B-4x".into()),
            },
            EngineAvailability::MissingBinary => EngineStatus {
                id: "realesrgan-coreml".into(),
                available: false,
                detail:
                    "未找到 Real-ESRGAN Core ML 模型，请运行 scripts/fetch-realesrgan-coreml.sh"
                        .into(),
                version: None,
            },
            EngineAvailability::Unavailable(s) => EngineStatus {
                id: "realesrgan-coreml".into(),
                available: false,
                detail: s,
                version: None,
            },
            _ => EngineStatus {
                id: "realesrgan-coreml".into(),
                available: false,
                detail: "不可用".into(),
                version: None,
            },
        }
    }

    async fn list_gpus(&self) -> Result<Vec<GpuInfo>, EngineError> {
        Ok(vec![GpuInfo {
            id: 0,
            name: "Apple Core ML (ANE/GPU)".into(),
            is_cpu: false,
        }])
    }

    async fn enhance_batch(
        &self,
        req: EnhanceBatchRequest,
        cancel: CancellationToken,
    ) -> Result<EnhanceBatchResult, EngineError> {
        self.load()?;
        match req {
            EnhanceBatchRequest::SingleFile { input, output, .. } => {
                let inp = input.clone();
                let outp = output.clone();
                let cancel2 = cancel.clone();
                tokio::task::spawn_blocking(move || run_file(&inp, &outp, &cancel2))
                    .await
                    .map_err(|e| EngineError::Process(e.to_string()))??;
                Ok(EnhanceBatchResult {
                    pages_ok: 1,
                    pages_failed: 0,
                    message: Some("realesrgan-coreml".into()),
                })
            }
            EnhanceBatchRequest::Directory {
                input_dir,
                output_dir,
                ..
            } => {
                tokio::fs::create_dir_all(&output_dir).await?;
                let mut ok = 0u32;
                let mut failed = 0u32;
                let mut entries: Vec<PathBuf> = std::fs::read_dir(&input_dir)
                    .map_err(|e| EngineError::Io(e.to_string()))?
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| p.is_file())
                    .collect();
                entries.sort();
                for path in entries {
                    if cancel.is_cancelled() {
                        return Err(EngineError::Cancelled);
                    }
                    let name = match path.file_name() {
                        Some(n) => n.to_owned(),
                        None => continue,
                    };
                    let dest = output_dir.join(name).with_extension("jpg");
                    let p2 = path.clone();
                    let d2 = dest.clone();
                    let c2 = cancel.clone();
                    match tokio::task::spawn_blocking(move || run_file(&p2, &d2, &c2)).await {
                        Ok(Ok(())) => ok += 1,
                        Ok(Err(e)) => {
                            warn!(error = %e, file = %path.display(), "esrgan page failed");
                            failed += 1;
                        }
                        Err(e) => {
                            warn!(error = %e, "esrgan join failed");
                            failed += 1;
                        }
                    }
                }
                info!(ok, failed, "realesrgan-coreml directory done");
                Ok(EnhanceBatchResult {
                    pages_ok: ok,
                    pages_failed: failed,
                    message: Some("realesrgan-coreml".into()),
                })
            }
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn model_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../third_party/realesrgan-coreml/RealESRGAN_x4plus_anime_6B.mlmodel")
    }

    #[test]
    fn enhance_small_gradient_4x() {
        let model = model_path();
        if !model.is_file() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut img = RgbImage::new(80, 100);
        for y in 0..100 {
            for x in 0..80 {
                img.put_pixel(x, y, Rgb([(40 + x) as u8, (80 + y) as u8, 180]));
            }
        }
        let inp = dir.path().join("in.png");
        let out = dir.path().join("out.jpg");
        image::DynamicImage::ImageRgb8(img).save(&inp).unwrap();
        let engine = RealEsrganCoreMlEngine::new(model);
        engine.load().unwrap();
        run_file(&inp, &out, &CancellationToken::new()).unwrap();
        let got = image::open(&out).unwrap().to_rgb8();
        assert_eq!(got.dimensions(), (320, 400));
        let mut live = 0u32;
        for p in got.pixels() {
            if p.0[1] > 16 && p.0[2] > 16 {
                live += 1;
            }
        }
        assert!(live > 5_000, "output too dark live={live}");
    }

    #[test]
    fn bench_one_tile_if_present() {
        let model = model_path();
        let inp = PathBuf::from("/tmp/w2x_bench_in.jpg");
        if !model.is_file() || !inp.is_file() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let small = dir.path().join("in.png");
        let img = image::open(&inp).unwrap();
        img.resize(512, 512, image::imageops::FilterType::Triangle)
            .to_rgb8()
            .save(&small)
            .unwrap();
        let out = dir.path().join("out.jpg");
        let engine = RealEsrganCoreMlEngine::new(model);
        engine.load().unwrap();
        let t = Instant::now();
        run_file(&small, &out, &CancellationToken::new()).unwrap();
        eprintln!(
            "esrgan one-tile {}x{} -> {:?} {:?}",
            image::image_dimensions(&small).unwrap().0,
            image::image_dimensions(&small).unwrap().1,
            image::image_dimensions(&out).unwrap(),
            t.elapsed()
        );
    }
}
