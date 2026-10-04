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

/// Reader cache leaves this unset and keeps quality 98. Whole-book export passes the manifest value.
fn jpeg_quality_of(params: &crate::EnhanceParams) -> u8 {
    params.jpeg_quality.unwrap_or(98).clamp(1, 100)
}

fn infer_rgb(input: &Path, cancel: &CancellationToken) -> Result<RgbImage, EngineError> {
    if cancel.is_cancelled() {
        return Err(EngineError::Cancelled);
    }
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
    RgbImage::from_raw(ow, oh, out_buf).ok_or_else(|| EngineError::Image("无法组装输出".into()))
}

fn write_output(
    cropped: &RgbImage,
    output: &Path,
    png: bool,
    quality: u8,
    max_side: u32,
) -> Result<(), EngineError> {
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| EngineError::Io(e.to_string()))?;
    }
    let fitted = crate::jpeg_encode::fit_long_side(cropped, max_side);
    if png {
        fitted
            .save_with_format(output, image::ImageFormat::Png)
            .map_err(|e| EngineError::Image(e.to_string()))?;
    } else {
        crate::jpeg_encode::write_comic_jpeg(output, &fitted, quality)?;
    }
    Ok(())
}

fn run_file(
    input: &Path,
    output: &Path,
    png: bool,
    quality: u8,
    max_side: u32,
    cancel: &CancellationToken,
) -> Result<(), EngineError> {
    let t0 = Instant::now();
    let cropped = infer_rgb(input, cancel)?;
    let (w, h) = cropped.dimensions();
    write_output(&cropped, output, png, quality, max_side)?;
    info!(
        w,
        h,
        png,
        ms = t0.elapsed().as_millis() as u64,
        "realcugan-coreml page"
    );
    Ok(())
}

type EncodeJob = std::thread::JoinHandle<Result<(), EngineError>>;

