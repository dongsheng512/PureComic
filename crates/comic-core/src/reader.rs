//! Local reader: resolve original / enhanced page files for a job or source.

use crate::archive;
use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
use crate::job::{JobManifest, PageRecord, PageStatus, SourceKind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderState {
    pub job_id: Option<String>,
    pub source: String,
    pub title: String,
    pub page_count: u32,
    pub job_state: Option<String>,
    pub pages_done: u32,
    pub pages: Vec<ReaderPageMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderPageMeta {
    pub index: u32,
    pub name: String,
    pub status: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderPageFile {
    pub index: u32,
    pub name: String,
    pub kind: String,
    pub path: String,
}

pub fn title_from_source(source: &Path) -> String {
    source
        .file_stem()
        .or_else(|| source.file_name())
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| source.display().to_string())
}

pub fn source_cache_key(source: &Path) -> String {
    let mut h = Sha256::new();
    h.update(source.to_string_lossy().as_bytes());
    hex::encode(&h.finalize()[..8])
}

fn status_str(s: PageStatus) -> &'static str {
    match s {
        PageStatus::Pending => "pending",
        PageStatus::Done => "done",
        PageStatus::Failed => "failed",
        PageStatus::Skipped => "skipped",
    }
}

fn enhanced_path(page: &PageRecord) -> Option<PathBuf> {
    if page.out_path.as_ref().is_some_and(|p| p.is_file()) {
        return page.out_path.clone();
    }
    let base = page.out_path.as_ref().or(page.in_path.as_ref())?;
    let guessed = base.parent().and_then(|p| p.parent()).map(|p| p.join("out"));
    let out_dir = page
        .out_path
        .as_ref()
        .and_then(|p| p.parent())
        .or(guessed.as_deref())?;
    if !out_dir.is_dir() {
        return None;
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
    None
}

fn original_path(page: &PageRecord) -> Option<PathBuf> {
    page.in_path.as_ref().filter(|p| p.is_file()).cloned()
}

pub fn kind_for_page(page: &PageRecord) -> &'static str {
    if page.out_path.as_ref().is_some_and(|p| p.is_file()) {
        return "enhanced";
    }
    if page.status == PageStatus::Done && enhanced_path(page).is_some() {
        return "enhanced";
    }
    if original_path(page).is_some() {
        "original"
    } else {
        "missing"
    }
}

pub fn state_from_manifest(m: &JobManifest) -> ReaderState {
    let pages: Vec<ReaderPageMeta> = if m.pages.is_empty() {
        Vec::new()
    } else {
        m.pages
            .iter()
            .map(|p| ReaderPageMeta {
                index: p.index,
                name: p.name.clone(),
                status: status_str(p.status).into(),
                kind: kind_for_page(p).into(),
            })
            .collect()
    };
    let page_count = if pages.is_empty() {
        m.stats.pages_total
    } else {
        pages.len() as u32
    };
    ReaderState {
        job_id: Some(m.job_id.clone()),
        source: m.source.path.display().to_string(),
        title: title_from_source(&m.source.path),
        page_count,
        job_state: serde_json::to_value(m.state)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string)),
        pages_done: m
            .pages
            .iter()
            .filter(|p| p.status == PageStatus::Done || kind_for_page(p) == "enhanced")
            .count() as u32,
        pages,
    }
}

pub fn state_from_source(source: &Path, cfg: &AppConfig) -> AppResult<ReaderState> {
    let (kind, names) = listed_pages(source, cfg)?;
    let pages = names
        .iter()
        .enumerate()
        .map(|(i, name)| ReaderPageMeta {
            index: i as u32,
            name: name.clone(),
            status: "pending".into(),
            kind: if kind == SourceKind::Folder {
                "original"
            } else {
                "missing"
            }
            .into(),
        })
        .collect();
    Ok(ReaderState {
        job_id: None,
        source: source.display().to_string(),
        title: title_from_source(source),
        page_count: names.len() as u32,
        job_state: None,
        pages_done: 0,
        pages,
    })
}

struct CachedList {
    path: PathBuf,
    mtime: Option<SystemTime>,
    len: u64,
    kind: SourceKind,
    names: Vec<String>,
}

