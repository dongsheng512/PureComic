//! Local library index: records only, files stay on the original path.

use crate::archive;
use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
use crate::image_io::{self, is_image_path};
use crate::job::SourceKind;
use crate::reader::{source_cache_key, title_from_source};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

const LIBRARY_VERSION: u32 = 1;
/// Longest side of cached cover JPEG. Sized for retina grids (~2× display width).
const COVER_MAX_SIDE: u32 = 720;
const COVER_JPEG_QUALITY: u8 = 90;
/// Bump when cover encode params change so old blurry thumbs regenerate.
const COVER_CACHE_TAG: &str = "v3";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryEntry {
    pub id: String,
    pub path: String,
    pub kind: String,
    pub title: String,
    pub page_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_path: Option<String>,
    #[serde(default)]
    pub last_read_page: u32,
    pub added_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_opened_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(default)]
    pub enhance_state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    #[serde(default)]
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScanCandidate {
    pub path: String,
    pub title: String,
    pub kind: String,
    pub already_in_library: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScanPreview {
    pub root: String,
    pub candidates: Vec<LibraryScanCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScanResult {
    pub added: u32,
    pub existed: u32,
    pub skipped: u32,
    pub failed: u32,
    pub titles: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LibraryFile {
    version: u32,
    entries: Vec<LibraryEntry>,
}

#[derive(Debug, Clone)]
pub struct LibraryStore {
    path: PathBuf,
    cover_dir: PathBuf,
    entries: Vec<LibraryEntry>,
}

impl LibraryStore {
    pub fn open(cfg: &AppConfig) -> AppResult<Self> {
        let path = cfg.library_path();
        let cover_dir = cfg.library_covers_dir();
        std::fs::create_dir_all(&cover_dir)?;
        let entries = if path.is_file() {
            let data = std::fs::read_to_string(&path)?;
            let file: LibraryFile = serde_json::from_str(&data).unwrap_or(LibraryFile {
                version: LIBRARY_VERSION,
                entries: vec![],
            });
            file.entries
        } else {
            vec![]
        };
        Ok(Self {
            path,
            cover_dir,
            entries,
        })
    }

    pub fn save(&self) -> AppResult<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = LibraryFile {
            version: LIBRARY_VERSION,
            entries: self.entries.clone(),
        };
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&file)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    pub fn list(&mut self) -> Vec<LibraryEntry> {
        for e in &mut self.entries {
            e.missing = !PathBuf::from(&e.path).exists();
        }
        let mut out = self.entries.clone();
        out.sort_by(|a, b| {
            b.last_opened_at
                .cmp(&a.last_opened_at)
                .then(b.added_at.cmp(&a.added_at))
        });
        out
    }

    pub fn refresh_covers(&mut self, cfg: &AppConfig) {
        let mut dirty = false;
        for e in &mut self.entries {
            e.missing = !PathBuf::from(&e.path).exists();
            let dest = cover_dest(&self.cover_dir, e);
            let ok = e
                .cover_path
                .as_ref()
                .map(|p| Path::new(p) == dest.as_path())
                .unwrap_or(false)
                && dest.is_file()
                && dest.metadata().map(|m| m.len() > 32).unwrap_or(false);
            if ok || e.missing {
                continue;
            }
            if let Ok(c) = ensure_cover(e, &self.cover_dir, cfg) {
                e.cover_path = Some(c.display().to_string());
                dirty = true;
            }
        }
        if dirty {
            let _ = self.save();
        }
    }

    pub fn upsert_path(&mut self, raw: &Path, cfg: &AppConfig) -> AppResult<LibraryEntry> {
        let path = canonicalize_or_abs(raw);
        if is_hidden(&path) {
            return Err(AppError::invalid("忽略隐藏文件"));
        }
        let id = source_cache_key(&path);
        if let Some(pos) = self
            .entries
            .iter()
            .position(|e| e.id == id || paths_eq(&e.path, &path))
        {
            let existing = &mut self.entries[pos];
            existing.missing = !path.exists();
            existing.last_opened_at = Some(Utc::now());
            existing.path = path.display().to_string();
            // 重新导入时补全页数 / 封面（首次因校验失败可能是 0 / 空）
            if existing.page_count == 0 || !cover_file_ok(existing.cover_path.as_deref()) {
                if let Ok(v) = archive::validate_source(&path, cfg) {
                    existing.page_count = v.page_count;
                    existing.kind = kind_str(v.kind);
                }
                if let Ok(cover) = ensure_cover(existing, &self.cover_dir, cfg) {
                    existing.cover_path = Some(cover.display().to_string());
                }
            }
            let snap = existing.clone();
            self.save()?;
            return Ok(snap);
        }

        let kind = SourceKind::detect(&path);
        if matches!(kind, SourceKind::Unknown | SourceKind::Pdf) {
            return Err(AppError::unsupported("不是可导入的漫画文件或图片文件夹"));
        }

        let (kind_label, page_count) = match archive::validate_source(&path, cfg) {
            Ok(v) => (kind_str(v.kind), v.page_count),
            Err(e) if path.is_file() && is_comic_archive(&path) => {
                tracing::warn!(error = %e.message, path = %path.display(), "validate failed, still index");
                (kind_str(kind), 0)
            }
            Err(e) => return Err(e),
        };

        let mut entry = LibraryEntry {
            id: id.clone(),
            path: path.display().to_string(),
            kind: kind_label,
            title: title_from_source(&path),
            page_count,
            cover_path: None,
            last_read_page: 0,
            added_at: Utc::now(),
            last_opened_at: Some(Utc::now()),
            job_id: None,
            enhance_state: "none".into(),
            output_path: None,
            missing: !path.exists(),
        };
        match ensure_cover(&entry, &self.cover_dir, cfg) {
            Ok(cover) => entry.cover_path = Some(cover.display().to_string()),
            Err(e) => {
                tracing::warn!(
                    error = %e.message,
                    path = %path.display(),
                    "cover generation failed"
                );
            }
        }
        self.entries.push(entry.clone());
        self.save()?;
        Ok(entry)
    }

    pub fn remove(&mut self, id: &str) -> AppResult<bool> {
        let before = self.entries.len();
        if let Some(e) = self.entries.iter().find(|e| e.id == id) {
            if let Some(c) = &e.cover_path {
                let _ = std::fs::remove_file(c);
            }
        }
        self.entries.retain(|e| e.id != id);
        if self.entries.len() == before {
            return Ok(false);
        }
        self.save()?;
        Ok(true)
    }

    pub fn touch(&mut self, path: &Path, page: Option<u32>) -> AppResult<()> {
        let path = canonicalize_or_abs(path);
        let id = source_cache_key(&path);
        if let Some(e) = self
            .entries
            .iter_mut()
            .find(|e| e.id == id || paths_eq(&e.path, &path))
        {
            e.last_opened_at = Some(Utc::now());
            if let Some(p) = page {
                e.last_read_page = p;
            }
            self.save()?;
        }
        Ok(())
    }

    pub fn attach_job(
        &mut self,
        path: &Path,
        job_id: &str,
        state: &str,
        output: Option<&str>,
    ) -> AppResult<()> {
        let path = canonicalize_or_abs(path);
        let id = source_cache_key(&path);
        if let Some(e) = self
            .entries
            .iter_mut()
            .find(|e| e.id == id || paths_eq(&e.path, &path))
        {
            e.job_id = Some(job_id.to_string());
            e.enhance_state = state.to_string();
            if let Some(o) = output {
                e.output_path = Some(o.to_string());
            }
            self.save()?;
        }
        Ok(())
    }

    pub fn preview_scan(&self, root: &Path) -> AppResult<LibraryScanPreview> {
        if !root.is_dir() {
            return Err(AppError::invalid("扫描路径不是文件夹"));
        }
        let found = discover_comics(root);
        let candidates = found
            .into_iter()
            .map(|p| {
                let abs = canonicalize_or_abs(&p);
                let id = source_cache_key(&abs);
                let already = self
                    .entries
                    .iter()
                    .any(|e| e.id == id || paths_eq(&e.path, &abs));
                LibraryScanCandidate {
                    path: abs.display().to_string(),
                    title: title_from_source(&abs),
                    kind: kind_str(SourceKind::detect(&abs)),
                    already_in_library: already,
                }
            })
            .collect();
        Ok(LibraryScanPreview {
            root: canonicalize_or_abs(root).display().to_string(),
            candidates,
        })
    }

    pub fn import_paths(
        &mut self,
        paths: &[PathBuf],
        cfg: &AppConfig,
    ) -> AppResult<LibraryScanResult> {
        let mut added = 0u32;
        let mut existed = 0u32;
        let mut skipped = 0u32;
        let mut failed = 0u32;
        let mut titles = Vec::new();
        for p in paths {
            if p.as_os_str().is_empty() {
                skipped += 1;
                continue;
            }
            let id = source_cache_key(&canonicalize_or_abs(p));
            if self
                .entries
                .iter()
                .any(|e| e.id == id || paths_eq(&e.path, p))
            {
                existed += 1;
                continue;
            }
            match self.upsert_path(p, cfg) {
                Ok(e) => {
                    added += 1;
                    titles.push(e.title);
                }
                Err(_) => {
                    if p.is_dir() {
                        skipped += 1;
                    } else {
                        failed += 1;
                    }
                }
            }
        }
        let message =
            format!("已导入 {added} 本（已在书库 {existed}，跳过 {skipped}，失败 {failed}）");
        Ok(LibraryScanResult {
            added,
            existed,
            skipped,
            failed,
            titles,
            message,
        })
    }
}

fn kind_str(k: SourceKind) -> String {
    serde_json::to_value(k)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".into())
}

fn canonicalize_or_abs(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|c| c.join(path))
                .unwrap_or_else(|_| path.to_path_buf())
        }
    })
}

