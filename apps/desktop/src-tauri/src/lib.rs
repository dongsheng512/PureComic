mod open_paths;

use comic_core::config::AppConfig;
use comic_core::error::AppError;
use comic_core::job::CreateJobRequest;
use comic_core::preview::EnhanceOptionsDto;
use comic_core::Scheduler;
use open_paths::{extract_open_paths, normalize_open_path};
use serde::Serialize;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

pub struct AppState {
    pub scheduler: Arc<Scheduler>,
    /// 启动时由外部文件关联传入、待前端领取的路径
    pub pending_open: Mutex<Vec<String>>,
}

fn push_pending_open(state: &AppState, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    if let Ok(mut g) = state.pending_open.lock() {
        for p in paths {
            if !g.iter().any(|x| x == &p) {
                g.push(p);
            }
        }
    }
}

/// 用户自选漫画的 asset 放行：文件只放行文件本身，文件夹才递归放行；
/// 不再放大到父目录整棵树（scope 只增不减，放行面越小越好）。
fn allow_asset_path(app: &AppHandle, path: &str) {
    if path.is_empty() {
        return;
    }
    let p = Path::new(path);
    if p.is_dir() {
        let _ = app.asset_protocol_scope().allow_directory(p, true);
    } else if p.is_file() {
        let _ = app.asset_protocol_scope().allow_file(p);
    }
}

fn emit_open_paths(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    for p in &paths {
        allow_asset_path(app, p);
    }
    if let Some(state) = app.try_state::<AppState>() {
        push_pending_open(state.inner(), paths.clone());
    }
    let _ = app.emit("app://open-paths", &paths);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
        let _ = w.unminimize();
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    job_id: String,
    stage: String,
    pages_done: u32,
    pages_total: u32,
    current_page: Option<String>,
    eta_sec: Option<u64>,
    message: Option<String>,
}

#[tauri::command]
async fn create_job(
    state: State<'_, AppState>,
    req: CreateJobRequest,
) -> Result<comic_core::job::CreateJobResult, AppError> {
    state.scheduler.create_job(req).await
}

