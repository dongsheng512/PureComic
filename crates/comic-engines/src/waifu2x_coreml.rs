//! In-process waifu2x via Core ML (macOS). Model stays loaded.

use crate::{
    resolve_waifu2x_coreml_model_for_noise, EngineAvailability, EngineError, EngineKind,
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

/// Batch-job input cap: bigger pages are downscaled before inference so the
/// 2× output buffer stays bounded (4096² → 8192² RGB8 ≈ 201MB).
const ENGINE_INPUT_CAP: u32 = 4096;

/// 串行化「load + 整批推理」：C 侧模型是进程级单例，
/// 并发批次用不同 noise 时后者会把全局模型换掉，导致前批结果错误。
static COREML_BATCH_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

#[cfg(target_os = "macos")]
mod ffi {
    use std::os::raw::{c_char, c_int, c_uchar};
    unsafe extern "C" {
        pub fn comic_w2x_coreml_load(model_path: *const c_char) -> c_int;
        pub fn comic_w2x_coreml_enhance_rgb(
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
pub struct Waifu2xCoreMlEngine {
    pub model_path: PathBuf,
}

impl Waifu2xCoreMlEngine {
    pub fn new(model_path: PathBuf) -> Self {
        Self { model_path }
    }

    fn load_for_noise(&self, noise: i8) -> Result<(), EngineError> {
        let path = resolve_waifu2x_coreml_model_for_noise(noise)
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
            let rc = unsafe { ffi::comic_w2x_coreml_load(c.as_ptr()) };
            if rc != 0 {
                return Err(EngineError::Process(format!(
                    "Core ML 加载失败 ({rc}): {}",
                    path.display()
                )));
            }
            info!(noise, model = %path.display(), "waifu2x-coreml model");
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

/// Output format decided by the request: PNG (lossless intermediate) unless
/// the caller explicitly asked for JPEG (reader cache path).
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
    // 共享取消标志：C 侧逐 tile 轮询读取，取消后由 watcher 置 1
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
        ffi::comic_w2x_coreml_enhance_rgb(
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
        return Err(EngineError::Process(format!("Core ML 推理失败 ({rc})")));
    }
    let ow = if ow > 0 { ow as u32 } else { out_w };
    let oh = if oh > 0 { oh as u32 } else { out_h };
    // C 侧返回的尺寸必须落在预期缓冲内，否则按失败处理而非组装坏图
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
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(BufWriter::new(file), 96);
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
        "waifu2x-coreml page"
    );
    Ok(())
}

#[async_trait]
impl UpscaleEngine for Waifu2xCoreMlEngine {
    fn id(&self) -> EngineKind {
        EngineKind::Waifu2xCoreMl
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
                id: "waifu2x-coreml".into(),
                available: true,
                detail: format!("Core ML 就绪 · {}", self.model_path.display()),
                version: Some("waifu2x-anime-2x".into()),
            },
            EngineAvailability::MissingBinary => EngineStatus {
                id: "waifu2x-coreml".into(),
                available: false,
                detail: "未找到 Core ML 模型，请运行 scripts/fetch-waifu2x-coreml.sh".into(),
                version: None,
            },
            EngineAvailability::Unavailable(s) => EngineStatus {
                id: "waifu2x-coreml".into(),
                available: false,
                detail: s,
                version: None,
            },
            _ => EngineStatus {
                id: "waifu2x-coreml".into(),
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
                    message: Some("waifu2x-coreml".into()),
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
                            warn!(error = %e, file = %path.display(), "coreml page failed");
                            failed += 1;
                        }
                        Err(e) => {
                            warn!(error = %e, "coreml join failed");
                            failed += 1;
                        }
                    }
                }
                info!(ok, failed, png, "waifu2x-coreml directory done");
                Ok(EnhanceBatchResult {
                    pages_ok: ok,
                    pages_failed: failed,
                    message: Some("waifu2x-coreml".into()),
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
            .join("../../third_party/waifu2x-coreml/up_anime_noise0_scale2x_model.mlmodel")
    }

    #[test]
    fn enhance_small_gradient_not_black() {
        let model = model_path();
        if !model.is_file() {
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
        let engine = Waifu2xCoreMlEngine::new(model);
        engine.load_for_noise(2).unwrap();
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

    #[test]
    fn bench_real_page_if_present() {
        let model = model_path();
        let inp = PathBuf::from("/tmp/w2x_bench_in.jpg");
        if !model.is_file() || !inp.is_file() {
            return;
        }
        let out = PathBuf::from("/tmp/w2x_bench_out.jpg");
        let engine = Waifu2xCoreMlEngine::new(model);
        engine.load_for_noise(2).unwrap();
        let t = Instant::now();
        run_file(&inp, &out, false, &CancellationToken::new()).unwrap();
        eprintln!("bench_real_page {:?}", t.elapsed());
        let got = image::open(&out).unwrap();
        eprintln!("bench_out {}x{}", got.width(), got.height());
    }

    /// A/B 支撑：合成 1200×1600 测试页（带渐变底、棋盘、细线、文字块），写 /tmp/w2x_ab_in.png。
    fn ensure_ab_page() -> PathBuf {
        let inp = PathBuf::from("/tmp/w2x_ab_in.png");
        if inp.is_file() {
            return inp;
        }
        let (w, h) = (1200u32, 1600u32);
        let mut img = RgbImage::new(w, h);
        let mut s: u32 = 0x9e3779b9;
        for y in 0..h {
            for x in 0..w {
                s = s.wrapping_mul(1664525).wrapping_add(1013904223);
                let n = (s >> 24) as u8;
                let g = ((x * 97 + y * 61) / 7 % 200) as u8;
                let check = if ((x / 4 + y / 4) & 1) == 0 {
                    24u8
                } else {
                    0u8
                };
                let line = if x % 41 == 0 || y % 47 == 0 {
                    46u8
                } else {
                    0u8
                };
                let text = if (x / 90 + y / 110) % 2 == 0 && (x % 12) < 9 && (y % 16) < 12 {
                    38u8
                } else {
                    0u8
                };
                let r = g
                    .saturating_add(check)
                    .saturating_sub(line)
                    .saturating_sub(text);
                let gg = g.saturating_add(check / 2);
                let b = (n / 4).saturating_add(60);
                img.put_pixel(x, y, Rgb([r, gg, b]));
            }
        }
        image::DynamicImage::ImageRgb8(img).save(&inp).unwrap();
        inp
    }

    /// 仅测 C 侧推理耗时（不含解码/编码）。调用方需先 load。
    fn infer_w2x(rgb: &RgbImage) -> std::time::Duration {
        let (w, h) = rgb.dimensions();
        let out_w = w * SCALE;
        let out_h = h * SCALE;
        let cap = (out_w as usize) * (out_h as usize) * 3;
        let mut buf = vec![0u8; cap];
        let mut ow = 0i32;
        let mut oh = 0i32;
        let t = Instant::now();
        let rc = unsafe {
            ffi::comic_w2x_coreml_enhance_rgb(
                rgb.as_raw().as_ptr(),
                w as i32,
                h as i32,
                buf.as_mut_ptr(),
                cap as i32,
                &mut ow,
                &mut oh,
                std::ptr::null(),
            )
        };
        let d = t.elapsed();
        assert_eq!(rc, 0, "infer failed rc={rc}");
        assert_eq!((ow as u32, oh as u32), (out_w, out_h));
        d
    }

    /// A/B：整页与每 tile 均摊耗时。配置由 .m 读环境变量（COMIC_W2X_FASTPRED /
    /// COMIC_W2X_LOWPREC = 0 关闭），输出工件名由 COMIC_W2X_AB_TAG 决定。
    #[test]
    #[ignore]
    fn ab_timed_page() {
        let model = model_path();
        if !model.is_file() {
            return;
        }
        let tag = std::env::var("COMIC_W2X_AB_TAG").unwrap_or_else(|_| "run".into());
        let inp = ensure_ab_page();
        let out = PathBuf::from(format!("/tmp/w2x_ab_out_{tag}.png"));
        let engine = Waifu2xCoreMlEngine::new(model);
        let t0 = Instant::now();
        engine.load_for_noise(2).unwrap();
        eprintln!("[ab {tag}] load+compile {:?}", t0.elapsed());
        // 先产出一张无损 PNG 工件供 ab_compare_outputs 比对
        run_file(&inp, &out, true, &CancellationToken::new()).unwrap();
        let rgb = image::open(&inp).unwrap().to_rgb8();
        // 1200×1600：num_w=8 num_h=11 + 边条 11+8 + 角 1 = 108 tiles
        const TILES: f64 = 108.0;
        for i in 1..=3 {
            let d = infer_w2x(&rgb);
            eprintln!(
                "[ab {tag}] infer{i} page_ms={} per_tile_ms={:.3}",
                d.as_millis(),
                d.as_secs_f64() * 1000.0 / TILES
            );
        }
    }

    /// 模型级对比支撑（R2-B 数值证据）：加载 COMIC_W2X_MODEL 指定模型
    /// （直调 FFI，绕过路径解析），同一 1200×1600 页出图 + 计时。
    #[test]
    #[ignore]
    fn ab_model_output() {
        let Ok(model) = std::env::var("COMIC_W2X_MODEL") else {
            return;
        };
        if !PathBuf::from(&model).exists() {
            return;
        }
        let tag = std::env::var("COMIC_W2X_AB_TAG").unwrap_or_else(|_| "model".into());
        use std::ffi::CString;
        let c = CString::new(model).unwrap();
        let rc = unsafe { ffi::comic_w2x_coreml_load(c.as_ptr()) };
        assert_eq!(rc, 0, "ffi load failed rc={rc}");
        let inp = ensure_ab_page();
        let out = PathBuf::from(format!("/tmp/w2x_ab_out_{tag}.png"));
        run_file(&inp, &out, true, &CancellationToken::new()).unwrap();
        let rgb = image::open(&inp).unwrap().to_rgb8();
        const TILES: f64 = 108.0;
        for i in 1..=2 {
            let d = infer_w2x(&rgb);
            eprintln!(
                "[model {tag}] infer{i} page_ms={} per_tile_ms={:.3}",
                d.as_millis(),
                d.as_secs_f64() * 1000.0 / TILES
            );
        }
    }

    /// A/B：基线 /tmp/w2x_ab_out_base.png 与 COMIC_W2X_AB_CMP 指定配置工件的
    /// PSNR / 逐像素最大差 / 有差异像素占比。
    #[test]
    #[ignore]
    fn ab_compare_outputs() {
        let other = std::env::var("COMIC_W2X_AB_CMP").unwrap_or_else(|_| "full".into());
        let base_tag = std::env::var("COMIC_W2X_AB_BASE").unwrap_or_else(|_| "base".into());
        let base = PathBuf::from(format!("/tmp/w2x_ab_out_{base_tag}.png"));
        let cand = PathBuf::from(format!("/tmp/w2x_ab_out_{other}.png"));
        if !base.is_file() || !cand.is_file() {
            return;
        }
        let a = image::open(&base).unwrap().to_rgb8();
        let b = image::open(&cand).unwrap().to_rgb8();
        assert_eq!(a.dimensions(), b.dimensions());
        let n = (a.width() as u64) * (a.height() as u64) * 3;
        let mut mse = 0f64;
        let mut maxd = 0u32;
        let mut ndiff = 0u64;
        for (pa, pb) in a.pixels().zip(b.pixels()) {
            for k in 0..3 {
                let d = ((pa.0[k] as i64) - (pb.0[k] as i64)).unsigned_abs() as u32;
                if d > 0 {
                    ndiff += 1;
                }
                if d > maxd {
                    maxd = d;
                }
                mse += (d as f64) * (d as f64);
            }
        }
        let psnr = if mse == 0.0 {
            f64::INFINITY
        } else {
            10.0 * (255.0 * 255.0 / (mse / n as f64)).log10()
        };
        eprintln!(
            "[ab cmp base vs {other}] psnr={psnr:.2} dB max_diff={maxd} diff_frac={:.6}",
            ndiff as f64 / n as f64
        );
    }
}
