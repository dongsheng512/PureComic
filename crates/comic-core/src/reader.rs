//! Local reader: resolve original / enhanced page files for a job or source.

use crate::archive;
use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
use crate::job::{JobManifest, PageRecord, PageStatus, SourceKind};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

/// Whole-book directories under `work_root/reader/{key}/`.
pub const MAX_READER_CACHE_BOOKS: usize = 10;
pub const MAX_READER_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

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
    // 内容指纹：同路径被替换（新文件）时不得命中旧增强缓存
    let meta = std::fs::metadata(source).ok();
    if let Some(m) = meta {
        if m.is_file() {
            h.update(b"|f");
            h.update(m.len().to_le_bytes());
            if let Ok(t) = m.modified() {
                h.update(
                    t.duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_nanos().to_le_bytes())
                        .unwrap_or_default(),
                );
            }
        } else if m.is_dir() {
            // 目录：条目数 + 最新子项 mtime 近似指纹
            h.update(b"|d");
            if let Ok(rd) = std::fs::read_dir(source) {
                let mut newest: Option<(u64, u32)> = None;
                let mut count = 0u32;
                for e in rd.flatten() {
                    count += 1;
                    if let Ok(em) = e.metadata() {
                        if let Ok(t) = em.modified() {
                            let secs = t
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_secs())
                                .unwrap_or(0);
                            if newest.map(|(s, _)| secs > s).unwrap_or(true) {
                                newest = Some((secs, em.len() as u32));
                            }
                        }
                    }
                }
                h.update(count.to_le_bytes());
                if let Some((s, l)) = newest {
                    h.update(s.to_le_bytes());
                    h.update(l.to_le_bytes());
                }
            }
        }
    }
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
    let guessed = base
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.join("out"));
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

fn page_name_tag(name: &str) -> String {
    let mut h = Sha256::new();
    h.update(name.as_bytes());
    hex::encode(&h.finalize()[..4])
}

fn extract_cache_path_for_name(
    cfg: &AppConfig,
    source: &Path,
    page_index: u32,
    name: &str,
    ext: &str,
) -> PathBuf {
    let tag = page_name_tag(name);
    cfg.work_root
        .join("reader")
        .join(source_cache_key(source))
        .join(format!("{page_index:04}.{tag}.{ext}"))
}

pub(crate) fn extract_original(
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
    let dest = extract_cache_path_for_name(cfg, source, page_index, &name, ext);
    if dest.is_file() && !crate::image_io::file_looks_like_image(&dest) {
        let _ = std::fs::remove_file(&dest);
    }
    if !dest.is_file() {
        archive::extract_page_native(source, kind, page_index, &name, &dest, cfg)?;
        if dest.is_file() && !crate::image_io::file_looks_like_image(&dest) {
            let _ = std::fs::remove_file(&dest);
            return Err(AppError::internal("抽取结果不是可显示的图片"));
        }
        schedule_reader_cache_evict(cfg);
    } else if let Some(parent) = dest.parent() {
        touch_path(parent);
    }
    Ok((name, dest))
}

fn reader_cache_root(cfg: &AppConfig) -> PathBuf {
    cfg.reader_dir()
}

/// 更新文件/目录 mtime，用于 LRU 的"最近使用"排序。
pub(crate) fn touch_path(path: &Path) {
    let now = SystemTime::now();
    if let Ok(f) = std::fs::File::open(path) {
        let _ = f.set_modified(now);
    }
}

/// 递归称一个目录：返回（最新 mtime, 总字节数）。
///
/// 缓存管理页的体积统计与 LRU 淘汰共用这一个实现 —— 别在别处再写一份，
/// 否则"页面上显示的体积"和"淘汰时算的体积"迟早会对不上。
pub(crate) fn book_dir_weight(dir: &Path) -> (SystemTime, u64) {
    let (newest, bytes, _) = book_dir_weight_full(dir);
    (newest, bytes)
}

