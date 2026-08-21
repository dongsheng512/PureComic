//! In-process Real-CUGAN SE 2× via Core ML (macOS). Model stays loaded.

use crate::{
    resolve_realcugan_coreml_model_for_noise, EngineAvailability, EngineError, EngineKind,
    EngineStatus, EnhanceBatchRequest, EnhanceBatchResult, GpuInfo, UpscaleEngine,
};
use async_trait::async_trait;
use image::RgbImage;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

const SCALE: u32 = 2;
const ENGINE_INPUT_CAP: u32 = 4096;

static COREML_BATCH_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

#[cfg(target_os = "macos")]
mod ffi {
    use std::os::raw::{c_char, c_int, c_uchar};
    unsafe extern "C" {
        pub fn comic_cugan_coreml_load(model_path: *const c_char) -> c_int;
        pub fn comic_cugan_coreml_enhance_rgb(
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
pub struct RealCuganCoreMlEngine {
    pub model_path: PathBuf,
}

impl RealCuganCoreMlEngine {
    pub fn new(model_path: PathBuf) -> Self {
        Self { model_path }
    }

    fn load_for_noise(&self, noise: i8) -> Result<(), EngineError> {
        let path = resolve_realcugan_coreml_model_for_noise(noise)
            .unwrap_or_else(|| self.model_path.clone());
        #[cfg(not(target_os = "macos"))]
        {
            let _ = &path;
            Err(EngineError::Process("仅 macOS 支持 Core ML".into()))
        }
        #[cfg(target_os = "macos")]
        {
            use std::ffi::CString;
            let c = CString::new(path.to_string_lossy().as_bytes())
                .map_err(|e| EngineError::Process(e.to_string()))?;
            let rc = unsafe { ffi::comic_cugan_coreml_load(c.as_ptr()) };
            if rc != 0 {
                return Err(EngineError::Process(format!(
                    "Real-CUGAN Core ML 加载失败 ({rc}): {}",
                    path.display()
                )));
            }
            info!(noise, model = %path.display(), "realcugan-coreml model");
            Ok(())
        }
    }
}

fn open_rgb(input: &Path) -> Result<RgbImage, EngineError> {
    // 先只读头部校验尺寸：超限直接拒绝，避免解码瞬间展开 GB 级像素缓冲
    let (w, h) = image::ImageReader::open(input)
        .map_err(|e| EngineError::Image(e.to_string()))?
        .with_guessed_format()
        .map_err(|e| EngineError::Image(e.to_string()))?
        .into_dimensions()
        .map_err(|e| EngineError::Image(e.to_string()))?;
    crate::check_hard_dimensions(w, h)?;
    let dynimg = image::ImageReader::open(input)
        .map_err(|e| EngineError::Image(e.to_string()))?
        .with_guessed_format()
        .map_err(|e| EngineError::Image(e.to_string()))?
        .decode()
        .map_err(|e| EngineError::Image(e.to_string()))?;
    let dynimg = if dynimg.width().max(dynimg.height()) > ENGINE_INPUT_CAP {
        dynimg.resize(
            ENGINE_INPUT_CAP,
            ENGINE_INPUT_CAP,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        dynimg
    };
    Ok(dynimg.to_rgb8())
}

fn wants_png(params: &crate::EnhanceParams) -> bool {
    !matches!(params.output_format.as_deref(), Some("jpg") | Some("jpeg"))
}

fn run_file(
    input: &Path,
    output: &Path,
    png: bool,
    cancel: &CancellationToken,
) -> Result<(), EngineError> {
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
    let cap_i32 = i32::try_from(cap).map_err(|_| EngineError::Image("输出尺寸过大".into()))?;
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut out_buf = vec![0u8; cap];
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut ow = 0i32;
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut oh = 0i32;
    let cancel_flag = Arc::new(AtomicI32::new(0));
    if cancel.is_cancelled() {
        cancel_flag.store(1, Ordering::Release);
    }
    let flag = cancel_flag.clone();
    let token = cancel.clone();
    let watcher = match tokio::runtime::Handle::try_current() {
        Ok(_) => Some(tokio::spawn(async move {
            token.cancelled().await;
            flag.store(1, Ordering::Release);
        })),
        Err(_) => None,
    };

    #[cfg(target_os = "macos")]
    let rc = unsafe {
        ffi::comic_cugan_coreml_enhance_rgb(
            rgb.as_raw().as_ptr(),
            src_w as i32,
            src_h as i32,
            out_buf.as_mut_ptr(),
            cap_i32,
            &mut ow,
            &mut oh,
            cancel_flag.as_ptr() as *const std::os::raw::c_int,
        )
    };
    #[cfg(not(target_os = "macos"))]
    let rc = {
        let _ = (&out_buf, &ow, &oh, &cancel_flag, &rgb, cap_i32);
        -1
    };
    if let Some(w) = watcher {
        w.abort();
    }

    if cancel.is_cancelled() || rc == -9 {
        return Err(EngineError::Cancelled);
    }
    if rc != 0 {
        return Err(EngineError::Process(format!(
            "Real-CUGAN Core ML 推理失败 ({rc})"
        )));
    }
    let ow = if ow > 0 { ow as u32 } else { out_w };
    let oh = if oh > 0 { oh as u32 } else { out_h };
    if ow > out_w || oh > out_h || (ow as u64).saturating_mul(oh as u64) * 3 > cap as u64 {
        return Err(EngineError::Image(format!(
            "Core ML 返回异常输出尺寸 {ow}x{oh}（预期 ≤ {out_w}x{out_h}）"
        )));
    }
    let expect = ow as usize * oh as usize * 3;
    out_buf.truncate(expect);
    let cropped = RgbImage::from_raw(ow, oh, out_buf)
        .ok_or_else(|| EngineError::Image("无法组装输出".into()))?;

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| EngineError::Io(e.to_string()))?;
    }
    if png {
        cropped
            .save_with_format(output, image::ImageFormat::Png)
            .map_err(|e| EngineError::Image(e.to_string()))?;
    } else {
        use std::io::BufWriter;
        let file = std::fs::File::create(output).map_err(|e| EngineError::Io(e.to_string()))?;
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(BufWriter::new(file), 98);
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
        png,
        ms = t0.elapsed().as_millis() as u64,
        "realcugan-coreml page"
    );
    Ok(())
}

#[async_trait]
impl UpscaleEngine for RealCuganCoreMlEngine {
    fn id(&self) -> EngineKind {
        EngineKind::RealCuganCoreMl
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
                id: "realcugan-coreml".into(),
                available: true,
                detail: format!("Core ML 就绪 · {}", self.model_path.display()),
                version: Some("realcugan-se-2x".into()),
            },
            EngineAvailability::MissingBinary => EngineStatus {
                id: "realcugan-coreml".into(),
                available: false,
                detail: "未找到 Real-CUGAN Core ML 模型，请运行 scripts/fetch-realcugan-coreml.sh"
                    .into(),
                version: None,
            },
            EngineAvailability::Unavailable(s) => EngineStatus {
                id: "realcugan-coreml".into(),
                available: false,
                detail: s,
                version: None,
            },
            _ => EngineStatus {
                id: "realcugan-coreml".into(),
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
        let _guard = tokio::select! {
            g = COREML_BATCH_LOCK.lock() => g,
            _ = cancel.cancelled() => return Err(EngineError::Cancelled),
        };
        let noise = match &req {
            EnhanceBatchRequest::SingleFile { params, .. }
            | EnhanceBatchRequest::Directory { params, .. } => params.noise_level,
        };
        let png = match &req {
            EnhanceBatchRequest::SingleFile { params, .. }
            | EnhanceBatchRequest::Directory { params, .. } => wants_png(params),
        };
        self.load_for_noise(noise)?;
        match req {
            EnhanceBatchRequest::SingleFile { input, output, .. } => {
                let inp = input.clone();
                let outp = output.clone();
                let cancel2 = cancel.clone();
                tokio::task::spawn_blocking(move || run_file(&inp, &outp, png, &cancel2))
                    .await
                    .map_err(|e| EngineError::Process(e.to_string()))??;
                Ok(EnhanceBatchResult {
                    pages_ok: 1,
                    pages_failed: 0,
                    message: Some("realcugan-coreml".into()),
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
                let mut last_err: Option<EngineError> = None;
                let mut entries: Vec<PathBuf> = std::fs::read_dir(&input_dir)
                    .map_err(|e| EngineError::Io(e.to_string()))?
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| p.is_file())
                    .collect();
                entries.sort();
                let out_ext = if png { "png" } else { "jpg" };
                for path in entries {
                    if cancel.is_cancelled() {
                        return Err(EngineError::Cancelled);
                    }
                    let name = match path.file_name() {
                        Some(n) => n.to_owned(),
                        None => continue,
                    };
                    let dest = output_dir.join(name).with_extension(out_ext);
                    let p2 = path.clone();
                    let d2 = dest.clone();
                    let c2 = cancel.clone();
                    match tokio::task::spawn_blocking(move || run_file(&p2, &d2, png, &c2)).await {
                        Ok(Ok(())) => ok += 1,
                        Ok(Err(e)) => {
                            warn!(error = %e, file = %path.display(), "cugan-coreml page failed");
                            failed += 1;
                            if last_err.is_none() {
                                last_err = Some(e);
                            }
                        }
                        Err(e) => {
                            warn!(error = %e, "cugan-coreml join failed");
                            failed += 1;
                            if last_err.is_none() {
                                last_err = Some(EngineError::Process(e.to_string()));
                            }
                        }
                    }
                }
                info!(ok, failed, png, "realcugan-coreml directory done");
                if ok == 0 {
                    return Err(last_err.unwrap_or_else(|| {
                        EngineError::Process("realcugan-coreml 未写出任何页".into())
                    }));
                }
                Ok(EnhanceBatchResult {
                    pages_ok: ok,
                    pages_failed: failed,
                    message: Some("realcugan-coreml".into()),
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
            .join("../../third_party/realcugan-coreml/up2x_conservative.mlpackage")
    }

    #[test]
    fn enhance_small_gradient_not_black() {
        let model = model_path();
        if !model.exists() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut img = RgbImage::new(200, 280);
        for y in 0..280 {
            for x in 0..200 {
                img.put_pixel(x, y, Rgb([(40 + x / 2) as u8, (80 + y / 3) as u8, 160]));
            }
        }
        let inp = dir.path().join("in.png");
        let out = dir.path().join("out.jpg");
        image::DynamicImage::ImageRgb8(img).save(&inp).unwrap();
        let engine = RealCuganCoreMlEngine::new(model);
        engine.load_for_noise(0).unwrap();
        run_file(&inp, &out, false, &CancellationToken::new()).unwrap();
        let got = image::open(&out).unwrap().to_rgb8();
        assert_eq!(got.dimensions(), (400, 560));
        let mut live = 0u32;
        for p in got.pixels() {
            if p.0[1] > 20 && p.0[2] > 20 {
                live += 1;
            }
        }
        assert!(live > 10_000, "output too dark live={live}");
    }

    /// 可选真实页推理冒烟：设置 COMIC_TEST_PAGE 指向本机任一图片后启用。
    #[test]
    fn enhance_real_page_if_present() {
        let Ok(page) = std::env::var("COMIC_TEST_PAGE") else {
            return;
        };
        let inp = PathBuf::from(page);
        if !inp.is_file() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out.jpg");
        let engine = RealCuganCoreMlEngine::new(model_path());
        engine.load_for_noise(0).unwrap();
        run_file(&inp, &out, false, &CancellationToken::new()).unwrap();
        let got = image::open(&out).unwrap();
        eprintln!("real_page out {}x{}", got.width(), got.height());
    }
}