fn list_cache() -> &'static Mutex<Option<CachedList>> {
    static CACHE: OnceLock<Mutex<Option<CachedList>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn file_fingerprint(path: &Path) -> (Option<SystemTime>, u64) {
    match std::fs::metadata(path) {
        Ok(m) => (m.modified().ok(), m.len()),
        Err(_) => (None, 0),
    }
}

/// Cached page listing — avoids re-opening the whole CBZ on every page turn.
pub fn listed_pages(source: &Path, cfg: &AppConfig) -> AppResult<(SourceKind, Vec<String>)> {
    let (mtime, len) = file_fingerprint(source);
    if let Ok(guard) = list_cache().lock() {
        if let Some(c) = guard.as_ref() {
            if c.path == source && c.mtime == mtime && c.len == len {
                return Ok((c.kind, c.names.clone()));
            }
        }
    }
    let v = archive::validate_source(source, cfg)?;
    if let Ok(mut guard) = list_cache().lock() {
        *guard = Some(CachedList {
            path: source.to_path_buf(),
            mtime,
            len,
            kind: v.kind,
            names: v.page_names.clone(),
        });
    }
    Ok((v.kind, v.page_names))
}

fn display_ext(name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "jpg",
        Some("png") => "png",
        Some("webp") => "webp",
        Some("gif") => "gif",
        _ => "png",
    }
}

fn extract_cache_path(cfg: &AppConfig, source: &Path, page_index: u32, ext: &str) -> PathBuf {
    cfg.work_root
        .join("reader")
        .join(source_cache_key(source))
        .join(format!("{page_index:04}.{ext}"))
}

fn extract_original(
    source: &Path,
    page_index: u32,
    cfg: &AppConfig,
) -> AppResult<(String, PathBuf)> {
    let (kind, names) = listed_pages(source, cfg)?;
    if page_index as usize >= names.len() {
        return Err(AppError::invalid(format!(
            "页索引越界: {page_index} / {}",
            names.len()
        )));
    }
    let name = names[page_index as usize].clone();
    if kind == SourceKind::Folder {
        let src = source.join(&name);
        if src.is_file() {
            return Ok((name, src));
        }
    }
    let ext = display_ext(&name);
    let dest = extract_cache_path(cfg, source, page_index, ext);
    if !dest.is_file() {
        archive::extract_page_native(source, kind, page_index, &name, &dest, cfg)?;
        if dest.is_file() && dest.metadata().map(|m| m.len() == 0).unwrap_or(false) {
            let _ = std::fs::remove_file(&dest);
            return Err(AppError::internal("抽取结果为空"));
        }
    }
    Ok((name, dest))
}

/// Ensure a displayable file exists: enhanced output, extracted original, or on-demand extract.
pub fn resolve_page_file(
    m: &JobManifest,
    page_index: u32,
    cfg: &AppConfig,
) -> AppResult<ReaderPageFile> {
    if let Some(page) = m.pages.iter().find(|p| p.index == page_index) {
        if let Some(path) = enhanced_path(page) {
            return Ok(ReaderPageFile {
                index: page_index,
                name: page.name.clone(),
                kind: "enhanced".into(),
                path: path.display().to_string(),
            });
        }
        if let Some(path) = original_path(page) {
            return Ok(ReaderPageFile {
                index: page_index,
                name: page.name.clone(),
                kind: "original".into(),
                path: path.display().to_string(),
            });
        }
    }

    let (name, path) = extract_original(&m.source.path, page_index, cfg)?;
    Ok(ReaderPageFile {
        index: page_index,
        name,
        kind: "original".into(),
        path: path.display().to_string(),
    })
}

pub fn resolve_source_page(
    source: &Path,
    page_index: u32,
    cfg: &AppConfig,
) -> AppResult<ReaderPageFile> {
    let (name, path) = extract_original(source, page_index, cfg)?;
    Ok(ReaderPageFile {
        index: page_index,
        name,
        kind: "original".into(),
        path: path.display().to_string(),
    })
}