/// 同上，但多返回文件数（"按漫画显示缓存"要显示每本几个文件）。
///
/// 仍然只有**这一处**遍历：`book_dir_weight` 也走这里。分两次遍历会让
/// 同一本书在总览行和明细行的体积出现不一致的窗口。
pub(crate) fn book_dir_weight_full(dir: &Path) -> (SystemTime, u64, u64) {
    let mut newest = SystemTime::UNIX_EPOCH;
    let mut bytes = 0u64;
    let mut files = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(p) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&p) else {
            continue;
        };
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if let Ok(meta) = path.metadata() {
                bytes = bytes.saturating_add(meta.len());
                files = files.saturating_add(1);
                if let Ok(t) = meta.modified() {
                    if t > newest {
                        newest = t;
                    }
                }
            }
        }
    }
    if let Ok(meta) = dir.metadata() {
        if let Ok(t) = meta.modified() {
            if t > newest {
                newest = t;
            }
        }
    }
    (newest, bytes, files)
}

/// Evict oldest whole-book extract dirs until under caps. `keep` is never deleted.
pub(crate) fn evict_reader_original_cache(cfg: &AppConfig, keep: Option<&Path>) -> AppResult<()> {
    let root = reader_cache_root(cfg);
    if !root.is_dir() {
        return Ok(());
    }
    let mut books: Vec<(PathBuf, SystemTime, u64)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&root) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            if keep.is_some_and(|k| k == p.as_path()) {
                continue;
            }
            let (mtime, bytes) = book_dir_weight(&p);
            books.push((p, mtime, bytes));
        }
    }
    books.sort_by_key(|b| b.1);
    let keep_bytes: u64 = keep.map(|k| book_dir_weight(k).1).unwrap_or(0);
    let mut total: u64 = books
        .iter()
        .map(|b| b.2)
        .sum::<u64>()
        .saturating_add(keep_bytes);
    let mut count = books.len() + usize::from(keep.is_some());
    for (path, _, len) in books {
        if count <= MAX_READER_CACHE_BOOKS && total <= MAX_READER_CACHE_BYTES {
            break;
        }
        if std::fs::remove_dir_all(&path).is_ok() {
            total = total.saturating_sub(len);
            count = count.saturating_sub(1);
        }
    }
    Ok(())
}

fn schedule_reader_cache_evict(cfg: &AppConfig) {
    static BUSY: AtomicBool = AtomicBool::new(false);
    if BUSY
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let cfg = cfg.clone();
    let spawn = std::thread::Builder::new()
        .name("reader-cache-evict".into())
        .spawn(move || {
            let _ = evict_reader_original_cache(&cfg, None);
            BUSY.store(false, Ordering::SeqCst);
        });
    if spawn.is_err() {
        BUSY.store(false, Ordering::SeqCst);
    }
}

/// 在途"读页"计数（含解压写盘）。
///
/// 清空整本缓存前必须等它归零 —— 否则正在写盘的那一页会被写进刚删掉的目录，
/// 前端表现为该页加载失败一次。下一页会自愈，所以只是体验瑕疵，
/// 但完全可避免。显式闸门比 `remove_dir_all` 快或慢的运气可靠。
static INFLIGHT_READS: AtomicUsize = AtomicUsize::new(0);
static INFLIGHT_READ_IDLE: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// RAII 守卫：在解析/抽取期间持有，保证缓存清理能等到它退出。
pub(crate) struct ReaderInflightGuard;