fn paths_eq(a: &str, b: &Path) -> bool {
    Path::new(a) == b || canonicalize_or_abs(Path::new(a)) == canonicalize_or_abs(b)
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.') || n == "__MACOSX")
        .unwrap_or(false)
}

pub fn is_comic_archive(path: &Path) -> bool {
    matches!(
        SourceKind::detect(path),
        SourceKind::Cbz | SourceKind::Zip | SourceKind::Cbr | SourceKind::Epub | SourceKind::Mobi
    )
}

fn looks_like_enhance_output(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("_x1.")
        || lower.contains("_x2.")
        || lower.contains("_x3.")
        || lower.contains("_x4.")
}

fn dir_has_images(dir: &Path) -> bool {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return false;
    };
    rd.flatten().any(|e| {
        let p = e.path();
        p.is_file() && is_image_path(&p) && !is_hidden(&p)
    })
}

/// Find comics under `root`: archives in root and one subdirectory, plus image folders.
pub fn discover_comics(root: &Path) -> Vec<PathBuf> {
    let mut archives = Vec::new();
    let mut image_dirs = Vec::new();
    let mut root_has_images = false;

    let Ok(rd) = std::fs::read_dir(root) else {
        return vec![];
    };
    for ent in rd.flatten() {
        let p = ent.path();
        if is_hidden(&p) {
            continue;
        }
        if p.is_file() {
            if is_comic_archive(&p) {
                if looks_like_enhance_output(&p.file_name().unwrap_or_default().to_string_lossy()) {
                    continue;
                }
                archives.push(p);
            } else if is_image_path(&p) {
                root_has_images = true;
            }
        } else if p.is_dir() {
            if dir_has_images(&p) {
                image_dirs.push(p.clone());
            }
            if let Ok(sub) = std::fs::read_dir(&p) {
                for s in sub.flatten() {
                    let sp = s.path();
                    if sp.is_file() && is_comic_archive(&sp) && !is_hidden(&sp) {
                        if looks_like_enhance_output(
                            &sp.file_name().unwrap_or_default().to_string_lossy(),
                        ) {
                            continue;
                        }
                        archives.push(sp);
                    }
                }
            }
        }
    }

    let mut out = archives;
    if out.is_empty() && image_dirs.is_empty() && root_has_images {
        out.push(root.to_path_buf());
    } else {
        out.extend(image_dirs);
    }
    out.sort();
    out.dedup();
    out
}