pub fn resolve_pages(
    job: Option<&JobManifest>,
    source: Option<&Path>,
    indexes: &[u32],
    cfg: &AppConfig,
) -> AppResult<Vec<ReaderPageFile>> {
    let mut out = Vec::with_capacity(indexes.len());
    for &i in indexes {
        let file = if let Some(m) = job {
            resolve_page_file(m, i, cfg)?
        } else if let Some(src) = source {
            resolve_source_page(src, i, cfg)?
        } else {
            return Err(AppError::invalid("需要 job 或 source"));
        };
        out.push(file);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::{EnhanceOptions, JobSource, OutputOptions, SourceKind};
    use chrono::Utc;

    fn dummy_manifest(dir: &Path, pages: Vec<PageRecord>) -> JobManifest {
        let n = pages.len() as u32;
        JobManifest {
            schema_version: 1,
            job_id: "job-test".into(),
            created_at: Utc::now(),
            source: JobSource {
                path: dir.join("book.cbz"),
                kind: SourceKind::Cbz,
            },
            options: EnhanceOptions::default(),
            output: OutputOptions::default(),
            state: crate::job::JobState::Running,
            pages,
            metadata: crate::job::JobMetadata {
                comic_info_src: None,
            },
            stats: crate::job::JobStats {
                pages_done: 0,
                pages_total: n,
                started_at: None,
                finished_at: None,
                eta_sec: None,
            },
            output_path: None,
            error: None,
            workdir: dir.to_path_buf(),
            last_message: None,
        }
    }

    #[test]
    fn prefers_enhanced_file_when_present() {
        let tmp = tempfile::tempdir().unwrap();
        let indir = tmp.path().join("in");
        let outdir = tmp.path().join("out");
        std::fs::create_dir_all(&indir).unwrap();
        std::fs::create_dir_all(&outdir).unwrap();
        let inn = indir.join("0001.png");
        let out = outdir.join("0001.jpg");
        std::fs::write(&inn, b"in").unwrap();
        std::fs::write(&out, b"out").unwrap();
        let page = PageRecord {
            index: 0,
            name: "0001.png".into(),
            status: PageStatus::Pending,
            in_path: Some(inn),
            out_path: Some(out.clone()),
            error: None,
        };
        let m = dummy_manifest(tmp.path(), vec![page]);
        assert_eq!(kind_for_page(&m.pages[0]), "enhanced");
        let cfg = AppConfig::default();
        let file = resolve_page_file(&m, 0, &cfg).unwrap();
        assert_eq!(file.kind, "enhanced");
        assert_eq!(PathBuf::from(file.path), out);
    }

    #[test]
    fn falls_back_to_original_extract() {
        let tmp = tempfile::tempdir().unwrap();
        let indir = tmp.path().join("in");
        std::fs::create_dir_all(&indir).unwrap();
        let inn = indir.join("0001.png");
        std::fs::write(&inn, b"in").unwrap();
        let page = PageRecord {
            index: 0,
            name: "0001.png".into(),
            status: PageStatus::Pending,
            in_path: Some(inn.clone()),
            out_path: Some(tmp.path().join("out").join("0001.jpg")),
            error: None,
        };
        let m = dummy_manifest(tmp.path(), vec![page]);
        assert_eq!(kind_for_page(&m.pages[0]), "original");
        let cfg = AppConfig::default();
        let file = resolve_page_file(&m, 0, &cfg).unwrap();
        assert_eq!(file.kind, "original");
        assert_eq!(PathBuf::from(file.path), inn);
    }

    #[test]
    fn zip_original_passthrough_skips_png_reencode() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let tmp = tempfile::tempdir().unwrap();
        let cbz = tmp.path().join("book.cbz");
        {
            let f = std::fs::File::create(&cbz).unwrap();
            let mut w = ZipWriter::new(f);
            w.start_file("001.jpg", SimpleFileOptions::default()).unwrap();
            w.write_all(b"FAKEJPEG-BYTES").unwrap();
            w.finish().unwrap();
        }
        let mut cfg = AppConfig::default();
        cfg.work_root = tmp.path().join("work");
        let file = resolve_source_page(&cbz, 0, &cfg).unwrap();
        assert_eq!(file.kind, "original");
        assert!(
            file.path.ends_with(".jpg"),
            "expected native jpeg cache, got {}",
            file.path
        );
        assert_eq!(std::fs::read(&file.path).unwrap(), b"FAKEJPEG-BYTES");
        let again = resolve_source_page(&cbz, 0, &cfg).unwrap();
        assert_eq!(again.path, file.path);
    }

    #[test]
    fn cache_key_is_stable() {
        let a = source_cache_key(Path::new("/Comics/One.cbz"));
        let b = source_cache_key(Path::new("/Comics/One.cbz"));
        let c = source_cache_key(Path::new("/Comics/Two.cbz"));
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), 16);
    }
}
