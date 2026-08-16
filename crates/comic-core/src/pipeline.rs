//! End-to-end job stages: validate → extract → enhance → export.
//!
//! Locking rule: never hold `manifest` write lock across long blocking work.

use crate::archive::{self, export_job_with_progress, extract_to_workdir};
use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
use crate::estimate::assert_disk_ok;
use crate::job::{JobManifest, JobState, PageRecord, PageStatus, ProgressEvent};
use chrono::Utc;
use comic_engines::{EnhanceBatchRequest, UpscaleEngine};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use tracing::{error, info, warn};
use uuid::Uuid;

pub type ProgressCallback = Arc<dyn Fn(ProgressEvent) + Send + Sync>;

pub type GpuLock = Arc<Mutex<()>>;

pub fn new_gpu_lock() -> GpuLock {
    Arc::new(Mutex::new(()))
}

/// Extract progress tick (stats only — cheap to send often).
#[derive(Clone, Debug)]
struct ExtractTick {
    pages_done: u32,
    pages_total: u32,
    current: Option<String>,
}

pub async fn run_job(
    manifest: Arc<RwLock<JobManifest>>,
    engine: Arc<dyn UpscaleEngine>,
    cfg: AppConfig,
    gpu: GpuLock,
    cancel: CancellationToken,
    on_progress: Option<ProgressCallback>,
) -> AppResult<()> {
    let emit_cb = on_progress.clone();
    let emit = move |m: &JobManifest, stage: &str, cur: Option<String>| {
        if let Some(cb) = &emit_cb {
            cb(ProgressEvent::from_manifest(m, stage, cur));
        }
    };

    // --- Validate ---
    {
        let mut m = manifest.write().await;
        m.state = JobState::Validating;
        m.stats.started_at = Some(Utc::now());
        m.save()?;
        emit(&m, "validate", None);
    }

    if cancel.is_cancelled() {
        return mark_cancelled(&manifest).await;
    }

    {
        let m = manifest.read().await;
        let scale = m.options.scale as u8;
        let source = m.source.path.clone();
        drop(m);
        assert_disk_ok(&source, scale, &cfg)?;
        if cancel.is_cancelled() {
            return mark_cancelled(&manifest).await;
        }
        archive::validate_source(&source, &cfg)?;
    }

    if cancel.is_cancelled() {
        return mark_cancelled(&manifest).await;
    }

    // --- Extract (skip if this is a resume and pages are already on disk) ---
    let extract_done = {
        let mut m = manifest.write().await;
        if m.pages.is_empty() {
            recover_pages_from_indir(&mut m);
        }
        let ready = !m.pages.is_empty()
            && m.pages
                .iter()
                .all(|p| p.in_path.as_ref().map(|x| x.is_file()).unwrap_or(false));
        if ready {
            for page in &mut m.pages {
                if page.out_path.as_ref().map(|p| p.is_file()).unwrap_or(false) {
                    page.status = PageStatus::Done;
                }
            }
            m.refresh_stats();
            let next = (m.stats.pages_done + 1).min(m.stats.pages_total.max(1));
            m.last_message = Some(format!(
                "从第 {next} 页继续（已完成 {}/{}）",
                m.stats.pages_done, m.stats.pages_total
            ));
            m.state = JobState::Extracting;
            m.save()?;
            emit(&m, "extract", None);
        }
        ready
    };

    if !extract_done {
        {
            let mut m = manifest.write().await;
            m.state = JobState::Extracting;
            m.stats.pages_done = 0;
            m.stats.pages_total = 0;
            m.save()?;
            emit(&m, "extract", None);
        }

        let mut working = {
            let m = manifest.read().await;
            m.clone()
        };

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ExtractTick>();
        let cfg_extract = cfg.clone();

        // 解压是 spawn_blocking 同步代码，用 AtomicBool 传播取消（token 不可跨 await 等待）
        let extract_cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = extract_cancel.clone();
        let token_extract = cancel.clone();
        let cancel_watcher = tokio::spawn(async move {
            token_extract.cancelled().await;
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
        });

        let extract_cancel_worker = extract_cancel.clone();
        let extract_handle = tokio::task::spawn_blocking(move || {
            let tx_progress = tx.clone();
            let mut progress_cb = move |done: u32, total: u32, name: Option<&str>| {
                let _ = tx_progress.send(ExtractTick {
                    pages_done: done,
                    pages_total: total,
                    current: name.map(|s| s.to_string()),
                });
            };
            extract_to_workdir(
                &mut working,
                &cfg_extract,
                Some(&mut progress_cb as &mut archive::ExtractProgressCb<'_>),
                Some(&extract_cancel_worker),
            )?;
            working.refresh_stats();
            let total = working.pages.len() as u32;
            let _ = tx.send(ExtractTick {
                pages_done: total,
                pages_total: total,
                current: None,
            });
            Ok::<_, AppError>(working)
        });

        // 进度 tick 只更新内存 stats；落盘节流到 500ms，避免每页全量序列化数 MB JSON
        let mut last_save = std::time::Instant::now();
        while let Some(tick) = rx.recv().await {
            if cancel.is_cancelled() {
                break;
            }
            let mut m = manifest.write().await;
            m.stats.pages_done = tick.pages_done;
            m.stats.pages_total = tick.pages_total;
            if last_save.elapsed() >= std::time::Duration::from_millis(500) {
                let _ = m.save();
                last_save = std::time::Instant::now();
            }
            emit(&m, "extract", tick.current);
        }

        // 取消必须先置位 AtomicBool 再 abort watcher：否则 abort 可能抢在
        // store(true) 之前，解压循环看不到取消并继续写盘。
        // 再 join blocking 任务，避免 remove_job 删掉工作目录时解压还在写。
        if cancel.is_cancelled() {
            extract_cancel.store(true, std::sync::atomic::Ordering::SeqCst);
            cancel_watcher.abort();
            let _ = extract_handle.await;
            return mark_cancelled(&manifest).await;
        }
        cancel_watcher.abort();

        let extract_result = extract_handle
            .await
            .map_err(|e| AppError::internal(format!("extract join: {e}")))?;

        if cancel.is_cancelled() {
            return mark_cancelled(&manifest).await;
        }

        let working = extract_result?;
        {
            let mut m = manifest.write().await;
            m.pages = working.pages;
            m.metadata = working.metadata;
            m.refresh_stats();
            m.save()?;
            info!(pages = m.pages.len(), "extracted");
            emit(&m, "extract", None);
        }
    }

    if cancel.is_cancelled() {
        return mark_cancelled(&manifest).await;
    }

    // --- Enhance (directory batch by default — much faster than per-page process spawn) ---
    {
        let mut m = manifest.write().await;
        if m.pages.is_empty() {
            recover_pages_from_indir(&mut m);
        }
        m.state = JobState::Running;
        m.refresh_stats();
        m.save()?;
        emit(&m, "enhance", None);
    }

    // GPU 锁不再整本持有：enhance_directory_batch 按组持锁，组间让出给阅读器增强
    if cancel.is_cancelled() {
        return mark_cancelled(&manifest).await;
    }

    let page_count = {
        let m = manifest.read().await;
        m.pages.len()
    };
    if page_count == 0 {
        let mut m = manifest.write().await;
        m.state = JobState::Failed;
        m.error = Some(AppError::internal("解压后没有可增强的页"));
        m.stats.finished_at = Some(Utc::now());
        m.save()?;
        return Err(AppError::internal("解压后没有可增强的页"));
    }

    let mut params = {
        let m = manifest.read().await;
        m.options.to_engine_params()
    };
    params.jobs = Some(cfg.resolved_waifu2x_jobs());
    params.output_format = {
        let m = manifest.read().await;
        match m.output.image_format {
            crate::job::ImageFormat::Jpeg => Some("jpg".into()),
            crate::job::ImageFormat::Png => Some("png".into()),
            crate::job::ImageFormat::Webp => Some("webp".into()),
            // Same: 按源页主流扩展名推断，避免 sidecar 默认 PNG 输出引入二次转码
            crate::job::ImageFormat::Same => m
                .pages
                .first()
                .and_then(|p| Path::new(&p.name).extension())
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .filter(|e| matches!(e.as_str(), "jpg" | "jpeg" | "png" | "webp"))
                .map(|e| if e == "jpeg" { "jpg".to_string() } else { e }),
        }
    };
    // CoreML 引擎输出无损中间 PNG，导出阶段统一按 output_format / quality 重编码
    if matches!(
        params.engine,
        comic_engines::EngineKind::Waifu2xCoreMl | comic_engines::EngineKind::RealEsrganCoreMl
    ) {
        params.output_format = Some("png".into());
    }

    {
        let mut m = manifest.write().await;
        let jobs = cfg.resolved_waifu2x_jobs();
        let mode = if cfg.use_directory_enhance() {
            "目录批处理"
        } else {
            "逐页"
        };
        m.last_message = Some(format!("{mode} · 线程 -j {jobs}"));
        let _ = m.save();
        emit(&m, "enhance", None);
    }

    let enhance_res = if cfg.use_directory_enhance() {
        info!(
            jobs = %cfg.resolved_waifu2x_jobs(),
            "enhance mode=directory (single process, multi-thread -j)"
        );
        enhance_directory_batch(
            &manifest,
            engine.as_ref(),
            &params,
            gpu.clone(),
            cfg.engine_input_max_side,
            cancel.clone(),
            on_progress.clone(),
        )
        .await
    } else {
        info!(
            concurrency = cfg.enhance_concurrency,
            "enhance mode=parallel pages"
        );
        enhance_parallel_pages(
            &manifest,
            engine.as_ref(),
            &params,
            cfg.enhance_concurrency.max(1),
            gpu.clone(),
            cfg.engine_input_max_side,
            cancel.clone(),
            on_progress.clone(),
        )
        .await
    };
    match enhance_res {
        Ok(()) => {}
        Err(e) if e.code == crate::error::ErrorCode::Cancelled || cancel.is_cancelled() => {
            return mark_cancelled(&manifest).await;
        }
        Err(e) => return Err(e),
    }

    if cancel.is_cancelled() {
        return mark_cancelled(&manifest).await;
    }

    {
        let m = manifest.read().await;
        if m.stats.pages_done == 0 && m.stats.pages_total > 0 {
            let mut m = manifest.write().await;
            m.state = JobState::Failed;
            m.error = Some(AppError::internal("全部页增强失败"));
            m.stats.finished_at = Some(Utc::now());
            m.save()?;
            return Err(AppError::internal("全部页增强失败"));
        }
    }

    {
        let mut m = manifest.write().await;
        m.state = JobState::Finalizing;
        m.last_message = Some("正在打包（STORE，无二次压缩）…".into());
        m.refresh_stats();
        m.save()?;
        emit(&m, "repack", None);
    }

    // If user cancelled after enhance but output already exists, still complete.
    // If cancel before pack and no output yet — still try to finish packing (work is done).
    let export_snapshot = {
        let m = manifest.read().await;
        m.clone()
    };
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ExtractTick>();
    let export_result = tokio::task::spawn_blocking(move || {
        let tx = tx.clone();
        let mut cb = move |done: u32, total: u32, name: &str| {
            let _ = tx.send(ExtractTick {
                pages_done: done,
                pages_total: total,
                current: Some(name.to_string()),
            });
        };
        export_job_with_progress(
            &export_snapshot,
            Some(&mut cb as &mut archive::ExportProgressCb<'_>),
        )
    });

    while let Some(tick) = rx.recv().await {
        let mut m = manifest.write().await;
        m.stats.pages_done = tick.pages_done;
        m.stats.pages_total = tick.pages_total.max(1);
        let kind = tick.current.as_deref().unwrap_or("pack");
        let label = if kind == "encode" { "编码" } else { "写入" };
        m.last_message = Some(format!(
            "打包{label} {}/{}",
            tick.pages_done, tick.pages_total
        ));
        let _ = m.save();
        emit(&m, "repack", tick.current);
    }

    let export_result = export_result.await;

    match export_result {
        Ok(Ok(path)) => {
            let mut m = manifest.write().await;
            m.output_path = Some(path);
            m.state = JobState::Completed;
            m.error = None;
            m.last_message = Some("打包完成".into());
            m.stats.finished_at = Some(Utc::now());
            m.refresh_stats();
            m.save()?;
            emit(&m, "repack", None);
            info!(job = %m.job_id, "completed");
            Ok(())
        }
        Ok(Err(e)) => {
            error!(?e, "export failed");
            // If expected output already on disk, still treat as completed
            {
                let mut m = manifest.write().await;
                if crate::job::heal_if_output_ready(&mut m) {
                    m.save()?;
                    emit(&m, "repack", None);
                    info!(job = %m.job_id, "completed via existing output after export err");
                    return Ok(());
                }
                m.state = JobState::Failed;
                m.error = Some(e.clone());
                m.stats.finished_at = Some(Utc::now());
                m.save()?;
            }
            Err(e)
        }
        Err(join_err) => {
            error!(?join_err, "export task join failed");
            let mut m = manifest.write().await;
            if crate::job::heal_if_output_ready(&mut m) {
                m.save()?;
                emit(&m, "repack", None);
                return Ok(());
            }
            let e = AppError::internal(format!("export join: {join_err}"));
            m.state = JobState::Failed;
            m.error = Some(e.clone());
            m.stats.finished_at = Some(Utc::now());
            m.save()?;
            Err(e)
        }
    }
}

/// One waifu2x process per group of pages (`in/` → `out/`), poll progress by
/// counting output files. GPU 锁按组持有、组间让出，阅读器单页增强可插队。
async fn enhance_directory_batch(
    manifest: &Arc<RwLock<JobManifest>>,
    engine: &dyn UpscaleEngine,
    params: &comic_engines::EnhanceParams,
    gpu: GpuLock,
    input_cap: u32,
    cancel: CancellationToken,
    on_progress: Option<ProgressCallback>,
) -> AppResult<()> {
    const GROUP_SIZE: usize = 20;

    let out_dir = {
        let m = manifest.read().await;
        m.out_dir()
    };
    std::fs::create_dir_all(&out_dir)?;

    // 收集待增强页（快照到普通 Vec，供 spawn_blocking 使用）
    let pending: Vec<(usize, PathBuf)> = {
        let m = manifest.read().await;
        m.pages
            .iter()
            .enumerate()
            .filter(|(_, p)| p.status != PageStatus::Done)
            .filter_map(|(i, p)| p.in_path.clone().map(|inp| (i, inp)))
            .filter(|(_, inp)| inp.is_file())
            .collect()
    };
    if pending.is_empty() {
        return Ok(());
    }

    let poll_cancel = cancel.clone();
    let poll_manifest = manifest.clone();
    let poll_emit = on_progress.clone();
    let poller = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = poll_cancel.cancelled() => break,
                _ = tokio::time::sleep(std::time::Duration::from_millis(350)) => {
                    let mut m = poll_manifest.write().await;
                    let mut changed = false;
                    for page in &mut m.pages {
                        if page.status == PageStatus::Done {
                            continue;
                        }
                        if page_output_ready(page) {
                            page.status = PageStatus::Done;
                            changed = true;
                        }
                    }
                    if changed {
                        m.refresh_stats();
                        let _ = m.save();
                        if let Some(cb) = &poll_emit {
                            cb(ProgressEvent::from_manifest(&m, "enhance", None));
                        }
                    }
                }
            }
        }
    });

    let mut first_err: Option<AppError> = None;
    for group in pending.chunks(GROUP_SIZE) {
        if cancel.is_cancelled() {
            break;
        }
        let stage_dir = {
            let m = manifest.read().await;
            m.workdir.join(format!("in_group_{}", Uuid::new_v4()))
        };
        // 解码/缩放在 blocking 线程执行，避免卡住 tokio worker
        let group_owned: Vec<(usize, PathBuf)> = group.to_vec();
        let staged_dir = stage_dir.clone();
        let staged = tokio::task::spawn_blocking(move || {
            stage_group_inputs(&group_owned, &staged_dir, input_cap)
        })
        .await
        .map_err(|e| AppError::internal(format!("stage join: {e}")))?;
        if let Err(e) = staged {
            first_err = Some(e);
            let _ = std::fs::remove_dir_all(&stage_dir);
            break;
        }
        if !stage_dir.is_dir() {
            continue;
        }

        // 组级持锁：一组跑完即释放，让阅读器单页增强有机会拿到 GPU
        let guard = gpu.lock().await;
        if cancel.is_cancelled() {
            drop(guard);
            let _ = std::fs::remove_dir_all(&stage_dir);
            break;
        }
        let result = engine
            .enhance_batch(
                EnhanceBatchRequest::Directory {
                    input_dir: stage_dir.clone(),
                    output_dir: out_dir.clone(),
                    params: params.clone(),
                },
                cancel.clone(),
            )
            .await;
        drop(guard);
        let _ = std::fs::remove_dir_all(&stage_dir);
        if let Err(e) = result {
            first_err = Some(e.into());
            break;
        }
        tokio::task::yield_now().await;
    }

    poller.abort();
    let _ = poller.await;

    if cancel.is_cancelled() {
        return Err(AppError::cancelled());
    }

    // 统一后处理：扫描/重映射输出，标记 Done / Failed
    {
        let mut m = manifest.write().await;
        let out_dir = m.out_dir();
        for page in &mut m.pages {
            if let Some(found) = scan_match_output(&out_dir, page) {
                page.out_path = Some(found);
                page.status = PageStatus::Done;
                continue;
            }
            remap_out_path(page);
            if page_output_ready(page) {
                page.status = PageStatus::Done;
            } else if page.status != PageStatus::Done {
                page.status = PageStatus::Failed;
                page.error = Some("输出缺失".into());
            }
        }
        m.refresh_stats();
        m.save()?;
        if let Some(cb) = &on_progress {
            cb(ProgressEvent::from_manifest(&m, "enhance", None));
        }
    }

    match first_err {
        None => Ok(()),
        Some(e) => {
            let mut m = manifest.write().await;
            let done = m.stats.pages_done;
            if done == 0 {
                m.state = JobState::Failed;
                m.error = Some(e.clone());
                m.stats.finished_at = Some(Utc::now());
                m.save()?;
                return Err(e);
            }
            m.save()?;
            warn!(error = %e, done, "directory enhance partial; exporting done pages");
            Ok(())
        }
    }
}