fn cover_dest(cover_dir: &Path, entry: &LibraryEntry) -> PathBuf {
    cover_dir.join(format!("{}.{}.jpg", entry.id, COVER_CACHE_TAG))
}

fn cover_file_ok(path: Option<&str>) -> bool {
    path.map(|p| {
        let p = Path::new(p);
        p.is_file() && p.metadata().map(|m| m.len() > 32).unwrap_or(false)
    })
    .unwrap_or(false)
}

fn ensure_cover(entry: &LibraryEntry, cover_dir: &Path, cfg: &AppConfig) -> AppResult<PathBuf> {
    std::fs::create_dir_all(cover_dir)?;
    let dest = cover_dest(cover_dir, entry);
    if dest.is_file() && dest.metadata().map(|m| m.len() > 32).unwrap_or(false) {
        return Ok(dest);
    }
    // 旧版缓存或损坏文件：删掉重做
    if dest.exists() {
        let _ = std::fs::remove_file(&dest);
    }
    let src = PathBuf::from(&entry.path);
    let kind = SourceKind::detect(&src);
    let extracted = if matches!(kind, SourceKind::Mobi) {
        crate::ebook::mobi_cover_bytes(&src).and_then(|bytes| write_cover_from_bytes(&bytes, &dest))
    } else {
        // 前几页尝试：首页可能是空白/版权页或抽取失败
        try_cover_from_pages(&src, cfg, &dest)
    };
    if let Err(e) = extracted {
        tracing::warn!(
            error = %e.message,
            path = %src.display(),
            "cover extract failed, using placeholder"
        );
        write_placeholder_cover(&entry.title, &dest)?;
    }
    Ok(dest)
}

