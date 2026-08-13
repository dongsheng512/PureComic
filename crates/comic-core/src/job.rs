//! Job domain model, manifest schema v1, page state machine.

use crate::error::{AppError, AppResult, ErrorCode};
use chrono::{DateTime, Utc};
use comic_engines::{EngineKind, QualityPreset, ScaleFactor};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub const MANIFEST_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Folder,
    Zip,
    Cbz,
    /// EPUB (ZIP package with OPF spine / images)
    Epub,
    /// Kindle MOBI / AZW / AZW3 (image extraction via `mobi` crate)
    Mobi,
    /// MVP-B
    Cbr,
    /// Phase 2
    Pdf,
    Unknown,
}

impl SourceKind {
    pub fn detect(path: &Path) -> Self {
        if path.is_dir() {
            return Self::Folder;
        }
        match path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .as_deref()
        {
            Some("cbz") => Self::Cbz,
            Some("zip") => Self::Zip,
            Some("epub") => Self::Epub,
            Some("mobi") | Some("azw") | Some("azw3") => Self::Mobi,
            Some("cbr") | Some("rar") => {
                // Some "CBR" files are ZIP with a .cbr extension.
                if looks_like_zip(path) {
                    Self::Cbz
                } else {
                    Self::Cbr
                }
            }
            Some("pdf") => Self::Pdf,
            _ => Self::Unknown,
        }
    }
}

