mod open_paths;

use comic_core::config::AppConfig;
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

/// 用户自选文件夹漫画：按路径动态放行 asset 协议，避免恢复 `$HOME/**`。
fn allow_asset_path(app: &AppHandle, path: &str) {
    if path.is_empty() {
        return;
    }
    let p = Path::new(path);
    let dir = if p.is_dir() {
        p
    } else {
        match p.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            _ => return,
        }
    };
    let _ = app.asset_protocol_scope().allow_directory(dir, true);
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
) -> Result<comic_core::job::CreateJobResult, String> {
    state.scheduler.create_job(req).await.map_err(|e| e.message)
}

#[tauri::command]
async fn probe_resume(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<comic_core::job::ResumeHint>, String> {
    state
        .scheduler
        .probe_resume(&path)
        .await
        .map_err(|e| e.message)
}

#[tauri::command]
async fn cancel_job(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    state
        .scheduler
        .cancel_job(&job_id)
        .await
        .map_err(|e| e.message)
}

#[tauri::command]
async fn get_job(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<comic_core::job::JobStatus, String> {
    state
        .scheduler
        .get_job(&job_id)
        .await
        .map_err(|e| e.message)
}

#[tauri::command]
async fn list_jobs(state: State<'_, AppState>) -> Result<Vec<comic_core::job::JobStatus>, String> {
    state.scheduler.list_jobs().await.map_err(|e| e.message)
}

#[tauri::command]
async fn validate_source(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<comic_core::archive::ValidateResult, String> {
    // 先校验、后放行 asset scope：坏路径不应获得 scope 权限
    let result = state
        .scheduler
        .validate_source_path(&path)
        .await
        .map_err(|e| e.message)?;
    allow_asset_path(&app, &path);
    Ok(result)
}

#[tauri::command]
async fn estimate_disk_usage(
    state: State<'_, AppState>,
    path: String,
    scale: u8,
) -> Result<comic_core::estimate::DiskEstimate, String> {
    state
        .scheduler
        .estimate(&path, scale)
        .await
        .map_err(|e| e.message)
}

#[tauri::command]
async fn list_gpus(state: State<'_, AppState>) -> Result<Vec<comic_engines::GpuInfo>, String> {
    state
        .scheduler
        .engine()
        .list_gpus()
        .await
        .map_err(|e| e.to_string())
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
) -> Result<comic_core::reader::ReaderState, String> {
    if let Some(src) = source.as_deref() {
        allow_asset_path(&app, src);
    }
    let st = state
        .scheduler
        .get_reader_state(job_id.as_deref(), source.as_deref())
        .await
        .map_err(|e| e.message)?;
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
) -> Result<comic_core::reader::ReaderPageFile, String> {
    if let Some(src) = source.as_deref() {
        allow_asset_path(&app, src);
    }
    let page = state
        .scheduler
        .prepare_reader_page(job_id.as_deref(), source.as_deref(), page_index)
        .await
        .map_err(|e| e.message)?;
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
) -> Result<Vec<comic_core::reader::ReaderPageFile>, String> {
    if let Some(src) = source.as_deref() {
        allow_asset_path(&app, src);
    }
    let pages = state
        .scheduler
        .prepare_reader_pages(
            job_id.as_deref(),
            source.as_deref(),
            &page_indexes,
            prefer_original.unwrap_or(false),
        )
        .await
        .map_err(|e| e.message)?;
    if let Some(first) = pages.first() {
        allow_asset_path(&app, &first.path);
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
) -> Result<Vec<comic_core::reader::ReaderPageFile>, String> {
    if let Some(src) = source.as_deref() {
        allow_asset_path(&app, src);
    }
    let pages = state
        .scheduler
        .enhance_reader_pages(source.as_deref(), job_id.as_deref(), &page_indexes, options)
        .await
        .map_err(|e| e.message)?;
    if let Some(first) = pages.first() {
        allow_asset_path(&app, &first.path);
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
) -> Result<Vec<comic_core::reader::ReaderPageFile>, String> {
    let src = source.filter(|s| !s.is_empty());
    if src.is_none() && job_id.as_ref().is_some_and(|s| !s.is_empty()) {
        return Err("lookup 需要 source 路径".into());
    }
    if let Some(s) = src.as_deref() {
        allow_asset_path(&app, s);
    }
    // 同步实现会打开整个 CBZ 扫描页，放 blocking 线程避免卡 UI
    let sched = state.scheduler.clone();
    let pages = tokio::task::spawn_blocking(move || {
        sched.lookup_reader_enhance_pages(src.as_deref(), job_id.as_deref(), &page_indexes, options)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.message)?;
    if let Some(first) = pages.first() {
        allow_asset_path(&app, &first.path);
    }
    Ok(pages)
}

#[tauri::command]
async fn reader_enhance_cache_stats(
    state: State<'_, AppState>,
) -> Result<comic_core::reader_enhance::EnhanceCacheStats, String> {
    let sched = state.scheduler.clone();
    // 全树遍历磁盘缓存，放 blocking 线程
    let stats = tokio::task::spawn_blocking(move || sched.reader_enhance_cache_stats())
        .await
        .map_err(|e| e.to_string())?;
    Ok(stats)
}

#[tauri::command]
async fn clear_reader_enhance_cache(
    state: State<'_, AppState>,
) -> Result<comic_core::reader_enhance::EnhanceCacheClearResult, String> {
    // 内部先取消在途增强并等待退出，再在 blocking 线程删除目录
    state
        .scheduler
        .clear_reader_enhance_cache()
        .await
        .map_err(|e| e.message)
}

#[tauri::command]
fn cancel_reader_enhance(state: State<'_, AppState>) {
    state.scheduler.cancel_reader_enhance();
}

#[tauri::command]
async fn list_library(
    state: State<'_, AppState>,
) -> Result<Vec<comic_core::library::LibraryEntry>, String> {
    let sched = state.scheduler.clone();
    tokio::task::spawn_blocking(move || sched.list_library())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.message)
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
fn validate_external_open_path(app: AppHandle, path: String) -> Result<String, String> {
    let normalized =
        normalize_open_path(&path).ok_or_else(|| "不支持的文件类型，或路径不存在".to_string())?;
    allow_asset_path(&app, &normalized);
    Ok(normalized)
}

#[tauri::command]
async fn add_library_path(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<comic_core::library::LibraryEntry, String> {
    allow_asset_path(&app, &path);
    let sched = state.scheduler.clone();
    tokio::task::spawn_blocking(move || sched.add_library_path(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.message)
}

#[tauri::command]
async fn remove_library_entry(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let sched = state.scheduler.clone();
    tokio::task::spawn_blocking(move || sched.remove_library_entry(&id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.message)
}

#[tauri::command]
async fn preview_library_scan(
    state: State<'_, AppState>,
    root: String,
) -> Result<comic_core::library::LibraryScanPreview, String> {
    let sched = state.scheduler.clone();
    tokio::task::spawn_blocking(move || sched.preview_library_scan(&root))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.message)
}

#[tauri::command]
async fn import_library_paths(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<comic_core::library::LibraryScanResult, String> {
    for p in &paths {
        allow_asset_path(&app, p);
    }
    let sched = state.scheduler.clone();
    tokio::task::spawn_blocking(move || sched.import_library_paths(&paths))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.message)
}

#[tauri::command]
async fn touch_library(
    state: State<'_, AppState>,
    path: String,
    page: Option<u32>,
) -> Result<(), String> {
    state
        .scheduler
        .touch_library(&path, page)
        .map_err(|e| e.message)
}

#[tauri::command]
async fn preview_page(
    app: AppHandle,
    state: State<'_, AppState>,
    source: String,
    page_index: u32,
    options: Option<EnhanceOptionsDto>,
) -> Result<comic_core::preview::PreviewResult, String> {
    allow_asset_path(&app, &source);
    state
        .scheduler
        .preview_page(&source, page_index, options)
        .await
        .map_err(|e| e.message)
}

#[tauri::command]
async fn doctor(
    state: State<'_, AppState>,
) -> Result<comic_core::diagnostics::DoctorReport, String> {
    state.scheduler.doctor().await.map_err(|e| e.message)
}

#[tauri::command]
async fn export_diagnostics(
    state: State<'_, AppState>,
    out_dir: Option<String>,
) -> Result<serde_json::Value, String> {
    let path = state
        .scheduler
        .export_diagnostics(out_dir.map(std::path::PathBuf::from))
        .await
        .map_err(|e| e.message)?;
    Ok(serde_json::json!({ "zipPath": path.display().to_string() }))
}

#[tauri::command]
async fn clear_finished_jobs(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let n = state
        .scheduler
        .clear_finished_jobs()
        .await
        .map_err(|e| e.message)?;
    Ok(serde_json::json!({ "removed": n }))
}

#[tauri::command]
async fn remove_job(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    state
        .scheduler
        .remove_job(&job_id)
        .await
        .map_err(|e| e.message)
}

#[tauri::command]
async fn open_output_folder(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    let status = state
        .scheduler
        .get_job(&job_id)
        .await
        .map_err(|e| e.message)?;
    let path = status
        .output_path
        .ok_or_else(|| "任务尚无输出路径".to_string())?;
    let p = std::path::PathBuf::from(&path);
    let folder = if p.is_dir() {
        p
    } else {
        p.parent()
            .map(|x| x.to_path_buf())
            .ok_or_else(|| "无法解析输出目录".to_string())?
    };
    open::that(&folder).map_err(|e| format!("无法打开目录: {e}"))
}

/// Point config at sidecar + models inside the .app bundle (release) when present.
fn apply_packaged_engine_paths(app: &AppHandle, cfg: &mut AppConfig) {
    if cfg.waifu2x_bin.is_some() && cfg.models_dir.is_some() {
        return;
    }
    let mut bins = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            bins.push(dir.join("waifu2x-ncnn-vulkan"));
            bins.push(dir.join("PureComic-waifu2x-ncnn-vulkan"));
            bins.push(dir.join("purecomic-waifu2x-ncnn-vulkan"));
            bins.push(dir.join("comic-enhance-desktop-waifu2x-ncnn-vulkan"));
            if let Some(name) = exe.file_name() {
                bins.push(dir.join(format!("{}-waifu2x-ncnn-vulkan", name.to_string_lossy())));
            }
        }
    }
    let mut models = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        models.push(res.join("models-cunet"));
        models.push(res.join("resources/models-cunet"));
        std::env::set_var("COMIC_THIRD_PARTY", &res);
    }
    if cfg.waifu2x_bin.is_none() {
        if let Some(p) = bins.into_iter().find(|p| p.is_file()) {
            cfg.waifu2x_bin = Some(p);
        }
    }
    if cfg.models_dir.is_none() {
        if let Some(p) = models.into_iter().find(|p| p.is_dir()) {
            cfg.models_dir = Some(p);
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
            add_library_path,
            remove_library_entry,
            preview_library_scan,
            import_library_paths,
            touch_library,
            doctor,
            export_diagnostics,
            open_output_folder,
            clear_finished_jobs,
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