/// 依次尝试第 0..N 页作为封面，直到成功解码并写出 JPEG。
fn try_cover_from_pages(source: &Path, cfg: &AppConfig, dest: &Path) -> AppResult<()> {
    let max_try = 8u32;
    let mut last_err = AppError::unsupported("无法抽取封面页");
    for idx in 0..max_try {
        match crate::reader::resolve_source_page(source, idx, cfg) {
            Ok(page) => match write_cover_jpeg(Path::new(&page.path), dest) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    last_err = e;
                    // 失败的缓存文件清掉，避免下次短路
                    let _ = std::fs::remove_file(dest);
                }
            },
            Err(e) => last_err = e,
        }
    }
    // 回退旧逻辑：仅第一页路径
    match extract_first_page(source, cfg).and_then(|(_, page)| write_cover_jpeg(&page, dest)) {
        Ok(()) => Ok(()),
        Err(_) => Err(last_err),
    }
}

fn write_cover_from_bytes(bytes: &[u8], dest: &Path) -> AppResult<()> {
    let img = image::load_from_memory(bytes).map_err(|e| {
        AppError::new(crate::error::ErrorCode::DecodeFail, "封面解码失败")
            .with_detail(e.to_string())
    })?;
    encode_cover_jpeg(&img, dest)
}

fn write_placeholder_cover(title: &str, dest: &Path) -> AppResult<()> {
    let mut h: u32 = 2166136261;
    for b in title.as_bytes() {
        h ^= *b as u32;
        h = h.wrapping_mul(16777619);
    }
    let r = 40 + (h & 0x5f) as u8;
    let g = 45 + ((h >> 8) & 0x4f) as u8;
    let b = 70 + ((h >> 16) & 0x5f) as u8;
    let img = image::ImageBuffer::from_pixel(480, 720, image::Rgb([r, g, b]));
    encode_cover_jpeg(&image::DynamicImage::ImageRgb8(img), dest)
}

fn extract_first_page(source: &Path, cfg: &AppConfig) -> AppResult<(String, PathBuf)> {
    if source.is_dir() {
        let v = archive::validate_source(source, cfg)?;
        let name = v
            .page_names
            .first()
            .cloned()
            .ok_or_else(|| AppError::unsupported("文件夹中没有图片"))?;
        let p = source.join(&name);
        if p.is_file() {
            return Ok((name, p));
        }
    }
    crate::reader::resolve_source_page(source, 0, cfg).map(|f| (f.name, PathBuf::from(f.path)))
}