impl ReaderInflightGuard {
    pub(crate) fn enter() -> Self {
        INFLIGHT_READS.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for ReaderInflightGuard {
    fn drop(&mut self) {
        INFLIGHT_READS.fetch_sub(1, Ordering::SeqCst);
        INFLIGHT_READ_IDLE.notify_waiters();
    }
}

/// 等待在途读页退出（最多 `timeout`），返回是否已空闲。
/// 超时也返回 false 而**不阻塞清理** —— 腾空间比等一个卡住的读页更重要。
pub async fn wait_reader_reads_idle(timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if INFLIGHT_READS.load(Ordering::SeqCst) == 0 {
            return true;
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return false;
        }
        tokio::select! {
            _ = INFLIGHT_READ_IDLE.notified() => {}
            _ = tokio::time::sleep_until(deadline) => {}
        }
    }
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

/// Always extract / return the original page (ignore job enhanced outputs).
pub fn resolve_original_pages(
    source: &Path,
    indexes: &[u32],
    cfg: &AppConfig,
) -> AppResult<Vec<ReaderPageFile>> {
    let mut out = Vec::with_capacity(indexes.len());
    for &i in indexes {
        let (name, path) = extract_original(source, i, cfg)?;
        out.push(ReaderPageFile {
            index: i,
            name,
            kind: "original".into(),
            path: path.display().to_string(),
        });
    }
    Ok(out)
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
            abandoned: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
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
            w.start_file("001.jpg", SimpleFileOptions::default())
                .unwrap();
            w.write_all(b"\xFF\xD8\xFFFAKEJPEG-BYTES").unwrap();
            w.finish().unwrap();
        }
        let cfg = AppConfig {
            work_root: tmp.path().join("work"),
            ..Default::default()
        };
        let file = resolve_source_page(&cbz, 0, &cfg).unwrap();
        assert_eq!(file.kind, "original");
        assert!(
            file.path.contains(".jpg"),
            "expected native jpeg cache, got {}",
            file.path
        );
        assert_eq!(
            std::fs::read(&file.path).unwrap(),
            b"\xFF\xD8\xFFFAKEJPEG-BYTES"
        );
        let again = resolve_source_page(&cbz, 0, &cfg).unwrap();
        assert_eq!(again.path, file.path);
    }

    #[test]
    fn stale_appledouble_cache_is_reextracted() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        use zip::ZipWriter;

        let tmp = tempfile::tempdir().unwrap();
        let cbz = tmp.path().join("book.cbz");
        let jpeg = b"\xFF\xD8\xFFreal-page";
        {
            let f = std::fs::File::create(&cbz).unwrap();
            let mut w = ZipWriter::new(f);
            w.start_file("001.jpg", SimpleFileOptions::default())
                .unwrap();
            w.write_all(jpeg).unwrap();
            w.finish().unwrap();
        }
        let cfg = AppConfig {
            work_root: tmp.path().join("work"),
            ..Default::default()
        };
        let dest = extract_cache_path_for_name(&cfg, &cbz, 0, "001.jpg", "jpg");
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::write(&dest, [0x00, 0x05, 0x16, 0x07, 0, 0, 0, 0]).unwrap();
        let file = resolve_source_page(&cbz, 0, &cfg).unwrap();
        assert_eq!(std::fs::read(&file.path).unwrap(), jpeg);
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

    #[test]
    fn original_cache_evicts_oldest_books() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = AppConfig {
            work_root: tmp.path().join("work"),
            ..Default::default()
        };
        let root = cfg.work_root.join("reader");
        std::fs::create_dir_all(&root).unwrap();
        let mut dirs = Vec::new();
        for i in 0..12u64 {
            let d = root.join(format!("book{i:02}"));
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("0000.aaaa.jpg"), b"\xFF\xD8\xFF").unwrap();
            let t = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000 + i);
            if let Ok(f) = std::fs::File::open(&d) {
                let _ = f.set_modified(t);
            }
            if let Ok(f) = std::fs::File::open(d.join("0000.aaaa.jpg")) {
                let _ = f.set_modified(t);
            }
            dirs.push(d);
        }
        evict_reader_original_cache(&cfg, None).unwrap();
        let left = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_dir())
            .count();
        assert_eq!(left, MAX_READER_CACHE_BOOKS);
        assert!(!dirs[0].exists(), "oldest book dir should be evicted");
        assert!(dirs[11].exists(), "newest book dir should remain");
    }
}
