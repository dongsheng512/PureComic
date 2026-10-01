//! In-process Real-ESRGAN Anime 4× via Core ML (macOS).

use crate::{
    EngineAvailability, EngineError, EngineKind, EngineStatus, EnhanceBatchRequest,
    EnhanceBatchResult, GpuInfo, UpscaleEngine,
};
use async_trait::async_trait;
use image::RgbImage;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Instant;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

const SCALE: u32 = 4;

/// Batch-job input cap: bigger pages are downscaled before inference so the
/// 4× output buffer stays bounded (2560² → 10240² RGB8 ≈ 315MB).
const ENGINE_INPUT_CAP: u32 = 2560;

/// 串行化「load + 整批推理」：C 侧模型是进程级单例，
/// 并发批次会把全局模型换掉，导致另一批结果错误。
static COREML_BATCH_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

/// 单页推理超时；超时后批锁移交后台等待，后续批次快速失败直到线程退出
const PAGE_PREDICT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
/// 模型加载（首次含同步编译）超时
const MODEL_LOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// 推理/加载线程卡死标志：置位期间新批次立即报错（而不是排队等死锁），
/// 卡死线程退出后由后台任务自动清除。
static COREML_POISONED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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
            Err(EngineError::Process("仅 macOS 支持 Core ML".into()))
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

/// Output format decided by the request: PNG (lossless intermediate) unless
/// the caller explicitly asked for JPEG (reader cache path).
fn wants_png(params: &crate::EnhanceParams) -> bool {
    !matches!(params.output_format.as_deref(), Some("jpg") | Some("jpeg"))
}

fn run_file(
    input: &Path,
    output: &Path,
    png: bool,
    max_side: u32,
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
        ffi::comic_esrgan_coreml_enhance_rgb(
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
            "Real-ESRGAN Core ML 推理失败 ({rc})"
        )));
    }
    let ow = if ow > 0 { ow as u32 } else { out_w };
    let oh = if oh > 0 { oh as u32 } else { out_h };
    // C 侧返回的尺寸必须落在预期缓冲内，否则按失败处理而非组装坏图
    if ow > out_w || oh > out_h || (ow as u64).saturating_mul(oh as u64) * 3 > cap as u64 {
        return Err(EngineError::Image(format!(
            "Core ML 返回异常输出尺寸 {ow}x{oh}（预期 ≤ {out_w}x{out_h}）"
        )));
    }
    out_buf.truncate(ow as usize * oh as usize * 3);
    let cropped = RgbImage::from_raw(ow, oh, out_buf)
        .ok_or_else(|| EngineError::Image("无法组装输出".into()))?;

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| EngineError::Io(e.to_string()))?;
    }
    let fitted = crate::jpeg_encode::fit_long_side(&cropped, max_side);
    if png {
        fitted
            .save_with_format(output, image::ImageFormat::Png)
            .map_err(|e| EngineError::Image(e.to_string()))?;
    } else {
        crate::jpeg_encode::write_comic_jpeg(output, &fitted, 94)?;
    }
    info!(
        w = src_w,
        h = src_h,
        out_w = ow,
        out_h = oh,
        png,
        ms = t0.elapsed().as_millis() as u64,
        "realesrgan-coreml page"
    );
    Ok(())
}