fn write_cover_jpeg(src: &Path, dest: &Path) -> AppResult<()> {
    encode_cover_jpeg(&image_io::load_image(src)?, dest)
}

fn encode_cover_jpeg(img: &image::DynamicImage, dest: &Path) -> AppResult<()> {
    // Lanczos3 keeps line art / text sharper than the default triangle filter.
    let thumb = img.resize(
        COVER_MAX_SIDE,
        COVER_MAX_SIDE,
        image::imageops::FilterType::Lanczos3,
    );
    let rgb = thumb.to_rgb8();
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = File::create(dest)?;
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, COVER_JPEG_QUALITY);
    enc.encode(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )
    .map_err(|e| {
        AppError::new(crate::error::ErrorCode::DecodeFail, "封面编码失败")
            .with_detail(e.to_string())
    })?;
    let _ = file.flush();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn cfg_tmp(dir: &Path) -> AppConfig {
        let c = AppConfig {
            work_root: dir.join("work"),
            ..Default::default()
        };
        c.ensure_dirs().unwrap();
        c
    }

    fn write_cbz(path: &Path, name: &str, bytes: &[u8]) {
        let f = File::create(path).unwrap();
        let mut w = ZipWriter::new(f);
        w.start_file(name, SimpleFileOptions::default()).unwrap();
        w.write_all(bytes).unwrap();
        w.finish().unwrap();
    }

    #[test]
    fn upsert_same_path_once() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = cfg_tmp(tmp.path());
        let folder = tmp.path().join("book");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("001.jpg"), b"x").unwrap();
        let mut store = LibraryStore::open(&cfg).unwrap();
        let a = store.upsert_path(&folder, &cfg).unwrap();
        let b = store.upsert_path(&folder, &cfg).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(store.list().len(), 1);
        assert!(PathBuf::from(&a.path).exists());
        assert!(folder.is_dir());
    }

    #[test]
    fn remove_does_not_delete_source() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = cfg_tmp(tmp.path());
        let folder = tmp.path().join("keep");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("001.png"), b"x").unwrap();
        let mut store = LibraryStore::open(&cfg).unwrap();
        let e = store.upsert_path(&folder, &cfg).unwrap();
        assert!(store.remove(&e.id).unwrap());
        assert!(folder.join("001.png").is_file());
        assert!(store.list().is_empty());
    }

    #[test]
    fn scan_finds_cbz_and_skips_enhance_output() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = cfg_tmp(tmp.path());
        let root = tmp.path().join("comics");
        std::fs::create_dir_all(root.join("vol2")).unwrap();
        write_cbz(&root.join("one.cbz"), "001.jpg", b"aa");
        write_cbz(&root.join("one_x2.cbz"), "001.jpg", b"bb");
        write_cbz(&root.join("vol2").join("two.cbz"), "001.jpg", b"cc");
        let found = discover_comics(&root);
        let names: Vec<_> = found
            .iter()
            .filter_map(|p| p.file_name().map(|s| s.to_string_lossy().into_owned()))
            .collect();
        assert!(names.iter().any(|n| n == "one.cbz"));
        assert!(names.iter().any(|n| n == "two.cbz"));
        assert!(!names.iter().any(|n| n.contains("_x2")));
        let mut store = LibraryStore::open(&cfg).unwrap();
        let preview = store.preview_scan(&root).unwrap();
        assert_eq!(preview.candidates.len(), 2);
        assert!(preview.candidates.iter().all(|c| !c.already_in_library));
        let only_one = vec![PathBuf::from(&preview.candidates[0].path)];
        let r = store.import_paths(&only_one, &cfg).unwrap();
        assert_eq!(r.added, 1);
        assert_eq!(store.list().len(), 1);
        let rest: Vec<_> = preview
            .candidates
            .iter()
            .map(|c| PathBuf::from(&c.path))
            .collect();
        let r2 = store.import_paths(&rest, &cfg).unwrap();
        assert_eq!(r2.added, 1);
        assert_eq!(r2.existed, 1);
        assert_eq!(store.list().len(), 2);
    }
}
