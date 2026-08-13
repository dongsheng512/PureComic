//! Doctor / diagnostics bundle for support.

use crate::config::AppConfig;
use crate::error::AppResult;
use comic_engines::{EngineStatus, GpuInfo, UpscaleEngine};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    pub app_version: String,
    pub engine: EngineStatus,
    pub gpus: Vec<GpuInfo>,
    pub work_root: String,
    pub use_mock_engine: bool,
    pub os: String,
    pub arch: String,
    pub free_work_bytes: Option<u64>,
    pub jobs_on_disk: u32,
    pub timestamp: String,
    /// Host triple folder under third_party (e.g. darwin-arm64)
    pub host_target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waifu2x_binary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waifu2x_models: Option<String>,
    pub waifu2x_bundle_found: bool,
    /// `directory` (one process + -j) or `parallel` pages
    pub enhance_mode: String,
    /// waifu2x `-j load:proc:save`
    pub waifu2x_jobs: String,
    pub extract_concurrency: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unrar_binary: Option<String>,
    pub unrar_found: bool,
}

pub async fn collect_doctor(
    cfg: &AppConfig,
    engine: Arc<dyn UpscaleEngine>,
) -> AppResult<DoctorReport> {
    let gpus = engine.list_gpus().await.unwrap_or_default();
    let free = fs2::available_space(&cfg.work_root).ok().or_else(|| {
        fs2::available_space(std::env::temp_dir()).ok()
    });
    let mut jobs_on_disk = 0u32;
    if let Ok(rd) = std::fs::read_dir(cfg.jobs_dir()) {
        jobs_on_disk = rd.filter_map(|e| e.ok()).count() as u32;
    }
    let resolved = comic_engines::resolve_waifu2x_paths(
        cfg.waifu2x_bin.as_deref(),
        cfg.models_dir.as_deref(),
    );
    Ok(DoctorReport {
        app_version: env!("CARGO_PKG_VERSION").into(),
        engine: engine.status(),
        gpus,
        work_root: cfg.work_root.display().to_string(),
        use_mock_engine: cfg.use_mock_engine,
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        free_work_bytes: free,
        jobs_on_disk,
        timestamp: chrono::Utc::now().to_rfc3339(),
        host_target: comic_engines::host_target_triple().into(),
        waifu2x_binary: resolved.as_ref().map(|p| p.binary.display().to_string()),
        waifu2x_models: resolved
            .as_ref()
            .map(|p| p.models_dir.display().to_string()),
        waifu2x_bundle_found: resolved.is_some(),
        enhance_mode: if cfg.use_directory_enhance() {
            "directory".into()
        } else {
            "parallel".into()
        },
        waifu2x_jobs: cfg.resolved_waifu2x_jobs(),
        extract_concurrency: if cfg.extract_concurrency == 0 {
            num_cpus::get()
        } else {
            cfg.extract_concurrency
        },
        unrar_binary: crate::unrar::resolve_unrar(cfg).map(|p| p.display().to_string()),
        unrar_found: crate::unrar::resolve_unrar(cfg).is_some(),
    })
}

/// Write a small diagnostics zip under `out_dir` (or work_root/diagnostics).
pub async fn export_diagnostics_zip(
    cfg: &AppConfig,
    engine: Arc<dyn UpscaleEngine>,
    out_dir: Option<&Path>,
) -> AppResult<PathBuf> {
    use std::fs::File;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let report = collect_doctor(cfg, engine).await?;
    let dir = out_dir
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| cfg.work_root.join("diagnostics"));
    std::fs::create_dir_all(&dir)?;
    let stamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir.join(format!("purecomic-diag-{stamp}.zip"));

    let file = File::create(&path)?;
    let mut zip = ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let json = serde_json::to_vec_pretty(&report)?;
    zip.start_file("doctor.json", opts)
        .map_err(|e| crate::error::AppError::internal(format!("zip: {e}")))?;
    zip.write_all(&json)?;

    // include recent job logs (redacted paths partially — keep basenames)
    if let Ok(rd) = std::fs::read_dir(cfg.jobs_dir()) {
        let mut count = 0;
        for e in rd.flatten() {
            if count >= 5 {
                break;
            }
            let log = e.path().join("job.log");
            if log.is_file() {
                if let Ok(data) = std::fs::read(&log) {
                    let name = format!("jobs/{}/job.log", e.file_name().to_string_lossy());
                    let _ = zip.start_file(name, opts);
                    let _ = zip.write_all(&data);
                    count += 1;
                }
            }
            let man = e.path().join("manifest.json");
            if man.is_file() {
                if let Ok(mut data) = std::fs::read_to_string(&man) {
                    // light redaction: replace home prefix
                    if let Ok(home) = std::env::var("HOME") {
                        data = data.replace(&home, "~");
                    }
                    let name = format!("jobs/{}/manifest.json", e.file_name().to_string_lossy());
                    let _ = zip.start_file(name, opts);
                    let _ = zip.write_all(data.as_bytes());
                }
            }
        }
    }

    zip.finish()
        .map_err(|e| crate::error::AppError::internal(format!("zip finish: {e}")))?;
    Ok(path)
}