/// Stage one group of engine inputs: native files within the cap are
/// symlinked/copied as-is; oversized or exotic formats are decoded,
/// downscaled (aspect preserved) and written as 8-bit PNG.
fn stage_group_inputs(
    group: &[(usize, PathBuf)],
    dest_dir: &Path,
    input_cap: u32,
) -> AppResult<()> {
    std::fs::create_dir_all(dest_dir)?;
    for (_, src) in group {
        let Some(name) = src.file_name() else {
            continue;
        };
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("page");
        let native = crate::image_io::is_engine_native_path(src);
        let within_cap = crate::image_io::image_dimensions(src)
            .map(|(w, h)| w.max(h) <= input_cap)
            .unwrap_or(false);
        if native && within_cap {
            let dst = dest_dir.join(name);
            // 不能用 symlink：waifu2x 的目录扫描会跳过符号链接，输出为空且静默成功
            std::fs::hard_link(src, &dst).or_else(|_| std::fs::copy(src, &dst).map(|_| ()))?;
        } else {
            let img = crate::image_io::prepare_for_engine(crate::image_io::load_image(src)?);
            let img = if img.width().max(img.height()) > input_cap {
                img.resize(input_cap, input_cap, image::imageops::FilterType::Lanczos3)
            } else {
                img
            };
            crate::image_io::write_engine_png(&img, &dest_dir.join(format!("{stem}.png")))?;
        }
    }
    Ok(())
}