fn model_availability(path: &Path) -> EngineAvailability {
    if !(path.is_file() || path.is_dir()) {
        return EngineAvailability::MissingBinary;
    }
    match crate::paths::verify_optional_model_pin(path) {
        Ok(()) => EngineAvailability::Ready,
        Err(msg) => EngineAvailability::Unavailable(msg),
    }
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
        model_availability(&self.model_path)
    }

    fn status(&self) -> EngineStatus {
        match self.is_available() {
            EngineAvailability::Ready => EngineStatus {
                id: "realesrgan-coreml".into(),
                available: true,
                detail: format!("Core ML 就绪 · {}", self.model_path.display()),
                version: Some("anime-6B-4x".into()),
                threads: None,
                mode: Some("Core ML".into()),
                is_mock: false,
            },
            EngineAvailability::MissingBinary => EngineStatus {
                id: "realesrgan-coreml".into(),
                available: false,
                detail:
                    "未找到 Real-ESRGAN Core ML 模型，请运行 scripts/fetch-realesrgan-coreml.sh"
                        .into(),
                version: None,
                threads: None,
                mode: None,
                is_mock: false,
            },
            EngineAvailability::Unavailable(s) => EngineStatus {
                id: "realesrgan-coreml".into(),
                available: false,
                detail: s,
                version: None,
                threads: None,
                mode: None,
                is_mock: false,
            },
            _ => EngineStatus {
                id: "realesrgan-coreml".into(),
                available: false,
                detail: "不可用".into(),
                version: None,
                threads: None,
                mode: None,
                is_mock: false,
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
        use std::sync::atomic::Ordering;
        // 先查取消：毒化期间用户取消任务应归类 Cancelled 而非卡死错误
        if cancel.is_cancelled() {
            return Err(EngineError::Cancelled);
        }
        if COREML_POISONED.load(Ordering::Relaxed) {
            return Err(EngineError::Process(
                "Core ML 推理此前超时未返回，引擎可能卡死；请重启应用后再试".into(),
            ));
        }
        // Option 包裹：推理/加载超时后把锁移交给后台任务，等卡死线程退出再释放
        let mut guard = Some(tokio::select! {
            g = COREML_BATCH_LOCK.lock() => g,
            _ = cancel.cancelled() => return Err(EngineError::Cancelled),
        });
        let (png, max_side) = match &req {
            EnhanceBatchRequest::SingleFile { params, .. }
            | EnhanceBatchRequest::Directory { params, .. } => {
                (wants_png(params), params.output_max_side.unwrap_or(0))
            }
        };
        // 模型加载（首次含同步编译）限时；卡死时置毒标记并交接锁
        {
            let engine = self.clone();
            let mut load_guard = guard.take();
            let mut loader = tokio::task::spawn_blocking(move || {
                let r = engine.load();
                (r, load_guard.take())
            });
            match tokio::time::timeout(MODEL_LOAD_TIMEOUT, &mut loader).await {
                Ok(Ok((r, g))) => {
                    guard = g;
                    r?;
                }
                Ok(Err(join)) => return Err(EngineError::Process(join.to_string())),
                Err(_) => {
                    COREML_POISONED.store(true, Ordering::Relaxed);
                    tokio::spawn(async move {
                        let _ = loader.await;
                        COREML_POISONED.store(false, Ordering::Relaxed);
                    });
                    warn!("realesrgan-coreml model load timed out");
                    return Err(EngineError::Timeout(MODEL_LOAD_TIMEOUT));
                }
            }
        }
        match req {
            EnhanceBatchRequest::SingleFile { input, output, .. } => {
                let inp = input.clone();
                let outp = output.clone();
                let cancel2 = cancel.clone();
                let mut handle = tokio::task::spawn_blocking(move || {
                    run_file(&inp, &outp, png, max_side, &cancel2)
                });
                match tokio::time::timeout(PAGE_PREDICT_TIMEOUT, &mut handle).await {
                    Ok(r) => {
                        r.map_err(|e| EngineError::Process(e.to_string()))??;
                    }
                    Err(_) => {
                        COREML_POISONED.store(true, Ordering::Relaxed);
                        let g = guard.take();
                        tokio::spawn(async move {
                            let _g = g;
                            let _ = handle.await;
                            COREML_POISONED.store(false, Ordering::Relaxed);
                        });
                        warn!("realesrgan-coreml predict timed out");
                        return Err(EngineError::Timeout(PAGE_PREDICT_TIMEOUT));
                    }
                }
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
                    let mut handle =
                        tokio::task::spawn_blocking(move || run_file(&p2, &d2, png, max_side, &c2));
                    match tokio::time::timeout(PAGE_PREDICT_TIMEOUT, &mut handle).await {
                        Ok(Ok(Ok(()))) => ok += 1,
                        Ok(Ok(Err(e))) => {
                            warn!(error = %e, file = %path.display(), "esrgan page failed");
                            failed += 1;
                            if last_err.is_none() {
                                last_err = Some(e);
                            }
                        }
                        Ok(Err(join)) => {
                            let e = EngineError::Process(join.to_string());
                            warn!(error = %e, "esrgan join failed");
                            failed += 1;
                            if last_err.is_none() {
                                last_err = Some(e);
                            }
                        }
                        Err(_) => {
                            // 页级超时：置毒 + 锁交接，整批中止
                            COREML_POISONED.store(true, Ordering::Relaxed);
                            let g = guard.take();
                            tokio::spawn(async move {
                                let _g = g;
                                let _ = handle.await;
                                COREML_POISONED.store(false, Ordering::Relaxed);
                            });
                            warn!(file = %path.display(), "esrgan predict timed out");
                            return Err(EngineError::Timeout(PAGE_PREDICT_TIMEOUT));
                        }
                    }
                }
                info!(ok, failed, png, "realesrgan-coreml directory done");
                if ok == 0 {
                    return Err(last_err.unwrap_or_else(|| {
                        EngineError::Process("realesrgan-coreml 未写出任何页".into())
                    }));
                }
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
        run_file(&inp, &out, false, 0, &CancellationToken::new()).unwrap();
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
        run_file(&small, &out, false, 0, &CancellationToken::new()).unwrap();
        eprintln!(
            "esrgan one-tile {}x{} -> {:?} {:?}",
            image::image_dimensions(&small).unwrap().0,
            image::image_dimensions(&small).unwrap().1,
            image::image_dimensions(&out).unwrap(),
            t.elapsed()
        );
    }

    /// 接缝探针：600×600 高纹理页 → 2400×2400。tile 原点 0 与 88（输入空间），
    /// 旧实现（pad 8 不裁边）接缝在输出 x=352（后写 tile 的低上下文带）；
    /// 新实现（pad 10 裁 40px）在 352/392/2048 处都不应出现列差分尖峰。
    #[test]
    #[ignore]
    fn seam_probe_600() {
        let model = model_path();
        if !model.is_file() {
            return;
        }
        let tag = std::env::var("COMIC_ESR_PROBE_TAG").unwrap_or_else(|_| "run".into());
        let dir = tempfile::tempdir().unwrap();
        let inp = dir.path().join("in.png");
        let mut img = RgbImage::new(600, 600);
        let mut s: u32 = 0x243f6a88;
        for y in 0..600u32 {
            for x in 0..600u32 {
                s = s.wrapping_mul(1664525).wrapping_add(1013904223);
                let g = ((x * 3 + y * 5) % 173) as u8;
                let check = if ((x / 3 + y / 3) & 1) == 0 {
                    22u8
                } else {
                    0u8
                };
                let line = if x % 29 == 0 || y % 31 == 0 {
                    40u8
                } else {
                    0u8
                };
                let r = g.saturating_add(check).saturating_sub(line);
                let b = (255u32 - g as u32).min(255) as u8;
                img.put_pixel(x, y, Rgb([r, g, b.saturating_add(check / 2)]));
            }
        }
        image::DynamicImage::ImageRgb8(img).save(&inp).unwrap();
        let out = dir.path().join("out.png");
        let engine = RealEsrganCoreMlEngine::new(model);
        engine.load().unwrap();
        run_file(&inp, &out, true, 0, &CancellationToken::new()).unwrap();
        let got = image::open(&out).unwrap().to_rgb8();
        assert_eq!(got.dimensions(), (2400, 2400));
        let (w, h) = got.dimensions();
        let mut col: Vec<f64> = vec![0.0; w as usize];
        for x in 1..w {
            let mut acc = 0u64;
            for y in 0..h {
                let p0 = got.get_pixel(x - 1, y);
                let p1 = got.get_pixel(x, y);
                for k in 0..3 {
                    acc += ((p0.0[k] as i64) - (p1.0[k] as i64)).unsigned_abs();
                }
            }
            col[x as usize] = acc as f64 / (h as f64 * 3.0);
        }
        let mut row: Vec<f64> = vec![0.0; h as usize];
        for y in 1..h {
            let mut acc = 0u64;
            for x in 0..w {
                let p0 = got.get_pixel(x, y - 1);
                let p1 = got.get_pixel(x, y);
                for k in 0..3 {
                    acc += ((p0.0[k] as i64) - (p1.0[k] as i64)).unsigned_abs();
                }
            }
            row[y as usize] = acc as f64 / (w as f64 * 3.0);
        }
        let median = |v: &[f64]| -> f64 {
            let mut c: Vec<f64> = v.iter().copied().filter(|x| *x > 0.0).collect();
            c.sort_by(|a, b| a.partial_cmp(b).unwrap());
            if c.is_empty() {
                0.0
            } else {
                c[c.len() / 2]
            }
        };
        let mc = median(&col);
        let mr = median(&row);
        for (x, label) in [
            (352usize, "old_seam(352)"),
            (392, "pad10_boundary(392)"),
            (400, "pad12_boundary(400)"),
            (2048, "old_tile0_edge(2048)"),
            (2008, "new_crop_edge(2008)"),
        ] {
            eprintln!(
                "[esr probe {tag}] col[{x}]={:.3} median={mc:.3} ratio={:.3} ({label})",
                col[x],
                col[x] / mc.max(1e-6)
            );
        }
        for (y, label) in [
            (352usize, "old_seam_row(352)"),
            (392, "pad10_boundary_row(392)"),
            (400, "pad12_boundary_row(400)"),
        ] {
            eprintln!(
                "[esr probe {tag}] row[{y}]={:.3} median={mr:.3} ratio={:.3} ({label})",
                row[y],
                row[y] / mr.max(1e-6)
            );
        }
        eprintln!(
            "[esr probe {tag}] col_median={mc:.3} row_median={mr:.3} dims={}x{}",
            w, h
        );
        got.save(PathBuf::from(format!("/tmp/esr_probe_out_{tag}.png")))
            .ok();
    }
}