async fn settle_encode(
    slot: &mut Option<EncodeJob>,
    queued: &mut bool,
    ok: &mut u32,
    failed: &mut u32,
    last_err: &mut Option<EngineError>,
) {
    if !*queued {
        return;
    }
    *queued = false;
    let Some(handle) = slot.take() else {
        return;
    };
    let joined = tokio::task::spawn_blocking(move || handle.join()).await;
    let result = match joined {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(EngineError::Process("编码线程异常退出".into())),
        Err(e) => Err(EngineError::Process(e.to_string())),
    };
    match result {
        Ok(()) => *ok += 1,
        Err(e) => {
            warn!(error = %e, "cugan-coreml encode failed");
            *failed += 1;
            if last_err.is_none() {
                *last_err = Some(e);
            }
        }
    }
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
impl UpscaleEngine for RealCuganCoreMlEngine {
    fn id(&self) -> EngineKind {
        EngineKind::RealCuganCoreMl
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
                id: "realcugan-coreml".into(),
                available: true,
                detail: format!("Core ML 就绪 · {}", self.model_path.display()),
                version: Some("realcugan-se-2x".into()),
                threads: None,
                mode: Some("Core ML".into()),
                is_mock: false,
            },
            EngineAvailability::MissingBinary => EngineStatus {
                id: "realcugan-coreml".into(),
                available: false,
                detail: "未找到 Real-CUGAN Core ML 模型，请运行 scripts/fetch-realcugan-coreml.sh"
                    .into(),
                version: None,
                threads: None,
                mode: None,
                is_mock: false,
            },
            EngineAvailability::Unavailable(s) => EngineStatus {
                id: "realcugan-coreml".into(),
                available: false,
                detail: s,
                version: None,
                threads: None,
                mode: None,
                is_mock: false,
            },
            _ => EngineStatus {
                id: "realcugan-coreml".into(),
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

    async fn preheat(&self, noise: i8) -> Result<(), EngineError> {
        let engine = self.clone();
        crate::preheat_coreml(
            &COREML_BATCH_LOCK,
            &COREML_POISONED,
            MODEL_LOAD_TIMEOUT,
            "realcugan-coreml",
            move || engine.load_for_noise(noise),
        )
        .await
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
        let noise = match &req {
            EnhanceBatchRequest::SingleFile { params, .. }
            | EnhanceBatchRequest::Directory { params, .. } => params.noise_level,
        };
        let (png, quality, max_side) = match &req {
            EnhanceBatchRequest::SingleFile { params, .. }
            | EnhanceBatchRequest::Directory { params, .. } => (
                wants_png(params),
                jpeg_quality_of(params),
                params.output_max_side.unwrap_or(0),
            ),
        };
        // 模型加载（首次含同步编译）限时；卡死时置毒标记并交接锁
        {
            let engine = self.clone();
            let mut load_guard = guard.take();
            let mut loader = tokio::task::spawn_blocking(move || {
                let r = engine.load_for_noise(noise);
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
                    warn!("realcugan-coreml model load timed out");
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
                    run_file(&inp, &outp, png, quality, max_side, &cancel2)
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
                        warn!("realcugan-coreml predict timed out");
                        return Err(EngineError::Timeout(PAGE_PREDICT_TIMEOUT));
                    }
                }
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
                // 上一页的编码与下一页的推理重叠。只保留一页的输出缓冲。
                let mut encoding: Option<EncodeJob> = None;
                let mut queued = false;
                for path in entries {
                    if cancel.is_cancelled() {
                        settle_encode(
                            &mut encoding,
                            &mut queued,
                            &mut ok,
                            &mut failed,
                            &mut last_err,
                        )
                        .await;
                        return Err(EngineError::Cancelled);
                    }
                    let name = match path.file_name() {
                        Some(n) => n.to_owned(),
                        None => continue,
                    };
                    let dest = output_dir.join(name).with_extension(out_ext);
                    let p2 = path.clone();
                    let c2 = cancel.clone();
                    let mut handle = tokio::task::spawn_blocking(move || infer_rgb(&p2, &c2));
                    let inferred = match tokio::time::timeout(PAGE_PREDICT_TIMEOUT, &mut handle)
                        .await
                    {
                        Ok(Ok(Ok(img))) => Some(img),
                        Ok(Ok(Err(e))) => {
                            warn!(error = %e, file = %path.display(), "cugan-coreml page failed");
                            failed += 1;
                            if last_err.is_none() {
                                last_err = Some(e);
                            }
                            None
                        }
                        Ok(Err(join)) => {
                            let e = EngineError::Process(join.to_string());
                            warn!(error = %e, "cugan-coreml join failed");
                            failed += 1;
                            if last_err.is_none() {
                                last_err = Some(e);
                            }
                            None
                        }
                        Err(_) => {
                            settle_encode(
                                &mut encoding,
                                &mut queued,
                                &mut ok,
                                &mut failed,
                                &mut last_err,
                            )
                            .await;
                            COREML_POISONED.store(true, Ordering::Relaxed);
                            let g = guard.take();
                            tokio::spawn(async move {
                                let _g = g;
                                let _ = handle.await;
                                COREML_POISONED.store(false, Ordering::Relaxed);
                            });
                            warn!(file = %path.display(), "cugan-coreml predict timed out");
                            return Err(EngineError::Timeout(PAGE_PREDICT_TIMEOUT));
                        }
                    };
                    let Some(img) = inferred else {
                        continue;
                    };
                    // 推理已经结束，这里才等上一页写完，避免两页 2× 缓冲叠在一起
                    settle_encode(
                        &mut encoding,
                        &mut queued,
                        &mut ok,
                        &mut failed,
                        &mut last_err,
                    )
                    .await;
                    encoding = Some(std::thread::spawn(move || {
                        write_output(&img, &dest, png, quality, max_side)
                    }));
                    queued = true;
                }
                settle_encode(
                    &mut encoding,
                    &mut queued,
                    &mut ok,
                    &mut failed,
                    &mut last_err,
                )
                .await;
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
        // 宽 400 会切成两块，覆盖「下一块预测和上一块贴图重叠」
        let mut img = RgbImage::new(400, 280);
        for y in 0..280 {
            for x in 0..400 {
                img.put_pixel(x, y, Rgb([(40 + x / 4) as u8, (80 + y / 3) as u8, 160]));
            }
        }
        let inp = dir.path().join("in.png");
        let out = dir.path().join("out.jpg");
        image::DynamicImage::ImageRgb8(img).save(&inp).unwrap();
        let engine = RealCuganCoreMlEngine::new(model);
        engine.load_for_noise(0).unwrap();
        run_file(&inp, &out, false, 98, 0, &CancellationToken::new()).unwrap();
        let got = image::open(&out).unwrap().to_rgb8();
        assert_eq!(got.dimensions(), (800, 560));
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
        run_file(&inp, &out, false, 98, 0, &CancellationToken::new()).unwrap();
        let got = image::open(&out).unwrap();
        eprintln!("real_page out {}x{}", got.width(), got.height());
    }
}