/// Sequential single-page enhance (fallback / mock). Prefer directory mode for speed.
/// 每页独立持 GPU 锁，页间让出给阅读器增强；输入超过 cap 时先等比缩小。
#[allow(clippy::too_many_arguments)]
async fn enhance_parallel_pages(
    manifest: &Arc<RwLock<JobManifest>>,
    engine: &dyn UpscaleEngine,
    params: &comic_engines::EnhanceParams,
    _concurrency: usize,
    gpu: GpuLock,
    input_cap: u32,
    cancel: CancellationToken,
    on_progress: Option<ProgressCallback>,
) -> AppResult<()> {
    let page_count = {
        let m = manifest.read().await;
        m.pages.len()
    };
    // 引擎输出扩展名：output_format 显式指定时遵从，否则默认 png
    let out_ext = params.output_format.as_deref().unwrap_or("png");
    for idx in 0..page_count {
        if cancel.is_cancelled() {
            return Err(AppError::cancelled());
        }
        let (input, output, name) = {
            let m = manifest.read().await;
            let p = &m.pages[idx];
            (p.in_path.clone(), p.out_path.clone(), p.name.clone())
        };
        let (Some(input), Some(output)) = (input, output) else {
            continue;
        };
        let output = output.with_extension(out_ext);
        if output.is_file() {
            let mut m = manifest.write().await;
            m.pages[idx].out_path = Some(output);
            m.pages[idx].status = PageStatus::Done;
            m.refresh_stats();
            m.save()?;
            if let Some(cb) = &on_progress {
                cb(ProgressEvent::from_manifest(&m, "enhance", Some(name)));
            }
            continue;
        }
        // 超大输入：blocking 线程等比缩小到 cap 再送引擎
        let input = {
            let over = crate::image_io::image_dimensions(&input)
                .map(|(w, h)| w.max(h) > input_cap)
                .unwrap_or(false);
            if !over {
                input
            } else {
                let workdir = {
                    let m = manifest.read().await;
                    m.workdir.join(".capped")
                };
                let stem = format!("{idx:04}");
                let src = input.clone();
                let dest = workdir.join(format!("{stem}.png"));
                tokio::task::spawn_blocking(move || -> AppResult<PathBuf> {
                    let img =
                        crate::image_io::prepare_for_engine(crate::image_io::load_image(&src)?);
                    let img =
                        img.resize(input_cap, input_cap, image::imageops::FilterType::Lanczos3);
                    crate::image_io::write_engine_png(&img, &dest)?;
                    Ok(dest)
                })
                .await
                .map_err(|e| AppError::internal(format!("cap join: {e}")))??
            }
        };

        // 页级持锁，页间让出
        let guard = gpu.lock().await;
        if cancel.is_cancelled() {
            drop(guard);
            return Err(AppError::cancelled());
        }
        match engine
            .enhance_batch(
                EnhanceBatchRequest::SingleFile {
                    input,
                    output: output.clone(),
                    params: params.clone(),
                },
                cancel.clone(),
            )
            .await
        {
            Ok(_) => {
                let mut m = manifest.write().await;
                if output.is_file() {
                    m.pages[idx].out_path = Some(output);
                    m.pages[idx].status = PageStatus::Done;
                } else {
                    m.pages[idx].status = PageStatus::Failed;
                }
                m.refresh_stats();
                m.save()?;
                if let Some(cb) = &on_progress {
                    cb(ProgressEvent::from_manifest(&m, "enhance", Some(name)));
                }
            }
            Err(e) => {
                let app_err: AppError = e.into();
                if app_err.code == crate::error::ErrorCode::Cancelled {
                    drop(guard);
                    return Err(app_err);
                }
                let mut m = manifest.write().await;
                m.pages[idx].status = PageStatus::Failed;
                m.pages[idx].error = Some(app_err.message);
                m.refresh_stats();
                m.save()?;
            }
        }
        drop(guard);
        tokio::task::yield_now().await;
    }
    Ok(())
}