#[tauri::command]
async fn probe_resume(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<comic_core::job::ResumeHint>, AppError> {
    state.scheduler.probe_resume(&path).await
}

#[tauri::command]
async fn cancel_job(state: State<'_, AppState>, job_id: String) -> Result<(), AppError> {
    state.scheduler.cancel_job(&job_id).await
}

#[tauri::command]
async fn get_job(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<comic_core::job::JobStatus, AppError> {
    state.scheduler.get_job(&job_id).await
}

#[tauri::command]
async fn list_jobs(
    state: State<'_, AppState>,
) -> Result<Vec<comic_core::job::JobStatus>, AppError> {
    state.scheduler.list_jobs().await
}

#[tauri::command]
async fn validate_source(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<comic_core::archive::ValidateResult, AppError> {
    // 先校验、后放行 asset scope：坏路径不应获得 scope 权限
    let result = state.scheduler.validate_source_path(&path).await?;
    allow_asset_path(&app, &path);
    Ok(result)
}

#[tauri::command]
async fn estimate_disk_usage(
    state: State<'_, AppState>,
    path: String,
    scale: u8,
    engine: Option<String>,
    image_format: Option<String>,
    output_dir: Option<String>,
) -> Result<comic_core::estimate::DiskEstimate, AppError> {
    // 引擎与格式决定中间页是 JPEG 还是 PNG，估算必须知道，
    // 否则默认（Real-CUGAN + JPEG）路径会被高估数倍。
    let engine = match engine.as_deref() {
        Some(id) if !id.trim().is_empty() => comic_core::job::parse_engine_kind(id)?,
        _ => comic_engines::EngineKind::RealCuganCoreMl,
    };
    let params = comic_core::estimate::EstimateParams {
        scale,
        engine,
        image_format: comic_core::job::parse_image_format(
            image_format.as_deref().unwrap_or("jpeg"),
        ),
    };
    let out = output_dir.as_deref().map(std::path::Path::new);
    state.scheduler.estimate(&path, params, out).await
}

#[tauri::command]
async fn list_gpus(state: State<'_, AppState>) -> Result<Vec<comic_engines::GpuInfo>, AppError> {
    state
        .scheduler
        .engine()
        .list_gpus()
        .await
        .map_err(AppError::from)
}

#[tauri::command]
async fn get_engine_status(
    state: State<'_, AppState>,
) -> Result<comic_engines::EngineStatus, String> {
    let mut st = state.scheduler.engine().status();
    let cfg = state.scheduler.config();
    let jobs = cfg.resolved_waifu2x_jobs();
    let mode = if cfg.use_directory_enhance() {
        "目录批处理"
    } else {
        "逐页并行"
    };
    st.detail = format!("{} · {} · 线程 -j {}", st.detail, mode, jobs);
    Ok(st)
}

#[tauri::command]
async fn list_engines(
    state: State<'_, AppState>,
) -> Result<Vec<comic_engines::EngineInfo>, String> {
    let mut list = state.scheduler.catalog();
    let cfg = state.scheduler.config();
    let jobs = cfg.resolved_waifu2x_jobs();
    let mode = if cfg.use_directory_enhance() {
        "目录批处理"
    } else {
        "逐页并行"
    };
    for e in &mut list {
        if !e.detail.contains("线程 -j") {
            e.detail = format!("{} · {} · 线程 -j {}", e.detail, mode, jobs);
        }
    }
    Ok(list)
}

#[tauri::command]
async fn get_reader_state(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: Option<String>,
    source: Option<String>,
) -> Result<comic_core::reader::ReaderState, AppError> {
    let st = state
        .scheduler
        .get_reader_state(job_id.as_deref(), source.as_deref())
        .await?;
    // 校验成功后才放行；ReaderState.pages 不含文件路径，无需逐页放行
    allow_asset_path(&app, &st.source);
    Ok(st)
}

#[tauri::command]
async fn prepare_reader_page(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: Option<String>,
    source: Option<String>,
    page_index: u32,
) -> Result<comic_core::reader::ReaderPageFile, AppError> {
    let page = state
        .scheduler
        .prepare_reader_page(job_id.as_deref(), source.as_deref(), page_index)
        .await?;
    if let Some(src) = source.as_deref() {
        allow_asset_path(&app, src);
    }
    allow_asset_path(&app, &page.path);
    Ok(page)
}

#[tauri::command]
async fn prepare_reader_pages(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: Option<String>,
    source: Option<String>,
    page_indexes: Vec<u32>,
    prefer_original: Option<bool>,
) -> Result<Vec<comic_core::reader::ReaderPageFile>, AppError> {
    let pages = state
        .scheduler
        .prepare_reader_pages(
            job_id.as_deref(),
            source.as_deref(),
            &page_indexes,
            prefer_original.unwrap_or(false),
        )
        .await?;
    if let Some(src) = source.as_deref() {
        allow_asset_path(&app, src);
    }
    for page in &pages {
        allow_asset_path(&app, &page.path);
    }
    Ok(pages)
}

#[tauri::command]
async fn enhance_reader_pages(
    app: AppHandle,
    state: State<'_, AppState>,
    source: Option<String>,
    job_id: Option<String>,
    page_indexes: Vec<u32>,
    options: Option<EnhanceOptionsDto>,
) -> Result<Vec<comic_core::reader::ReaderPageFile>, AppError> {
    let pages = state
        .scheduler
        .enhance_reader_pages(source.as_deref(), job_id.as_deref(), &page_indexes, options)
        .await?;
    if let Some(src) = source.as_deref() {
        allow_asset_path(&app, src);
    }
    for page in &pages {
        allow_asset_path(&app, &page.path);
    }
    Ok(pages)
}

#[tauri::command]
async fn lookup_reader_enhance_pages(
    app: AppHandle,
    state: State<'_, AppState>,
    source: Option<String>,
    job_id: Option<String>,
    page_indexes: Vec<u32>,
    options: Option<EnhanceOptionsDto>,
) -> Result<Vec<comic_core::reader::ReaderPageFile>, AppError> {
    let src = source.filter(|s| !s.is_empty());
    if src.is_none() && job_id.as_ref().is_some_and(|s| !s.is_empty()) {
        return Err(AppError::invalid("lookup 需要 source 路径"));
    }
    // 同步实现会打开整个 CBZ 扫描页，放 blocking 线程避免卡 UI
    let sched = state.scheduler.clone();
    let src_for_lookup = src.clone();
    let pages = tokio::task::spawn_blocking(move || {
        sched.lookup_reader_enhance_pages(
            src_for_lookup.as_deref(),
            job_id.as_deref(),
            &page_indexes,
            options,
        )
    })
    .await
    .map_err(|e| AppError::internal(e.to_string()))??;
    if let Some(s) = src.as_deref() {
        allow_asset_path(&app, s);
    }
    for page in &pages {
        allow_asset_path(&app, &page.path);
    }
    Ok(pages)
}

#[tauri::command]
async fn reader_enhance_cache_stats(
    state: State<'_, AppState>,
) -> Result<comic_core::reader_enhance::EnhanceCacheStats, AppError> {
    let sched = state.scheduler.clone();
    // 全树遍历磁盘缓存，放 blocking 线程
    let stats = tokio::task::spawn_blocking(move || sched.reader_enhance_cache_stats())
        .await
        .map_err(|e| AppError::internal(e.to_string()))?;
    Ok(stats)
}

#[tauri::command]
async fn clear_reader_enhance_cache(
    state: State<'_, AppState>,
) -> Result<comic_core::reader_enhance::EnhanceCacheClearResult, AppError> {
    // 内部先取消在途增强并等待退出，再在 blocking 线程删除目录
    state.scheduler.clear_reader_enhance_cache().await
}

#[tauri::command]
fn cancel_reader_enhance(state: State<'_, AppState>) {
    state.scheduler.cancel_reader_enhance();
}

#[tauri::command]
async fn list_library(
    state: State<'_, AppState>,
) -> Result<comic_core::library::LibraryIndex, AppError> {
    let sched = state.scheduler.clone();
    tokio::task::spawn_blocking(move || sched.list_library())
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

/// 领取启动时 / 外部打开时缓存的路径（一次性清空）。
#[tauri::command]
fn take_pending_open_paths(app: AppHandle, state: State<'_, AppState>) -> Vec<String> {
    let paths = state
        .pending_open
        .lock()
        .map(|mut g| std::mem::take(&mut *g))
        .unwrap_or_default();
    for p in &paths {
        allow_asset_path(&app, p);
    }
    paths
}

/// 校验外部路径是否允许作为临时阅读源（扩展名 + 存在性）。
#[tauri::command]
fn validate_external_open_path(app: AppHandle, path: String) -> Result<String, AppError> {
    let normalized = normalize_open_path(&path)
        .ok_or_else(|| AppError::invalid("不支持的文件类型，或路径不存在"))?;
    allow_asset_path(&app, &normalized);
    Ok(normalized)
}

#[tauri::command]
async fn add_library_path(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<comic_core::library::LibraryEntry, AppError> {
    let sched = state.scheduler.clone();
    let entry = tokio::task::spawn_blocking(move || sched.add_library_path(&path))
        .await
        .map_err(|e| AppError::internal(e.to_string()))??;
    // 入库成功后再放行 canonical 路径，失败项不进 scope
    allow_asset_path(&app, &entry.path);
    Ok(entry)
}

#[tauri::command]
async fn remove_library_entry(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let sched = state.scheduler.clone();
    tokio::task::spawn_blocking(move || sched.remove_library_entry(&id))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
async fn preview_library_scan(
    state: State<'_, AppState>,
    root: String,
) -> Result<comic_core::library::LibraryScanPreview, AppError> {
    let sched = state.scheduler.clone();
    tokio::task::spawn_blocking(move || sched.preview_library_scan(&root))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
async fn import_library_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<comic_core::library::LibraryScanResult, AppError> {
    let sched = state.scheduler.clone();
    let paths_for_import = paths.clone();
    let result = tokio::task::spawn_blocking(move || sched.import_library_paths(&paths_for_import))
        .await
        .map_err(|e| AppError::internal(e.to_string()))??;
    // 仅放行通过漫画校验的路径；导入失败的条目不进 scope
    for p in &paths {
        if open_paths::is_allowed_comic_path(Path::new(p)) {
            allow_asset_path(&app, p);
        }
    }
    Ok(result)
}

#[tauri::command]
async fn touch_library(
    state: State<'_, AppState>,
    path: String,
    page: Option<u32>,
) -> Result<(), AppError> {
    state.scheduler.touch_library(&path, page)
}

#[tauri::command]
async fn create_library_collection(
    state: State<'_, AppState>,
    title: String,
    entry_ids: Vec<String>,
) -> Result<comic_core::library::LibraryCollection, AppError> {
    let sched = state.scheduler.clone();
    tokio::task::spawn_blocking(move || sched.create_library_collection(&title, &entry_ids))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
async fn add_library_collection_entries(
    state: State<'_, AppState>,
    id: String,
    entry_ids: Vec<String>,
) -> Result<(), AppError> {
    let sched = state.scheduler.clone();
    tokio::task::spawn_blocking(move || sched.add_library_collection_entries(&id, &entry_ids))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
async fn remove_library_collection_entry(
    state: State<'_, AppState>,
    id: String,
    entry_id: String,
) -> Result<(), AppError> {
    let sched = state.scheduler.clone();
    tokio::task::spawn_blocking(move || sched.remove_library_collection_entry(&id, &entry_id))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
async fn move_library_collection_entry(
    state: State<'_, AppState>,
    id: String,
    entry_id: String,
    delta: i32,
) -> Result<(), AppError> {
    let sched = state.scheduler.clone();
    tokio::task::spawn_blocking(move || sched.move_library_collection_entry(&id, &entry_id, delta))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
async fn rename_library_collection(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> Result<(), AppError> {
    let sched = state.scheduler.clone();
    tokio::task::spawn_blocking(move || sched.rename_library_collection(&id, &title))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
async fn dissolve_library_collection(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let sched = state.scheduler.clone();
    tokio::task::spawn_blocking(move || sched.dissolve_library_collection(&id))
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
async fn preview_page(
    state: State<'_, AppState>,
    source: String,
    page_index: u32,
    options: Option<EnhanceOptionsDto>,
) -> Result<comic_core::preview::PreviewResult, AppError> {
    // PreviewResult 只含 data URL，不给 webview 文件路径；无需扩 asset scope
    state
        .scheduler
        .preview_page(&source, page_index, options)
        .await
}

#[tauri::command]
async fn doctor(
    state: State<'_, AppState>,
) -> Result<comic_core::diagnostics::DoctorReport, AppError> {
    state.scheduler.doctor().await
}

#[tauri::command]
async fn export_diagnostics(
    state: State<'_, AppState>,
    _out_dir: Option<String>,
) -> Result<serde_json::Value, AppError> {
    // 前端传入的 out_dir 忽略：诊断包固定落在 work_root/diagnostics
    let path = state.scheduler.export_diagnostics(None).await?;
    Ok(serde_json::json!({ "zipPath": path.display().to_string() }))
}

#[tauri::command]
async fn clear_finished_jobs(state: State<'_, AppState>) -> Result<serde_json::Value, AppError> {
    let n = state.scheduler.clear_finished_jobs().await?;
    Ok(serde_json::json!({ "removed": n }))
}

/// 缓存总览：全树遍历 → 后端已放 blocking 线程。
#[tauri::command]
async fn cache_overview(
    state: State<'_, AppState>,
) -> Result<comic_core::cache::CacheOverview, AppError> {
    state.scheduler.cache_overview().await
}

/// 清理一个缓存组。`id` 为 `jobs` 时后端内部转发到 `clear_finished_jobs`。
#[tauri::command]
async fn clear_cache_group(
    state: State<'_, AppState>,
    id: comic_core::cache::CacheGroupId,
) -> Result<comic_core::cache::CacheClearResult, AppError> {
    state.scheduler.clear_cache_group(id).await
}

/// 按漫画列出一个分组的占用明细（界面上"展开一本书"的那一层）。
#[tauri::command]
async fn cache_group_entries(
    state: State<'_, AppState>,
    id: comic_core::cache::CacheGroupId,
) -> Result<Vec<comic_core::cache::CacheEntry>, AppError> {
    state.scheduler.cache_group_entries(id).await
}

/// 清掉单本缓存。`key` 是明细行上的 `key`（目录名 / 书 id / 任务 id）。
#[tauri::command]
async fn clear_cache_entry(
    state: State<'_, AppState>,
    id: comic_core::cache::CacheGroupId,
    key: String,
) -> Result<comic_core::cache::CacheClearResult, AppError> {
    state.scheduler.clear_cache_entry(id, key).await
}

/// 缓存页主视图：一行 = 一本漫画占用的全部缓存（跨 5 类）。
#[tauri::command]
async fn cache_book_entries(
    state: State<'_, AppState>,
) -> Result<Vec<comic_core::cache::BookCacheEntry>, AppError> {
    state.scheduler.cache_book_entries().await
}

/// 清掉一本漫画的**全部类型**缓存。
///
/// 收的是「要清的项」清单而不是书 id：**未归属的行没有书 id**，
/// 按书 id 反查会漏掉它们，而"藏起来清不掉"正是这个模块要避免的事。
/// 清单由前端从 `BookCacheEntry.parts` 原样回传，服务端逐项校验。
#[tauri::command]
async fn clear_book_cache(
    state: State<'_, AppState>,
    parts: Vec<comic_core::cache::CachePartRef>,
) -> Result<comic_core::cache::CacheClearResult, AppError> {
    state.scheduler.clear_book_cache(parts).await
}

#[tauri::command]
async fn remove_job(state: State<'_, AppState>, job_id: String) -> Result<(), AppError> {
    state.scheduler.remove_job(&job_id).await
}

#[tauri::command]
async fn open_output_folder(state: State<'_, AppState>, job_id: String) -> Result<(), AppError> {
    let status = state.scheduler.get_job(&job_id).await?;
    let path = status
        .output_path
        .ok_or_else(|| AppError::invalid("任务尚无输出路径"))?;
    let p = std::path::PathBuf::from(&path);
    let folder = if p.is_dir() {
        p
    } else {
        p.parent()
            .map(|x| x.to_path_buf())
            .ok_or_else(|| AppError::internal("无法解析输出目录"))?
    };
    open::that(&folder).map_err(|e| AppError::internal(format!("无法打开目录: {e}")))
}

/// Point config at Core ML models inside the .app bundle (release) when present.
fn apply_packaged_engine_paths(app: &AppHandle, cfg: &mut AppConfig) {
    if let Ok(res) = app.path().resource_dir() {
        // 进程内显式指认资源根：release 不再经 COMIC_THIRD_PARTY 环境变量
        // 传递（环境可被启动环境注入未校验目录）
        comic_engines::paths::set_packaged_third_party(&res);
        if cfg.models_dir.is_none() {
            cfg.models_dir = Some(res);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,comic_core=debug".into()),
        )
        .init();

    let startup_paths = extract_open_paths(&std::env::args().collect::<Vec<_>>());

    tauri::Builder::default()
        // 单实例必须尽量靠前：二次启动把路径转发给已运行实例
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let paths = extract_open_paths(&argv);
            emit_open_paths(app, paths);
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let mut cfg = AppConfig::from_env();
            if let Ok(dir) = app.path().app_data_dir() {
                cfg.work_root = dir.join("work");
                // 书库封面在 work/library/covers，显式放行 asset 协议（含空格路径）
                let scope = app.asset_protocol_scope();
                let _ = scope.allow_directory(&dir, true);
                let _ = scope.allow_directory(dir.join("work"), true);
            }
            apply_packaged_engine_paths(app.handle(), &mut cfg);
            #[cfg(not(debug_assertions))]
            {
                cfg.allow_mock_fallback = false;
            }
            cfg.ensure_dirs().ok();

            let scheduler = Arc::new(Scheduler::new(cfg).expect("scheduler"));
            // 启动后台把历史上长出去的缓存夹回上限（mobi-cache 曾经完全没有上限）
            scheduler.spawn_cache_maintenance();
            let handle: AppHandle = app.handle().clone();
            let sched_cb = scheduler.clone();
            tauri::async_runtime::block_on(async move {
                sched_cb
                    .set_progress_callback(Arc::new(move |ev| {
                        let payload = ProgressPayload {
                            job_id: ev.job_id,
                            stage: ev.stage,
                            pages_done: ev.pages_done,
                            pages_total: ev.pages_total,
                            current_page: ev.current_page,
                            eta_sec: ev.eta_sec,
                            message: ev.message,
                        };
                        let _ = handle.emit("job://progress", payload);
                    }))
                    .await;
            });

            let pending = Mutex::new(startup_paths);
            app.manage(AppState {
                scheduler,
                pending_open: pending,
            });
            if let Ok(icon) =
                tauri::image::Image::from_bytes(include_bytes!("../icons/icon-1024.png"))
            {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_icon(icon);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_job,
            probe_resume,
            cancel_job,
            get_job,
            list_jobs,
            validate_source,
            estimate_disk_usage,
            list_gpus,
            get_engine_status,
            list_engines,
            preview_page,
            get_reader_state,
            prepare_reader_page,
            prepare_reader_pages,
            enhance_reader_pages,
            lookup_reader_enhance_pages,
            reader_enhance_cache_stats,
            clear_reader_enhance_cache,
            cancel_reader_enhance,
            list_library,
            create_library_collection,
            add_library_collection_entries,
            remove_library_collection_entry,
            move_library_collection_entry,
            rename_library_collection,
            dissolve_library_collection,
            add_library_path,
            remove_library_entry,
            preview_library_scan,
            import_library_paths,
            touch_library,
            doctor,
            export_diagnostics,
            open_output_folder,
            clear_finished_jobs,
            cache_overview,
            clear_cache_group,
            cache_group_entries,
            clear_cache_entry,
            cache_book_entries,
            clear_book_cache,
            remove_job,
            take_pending_open_paths,
            validate_external_open_path,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // macOS：Finder 双击/打开方式
            if let RunEvent::Opened { urls } = event {
                let paths: Vec<String> = urls
                    .into_iter()
                    .filter_map(|u| {
                        if u.scheme() == "file" {
                            u.to_file_path()
                                .ok()
                                .and_then(|p| normalize_open_path(&p.to_string_lossy()))
                        } else {
                            normalize_open_path(u.as_str())
                        }
                    })
                    .collect();
                emit_open_paths(app_handle, paths);
            }
        });
}