fn looks_like_zip(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut b = [0u8; 4];
    f.read_exact(&mut b).is_ok() && (b == *b"PK\x03\x04" || b == *b"PK\x05\x06")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Pending,
    Validating,
    Extracting,
    Running,
    Finalizing,
    Completed,
    Failed,
    Cancelling,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageStatus {
    Pending,
    Done,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputContainer {
    Cbz,
    Folder,
    Zip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageFormat {
    Png,
    Jpeg,
    Webp,
    Same,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputOptions {
    pub dir: PathBuf,
    pub container: OutputContainer,
    pub image_format: ImageFormat,
    #[serde(default = "default_jpeg_q")]
    pub jpeg_quality: u8,
    #[serde(default = "default_webp_q")]
    pub webp_quality: u8,
    /// default `{stem}_x{scale}`
    #[serde(default = "default_naming")]
    pub naming: String,
}

fn default_jpeg_q() -> u8 {
    92
}
fn default_webp_q() -> u8 {
    90
}
fn default_naming() -> String {
    "{stem}_x{scale}".into()
}

impl Default for OutputOptions {
    fn default() -> Self {
        Self {
            dir: PathBuf::from("."),
            container: OutputContainer::Cbz,
            image_format: ImageFormat::Jpeg,
            jpeg_quality: 92,
            webp_quality: 90,
            naming: default_naming(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnhanceOptions {
    pub engine: EngineKind,
    pub preset: QualityPreset,
    pub scale: ScaleFactor,
    pub noise: i8,
    #[serde(default)]
    pub tta: bool,
    pub tile_size: Option<u32>,
    pub gpu_id: Option<i32>,
    #[serde(default)]
    pub cugan_model: String,
}

impl Default for EnhanceOptions {
    fn default() -> Self {
        Self {
            engine: EngineKind::Waifu2x,
            preset: QualityPreset::Balanced,
            scale: ScaleFactor::X2,
            noise: 1,
            tta: false,
            tile_size: None,
            gpu_id: None,
            cugan_model: "se".into(),
        }
    }
}

impl EnhanceOptions {
    pub fn from_preset(preset: QualityPreset) -> Self {
        let mut o = Self {
            preset,
            ..Default::default()
        };
        match preset {
            QualityPreset::Fast => {
                o.noise = 0;
                o.scale = ScaleFactor::X2;
                o.tta = false;
            }
            QualityPreset::Balanced => {
                o.noise = 1;
                o.scale = ScaleFactor::X2;
                o.tta = false;
            }
            QualityPreset::Quality => {
                o.noise = 2;
                o.scale = ScaleFactor::X2;
                o.tta = false;
            }
        }
        o
    }

    pub fn to_engine_params(&self) -> comic_engines::EnhanceParams {
        comic_engines::EnhanceParams {
            engine: self.engine,
            scale: self.scale,
            noise_level: self.noise,
            preset: self.preset,
            tile_size: self.tile_size,
            gpu_id: self.gpu_id,
            tta: self.tta,
            jobs: None,
            output_format: None,
            cugan_model: if self.cugan_model.is_empty() {
                None
            } else {
                Some(self.cugan_model.clone())
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageRecord {
    pub index: u32,
    pub name: String,
    pub status: PageStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub out_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobSource {
    pub path: PathBuf,
    pub kind: SourceKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobStats {
    pub pages_done: u32,
    pub pages_total: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta_sec: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobMetadata {
    /// Path to byte-preserved ComicInfo.xml if present
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comic_info_src: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobManifest {
    pub schema_version: u32,
    pub job_id: String,
    pub created_at: DateTime<Utc>,
    pub source: JobSource,
    pub options: EnhanceOptions,
    pub output: OutputOptions,
    pub state: JobState,
    pub pages: Vec<PageRecord>,
    pub metadata: JobMetadata,
    pub stats: JobStats,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppError>,
    /// Work directory for this job
    pub workdir: PathBuf,
    /// Latest human-readable progress note (threads, packing page, …)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
}

impl JobManifest {
    pub fn new(source: PathBuf, options: EnhanceOptions, output: OutputOptions, workdir: PathBuf) -> Self {
        let kind = SourceKind::detect(&source);
        let job_id = Uuid::new_v4().to_string();
        Self {
            schema_version: MANIFEST_SCHEMA_VERSION,
            job_id,
            created_at: Utc::now(),
            source: JobSource { path: source, kind },
            options,
            output,
            state: JobState::Pending,
            pages: vec![],
            metadata: JobMetadata {
                comic_info_src: None,
            },
            stats: JobStats {
                pages_done: 0,
                pages_total: 0,
                started_at: None,
                finished_at: None,
                eta_sec: None,
            },
            output_path: None,
            error: None,
            workdir,
            last_message: None,
        }
    }

    pub fn manifest_path(job_dir: &Path) -> PathBuf {
        job_dir.join("manifest.json")
    }

    pub fn save(&self) -> AppResult<()> {
        std::fs::create_dir_all(&self.workdir)?;
        let path = Self::manifest_path(&self.workdir);
        let tmp = path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    pub fn load(job_dir: &Path) -> AppResult<Self> {
        let path = Self::manifest_path(job_dir);
        let data = std::fs::read_to_string(&path).map_err(|_| {
            AppError::not_found(format!("找不到 manifest: {}", path.display()))
        })?;
        let m: Self = serde_json::from_str(&data)?;
        Ok(m)
    }

    pub fn in_dir(&self) -> PathBuf {
        self.workdir.join("in")
    }

    pub fn out_dir(&self) -> PathBuf {
        self.workdir.join("out")
    }

    pub fn meta_dir(&self) -> PathBuf {
        self.workdir.join("meta")
    }

    pub fn log_path(&self) -> PathBuf {
        self.workdir.join("job.log")
    }

    pub fn refresh_stats(&mut self) {
        self.stats.pages_done = self
            .pages
            .iter()
            .filter(|p| p.status == PageStatus::Done)
            .count() as u32;
        self.stats.pages_total = self.pages.len() as u32;
    }

    pub fn to_status(&self) -> JobStatus {
        JobStatus {
            job_id: self.job_id.clone(),
            state: self.state,
            source: self.source.path.display().to_string(),
            output_path: self
                .output_path
                .as_ref()
                .map(|p| p.display().to_string()),
            pages_done: self.stats.pages_done,
            pages_total: self.stats.pages_total,
            stage: match self.state {
                JobState::Validating => Some("validate".into()),
                JobState::Extracting => Some("extract".into()),
                JobState::Running => Some("enhance".into()),
                JobState::Finalizing => Some("repack".into()),
                JobState::Completed => None,
                JobState::Cancelling => Some("cancelling".into()),
                _ => None,
            },
            eta_sec: self.stats.eta_sec,
            error: self.error.clone(),
            message: self.last_message.clone(),
        }
    }
}

fn output_artifact_ready(m: &JobManifest) -> Option<std::path::PathBuf> {
    let path = crate::archive::expected_output_path(m);
    let ready = match m.output.container {
        OutputContainer::Folder => path.is_dir(),
        OutputContainer::Cbz | OutputContainer::Zip => path
            .is_file()
            .then(|| {
                path.metadata()
                    .map(|x| {
                        if x.len() <= 1024 {
                            return false;
                        }
                        // Avoid flipping while the zip is still being written.
                        x.modified()
                            .ok()
                            .and_then(|t| t.elapsed().ok())
                            .map(|d| d.as_millis() >= 800)
                            .unwrap_or(true)
                    })
                    .unwrap_or(false)
            })
            .unwrap_or(false),
    };
    if ready {
        return Some(path);
    }
    if let Some(ref p) = m.output_path {
        if p.is_file() || p.is_dir() {
            return Some(p.clone());
        }
    }
    None
}

/// If enhance finished and output file/dir already exists, flip to Completed.
/// Fixes stuck UI on 打包中/取消中 after CBZ was written.
pub fn heal_if_output_ready(m: &mut JobManifest) -> bool {
    if matches!(m.state, JobState::Completed) {
        return false;
    }

    let Some(path) = output_artifact_ready(m) else {
        return false;
    };

    // Packing already produced a file: do not wait for every page flag.
    // Real-CUGAN can finish the CBZ while out_path extensions still mismatch.
    let packing = matches!(m.state, JobState::Finalizing | JobState::Cancelling);
    let all_done = m.stats.pages_total > 0
        && (m.stats.pages_done >= m.stats.pages_total
            || m.pages.iter().filter(|p| p.status == PageStatus::Done).count() as u32
                >= m.stats.pages_total);
    if !packing && !all_done && !m.pages.is_empty() {
        let done = m.pages.iter().filter(|p| p.status == PageStatus::Done).count();
        if done == 0 || done < m.pages.len() {
            return false;
        }
    }
    if !packing && m.pages.is_empty() && m.stats.pages_total == 0 {
        return false;
    }

    m.output_path = Some(path);
    m.state = JobState::Completed;
    m.error = None;
    m.last_message = Some("打包完成".into());
    m.stats.finished_at = m.stats.finished_at.or_else(|| Some(Utc::now()));
    m.refresh_stats();
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub job_id: String,
    /// snake_case string: pending|validating|extracting|running|...
    pub state: JobState,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    pub pages_done: u32,
    pub pages_total: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta_sec: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AppError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeHint {
    pub job_id: String,
    pub pages_done: u32,
    pub pages_total: u32,
    /// 1-based page index to continue from
    pub next_page: u32,
    pub source: String,
    pub message: String,
}

impl ResumeHint {
    pub fn from_counts(job_id: String, source: String, done: u32, total: u32) -> Self {
        let next = if total == 0 {
            1
        } else {
            (done + 1).min(total.max(1))
        };
        let message = if total == 0 {
            "发现未完成任务，将继续处理".into()
        } else {
            format!("上次已完成 {done}/{total} 页，开始将从第 {next} 页继续")
        };
        Self {
            job_id,
            pages_done: done,
            pages_total: total,
            next_page: next,
            source,
            message,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateJobResult {
    pub job_id: String,
    pub resumed: bool,
    pub pages_done: u32,
    pub pages_total: u32,
    pub next_page: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateJobRequest {
    pub source: String,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default = "default_preset_str")]
    pub preset: String,
    pub output: OutputOptionsDto,
    #[serde(default)]
    pub enhance: EnhanceDto,
}

fn default_preset_str() -> String {
    "balanced".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputOptionsDto {
    pub dir: String,
    #[serde(default = "default_container")]
    pub container: String,
    #[serde(default = "default_img_fmt")]
    pub image_format: String,
    pub jpeg_quality: Option<u8>,
    pub webp_quality: Option<u8>,
    pub naming: Option<String>,
}

fn default_container() -> String {
    "cbz".into()
}
fn default_img_fmt() -> String {
    "jpeg".into()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceDto {
    pub scale: Option<u8>,
    pub noise_level: Option<i8>,
    pub tile_size: Option<u32>,
    pub tta: Option<bool>,
    pub gpu_id: Option<i32>,
    pub cugan_model: Option<String>,
}

impl CreateJobRequest {
    pub fn into_parts(self) -> AppResult<(PathBuf, EnhanceOptions, OutputOptions)> {
        let source = PathBuf::from(&self.source);
        if !source.exists() {
            return Err(AppError::not_found(format!(
                "源文件不存在: {}",
                self.source
            )));
        }
        let kind = SourceKind::detect(&source);
        match kind {
            SourceKind::Folder
            | SourceKind::Zip
            | SourceKind::Cbz
            | SourceKind::Epub
            | SourceKind::Mobi
            | SourceKind::Cbr => {}
            SourceKind::Pdf => {
                return Err(AppError::unsupported(
                    "PDF 属于 Phase 2，请先使用 CBZ/ZIP/EPUB/MOBI/文件夹",
                ));
            }
            SourceKind::Unknown => {
                return Err(AppError::unsupported(
                    "不支持的格式；请使用 Folder / ZIP / CBZ / CBR / EPUB / MOBI",
                ));
            }
        }

        let preset = match self.preset.to_ascii_lowercase().as_str() {
            "fast" => QualityPreset::Fast,
            "quality" => QualityPreset::Quality,
            _ => QualityPreset::Balanced,
        };
        let mut options = EnhanceOptions::from_preset(preset);
        if let Some(eng) = &self.engine {
            options.engine = match eng.as_str() {
                "anime4k2x" | "anime4k" => {
                    return Err(AppError::unsupported(
                        "Anime4K 属于 MVP-B；请使用 waifu2x 或 auto",
                    ));
                }
                "waifu2x" | "auto" | "" => EngineKind::Waifu2x,
                "realcugan" | "cugan" => EngineKind::RealCugan,
                other => {
                    return Err(AppError::invalid(format!("未知引擎: {other}")));
                }
            };
        }
        if let Some(s) = self.enhance.scale {
            options.scale = ScaleFactor::try_from_u8(s).map_err(AppError::invalid)?;
        }
        if let Some(n) = self.enhance.noise_level {
            if !(-1..=3).contains(&n) {
                return Err(AppError::invalid("noise_level 须在 -1..=3"));
            }
            options.noise = n;
        }
        if let Some(t) = self.enhance.tile_size {
            options.tile_size = Some(t);
        }
        if let Some(tta) = self.enhance.tta {
            options.tta = tta;
        }
        if let Some(g) = self.enhance.gpu_id {
            options.gpu_id = Some(g);
        }
        if let Some(cm) = self.enhance.cugan_model {
            options.cugan_model = cm;
        }

        let container = match self.output.container.to_ascii_lowercase().as_str() {
            "folder" => OutputContainer::Folder,
            "zip" => OutputContainer::Zip,
            _ => OutputContainer::Cbz,
        };
        let image_format = match self.output.image_format.to_ascii_lowercase().as_str() {
            "png" => ImageFormat::Png,
            "webp" => ImageFormat::Webp,
            "same" => ImageFormat::Same,
            _ => ImageFormat::Jpeg,
        };
        let output = OutputOptions {
            dir: PathBuf::from(&self.output.dir),
            container,
            image_format,
            jpeg_quality: self.output.jpeg_quality.unwrap_or(92),
            webp_quality: self.output.webp_quality.unwrap_or(90),
            naming: self
                .output
                .naming
                .unwrap_or_else(|| "{stem}_x{scale}".into()),
        };

        Ok((source, options, output))
    }
}

/// Progress event payload for IPC / CLI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub job_id: String,
    pub stage: String,
    pub pages_done: u32,
    pub pages_total: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_page: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta_sec: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl ProgressEvent {
    pub fn from_manifest(m: &JobManifest, stage: &str, current: Option<String>) -> Self {
        Self {
            job_id: m.job_id.clone(),
            stage: stage.into(),
            pages_done: m.stats.pages_done,
            pages_total: m.stats.pages_total,
            current_page: current,
            eta_sec: m.stats.eta_sec,
            message: m.last_message.clone(),
        }
    }
}

// silence unused import warning for ErrorCode in some builds
const _: ErrorCode = ErrorCode::Internal;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_kinds() {
        assert_eq!(SourceKind::detect(Path::new("a.cbz")), SourceKind::Cbz);
        assert_eq!(SourceKind::detect(Path::new("a.ZIP")), SourceKind::Zip);
        assert_eq!(SourceKind::detect(Path::new("a.epub")), SourceKind::Epub);
        assert_eq!(SourceKind::detect(Path::new("a.mobi")), SourceKind::Mobi);
        assert_eq!(SourceKind::detect(Path::new("a.azw3")), SourceKind::Mobi);
        assert_eq!(SourceKind::detect(Path::new("a.cbr")), SourceKind::Cbr);
        assert_eq!(SourceKind::detect(Path::new("a.rar")), SourceKind::Cbr);
    }

    #[test]
    fn preset_noise() {
        let f = EnhanceOptions::from_preset(QualityPreset::Fast);
        assert_eq!(f.noise, 0);
        let b = EnhanceOptions::from_preset(QualityPreset::Balanced);
        assert_eq!(b.noise, 1);
    }

    #[test]
    fn manifest_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("job1");
        let mut m = JobManifest::new(
            PathBuf::from("/tmp/a.cbz"),
            EnhanceOptions::default(),
            OutputOptions {
                dir: PathBuf::from("/tmp/out"),
                ..Default::default()
            },
            work.clone(),
        );
        m.pages.push(PageRecord {
            index: 0,
            name: "001.jpg".into(),
            status: PageStatus::Pending,
            in_path: None,
            out_path: None,
            error: None,
        });
        m.save().unwrap();
        let loaded = JobManifest::load(&work).unwrap();
        assert_eq!(loaded.job_id, m.job_id);
        assert_eq!(loaded.pages.len(), 1);
    }

    #[test]
    fn heal_finalizing_when_cbz_already_written() {
        let dir = tempfile::tempdir().unwrap();
        let out_dir = dir.path().join("dest");
        std::fs::create_dir_all(&out_dir).unwrap();
        let src = dir.path().join("book.cbz");
        let _ = std::fs::write(&src, b"x");
        let mut m = JobManifest::new(
            src,
            EnhanceOptions::default(),
            OutputOptions {
                dir: out_dir,
                naming: "{stem}_x{scale}".into(),
                ..Default::default()
            },
            dir.path().join("work"),
        );
        m.state = JobState::Finalizing;
        m.stats.pages_done = 0;
        m.stats.pages_total = 12;
        let dest = crate::archive::expected_output_path(&m);
        std::fs::write(&dest, vec![1u8; 4096]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(850));
        assert!(heal_if_output_ready(&mut m));
        assert_eq!(m.state, JobState::Completed);
        assert!(m.output_path.is_some());
    }
}