pub(crate) fn recover_pages_from_indir(m: &mut JobManifest) {
    let in_dir = m.in_dir();
    let out_dir = m.out_dir();
    if !in_dir.is_dir() {
        return;
    }
    let mut files: Vec<PathBuf> = std::fs::read_dir(&in_dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|e| e.to_str())
                    .map(crate::image_io::is_engine_native_ext)
                    .unwrap_or(false)
                && !p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.contains(".raw."))
                    .unwrap_or(false)
        })
        .collect();
    files.sort();
    if files.is_empty() {
        return;
    }
    let mut pages = Vec::with_capacity(files.len());
    for (idx, path) in files.into_iter().enumerate() {
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("page")
            .to_string();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("png");
        let out = out_dir.join(format!("{stem}.{ext}"));
        pages.push(PageRecord {
            index: idx as u32,
            name: path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("page.png")
                .to_string(),
            status: if out.is_file() {
                PageStatus::Done
            } else {
                PageStatus::Pending
            },
            in_path: Some(path),
            out_path: Some(out),
            error: None,
        });
    }
    info!(recovered = pages.len(), "recovered pages from in/");
    m.pages = pages;
    m.refresh_stats();
}

fn page_output_ready(page: &PageRecord) -> bool {
    if page.out_path.as_ref().map(|p| p.is_file()).unwrap_or(false) {
        return true;
    }
    remap_out_path_exists(page).is_some()
}

fn remap_out_path(page: &mut PageRecord) {
    if page.out_path.as_ref().map(|p| p.is_file()).unwrap_or(false) {
        return;
    }
    if let Some(p) = remap_out_path_exists(page) {
        page.out_path = Some(p);
    }
}

fn remap_out_path_exists(page: &PageRecord) -> Option<PathBuf> {
    let base = page.out_path.as_ref().or(page.in_path.as_ref())?;
    scan_match_output(base.parent()?, page)
}

fn scan_match_output(out_dir: &Path, page: &PageRecord) -> Option<PathBuf> {
    if page.out_path.as_ref().map(|p| p.is_file()).unwrap_or(false) {
        return page.out_path.clone();
    }
    let stem = page
        .out_path
        .as_ref()
        .or(page.in_path.as_ref())
        .and_then(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))?;
    for ext in ["jpg", "jpeg", "png", "webp"] {
        let p = out_dir.join(format!("{stem}.{ext}"));
        if p.is_file() {
            return Some(p);
        }
    }
    if let Ok(rd) = std::fs::read_dir(out_dir) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            if p.file_stem()
                .map(|s| s.to_string_lossy() == stem)
                .unwrap_or(false)
            {
                return Some(p);
            }
        }
    }
    None
}

async fn mark_cancelled(manifest: &Arc<RwLock<JobManifest>>) -> AppResult<()> {
    let mut m = manifest.write().await;
    m.state = JobState::Cancelled;
    m.error = Some(AppError::cancelled());
    m.stats.finished_at = Some(Utc::now());
    m.refresh_stats();
    m.save()?;
    warn!(job = %m.job_id, "job cancelled");
    Err(AppError::cancelled())
}
