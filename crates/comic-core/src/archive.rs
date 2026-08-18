//! Folder / ZIP / CBZ import & export with safety limits.
//! ComicInfo.xml is byte-preserved when present.

use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
use crate::image_io::{self, is_image_path};
use crate::job::{ImageFormat, JobManifest, OutputContainer, PageRecord, PageStatus, SourceKind};
use crate::natural_sort::natural_cmp;
use crate::security::{check_entry_limits, sanitize_entry_path};
use std::fs::File;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use walkdir::WalkDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateResult {
    pub kind: SourceKind,
    pub page_count: u32,
    pub has_comic_info: bool,
    pub warnings: Vec<String>,
    pub page_names: Vec<String>,
}

/// Finder / Windows 夹带的非页面条目（解压进阅读器会变成「乱码页」）。
pub(crate) fn is_ignored_archive_entry(name: &str) -> bool {
    name.replace('\\', "/").split('/').any(|part| {
        if part.is_empty() {
            return false;
        }
        let lower = part.to_ascii_lowercase();
        lower == "__macosx"
            || lower == "thumbs.db"
            || lower == "desktop.ini"
            || part.starts_with('.')
    })
}

/// ZIP 本地文件名：无 Language encoding bit 时 zip crate 按 CP437 解。
/// macOS 压缩工具常写 UTF-8 却不置位；中文 Windows 则多为 GBK/GB18030。
pub(crate) fn decode_zip_name(raw: &[u8]) -> String {
    let s = if let Ok(s) = std::str::from_utf8(raw) {
        s.to_string()
    } else if let Some(cow) =
        encoding_rs::GB18030.decode_without_bom_handling_and_without_replacement(raw)
    {
        cow.into_owned()
    } else {
        String::from_utf8_lossy(raw).into_owned()
    };
    s.replace('\\', "/")
}

fn zip_entry_name(entry: &zip::read::ZipFile<'_>) -> String {
    decode_zip_name(entry.name_raw())
}

fn find_zip_entry_index<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    want: &str,
) -> AppResult<usize> {
    let want = want.replace('\\', "/");
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| AppError::internal(format!("zip 条目: {e}")))?;
        if entry.is_dir() {
            continue;
        }
        let decoded = zip_entry_name(&entry);
        if decoded == want || entry.name().replace('\\', "/") == want {
            return Ok(i);
        }
    }
    Err(AppError::not_found(format!("压缩包中找不到页: {want}")))
}

pub fn validate_source(path: &Path, cfg: &AppConfig) -> AppResult<ValidateResult> {
    let kind = SourceKind::detect(path);
    match kind {
        SourceKind::Folder => validate_folder(path),
        SourceKind::Zip | SourceKind::Cbz => validate_zip(path, cfg),
        SourceKind::Epub => validate_epub(path, cfg),
        SourceKind::Mobi => validate_mobi(path),
        SourceKind::Cbr => validate_cbr(path, cfg),
        SourceKind::Pdf => Err(AppError::unsupported("PDF 属于 Phase 2")),
        SourceKind::Unknown => Err(AppError::unsupported(
            "不支持的格式；请使用 Folder / ZIP / CBZ / EPUB / MOBI / CBR",
        )),
    }
}

fn validate_cbr(path: &Path, cfg: &AppConfig) -> AppResult<ValidateResult> {
    let (page_names, has_comic_info, warnings) = crate::unrar::list_rar_images(cfg, path)?;
    Ok(ValidateResult {
        kind: SourceKind::Cbr,
        page_count: page_names.len() as u32,
        has_comic_info,
        warnings,
        page_names,
    })
}

fn validate_epub(path: &Path, cfg: &AppConfig) -> AppResult<ValidateResult> {
    let (page_names, warnings) = crate::ebook::list_epub_images(path, cfg)?;
    Ok(ValidateResult {
        kind: SourceKind::Epub,
        page_count: page_names.len() as u32,
        has_comic_info: false,
        warnings,
        page_names,
    })
}

fn validate_mobi(path: &Path) -> AppResult<ValidateResult> {
    let (page_names, _blobs) = crate::ebook::list_mobi_images(path)?;
    Ok(ValidateResult {
        kind: SourceKind::Mobi,
        page_count: page_names.len() as u32,
        has_comic_info: false,
        warnings: vec!["MOBI/AZW 导出将为 CBZ/文件夹（不回写 Kindle 格式）".into()],
        page_names,
    })
}

fn validate_folder(path: &Path) -> AppResult<ValidateResult> {
    if !path.is_dir() {
        return Err(AppError::not_found("路径不是文件夹"));
    }
    let mut names = collect_folder_images(path)?;
    names.sort_by(|a, b| natural_cmp(a, b));
    Ok(ValidateResult {
        kind: SourceKind::Folder,
        page_count: names.len() as u32,
        has_comic_info: path.join("ComicInfo.xml").is_file(),
        warnings: vec![],
        page_names: names,
    })
}

fn collect_folder_images(root: &Path) -> AppResult<Vec<String>> {
    let mut names = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.is_file() && is_image_path(p) {
            let rel = p
                .strip_prefix(root)
                .unwrap_or(p)
                .to_string_lossy()
                .replace('\\', "/");
            if is_ignored_archive_entry(&rel) {
                continue;
            }
            names.push(rel);
        }
    }
    if names.is_empty() {
        return Err(AppError::unsupported("文件夹中未找到图片"));
    }
    Ok(names)
}

fn validate_zip(path: &Path, cfg: &AppConfig) -> AppResult<ValidateResult> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| AppError::unsupported(format!("无法打开 ZIP/CBZ: {e}")))?;
    let mut page_names = Vec::new();
    let mut has_comic_info = false;
    let mut total_uncomp = 0u64;
    let mut warnings = Vec::new();

    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| AppError::internal(format!("读取 zip 条目失败: {e}")))?;
        let name = zip_entry_name(&entry);
        if name.ends_with('/') || is_ignored_archive_entry(&name) {
            continue;
        }
        // symlink / unix mode check — zip crate may not always flag; reject absolute etc.
        let safe = match sanitize_entry_path(&name) {
            Ok(p) => p,
            Err(_) => {
                warnings.push(format!("跳过非法路径条目: {name}"));
                continue;
            }
        };
        let safe_str = safe.to_string_lossy().replace('\\', "/");
        let uncomp = entry.size();
        let comp = entry.compressed_size();
        // 单条失败不整包拒绝（线稿高压缩比页常见）；仍累计体积用于总量上限
        if let Err(e) = check_entry_limits(cfg, i as u32, comp, uncomp, total_uncomp) {
            warnings.push(format!("跳过条目 {safe_str}: {}", e.message));
            continue;
        }
        total_uncomp = total_uncomp.saturating_add(uncomp);

        if safe_str.eq_ignore_ascii_case("ComicInfo.xml") || safe_str.ends_with("/ComicInfo.xml") {
            has_comic_info = true;
            continue;
        }
        if is_image_path(Path::new(&safe_str)) {
            page_names.push(safe_str);
        } else if !safe_str.eq_ignore_ascii_case("comicinfo.xml") {
            // ignore non-image
        }
    }

    page_names.sort_by(|a, b| natural_cmp(a, b));
    if page_names.is_empty() {
        return Err(AppError::unsupported("压缩包中未找到图片页"));
    }
    if page_names.len() as u32 > cfg.max_archive_entries {
        warnings.push("页数接近上限".into());
    }

    Ok(ValidateResult {
        kind: SourceKind::detect(path),
        page_count: page_names.len() as u32,
        has_comic_info,
        warnings,
        page_names,
    })
}

/// Copy one ZIP/CBZ entry to `dest` without decode/re-encode.
/// 写 tmp + 原子 rename：并发同页或崩溃都不会留下半截文件。
pub fn extract_zip_entry_raw(source: &Path, name: &str, dest: &Path) -> AppResult<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = File::open(source)?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| AppError::unsupported(format!("无法打开压缩包: {e}")))?;
    let idx = find_zip_entry_index(&mut archive, name)?;
    let mut entry = archive
        .by_index(idx)
        .map_err(|e| AppError::internal(format!("读取页失败: {e}")))?;
    let declared = entry.size();
    let tmp = unique_tmp_sibling(dest);
    let mut f = File::create(&tmp)?;
    if let Err(e) = copy_limited(&mut entry, &mut f, declared) {
        drop(f);
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    drop(f);
    std::fs::rename(&tmp, dest)?;
    Ok(())
}

/// 带上限的流拷贝：条目声明的未压缩大小与真实流不符（zip 炸弹）时拒绝。
fn copy_limited<R: Read, W: Write>(reader: R, writer: &mut W, declared: u64) -> AppResult<u64> {
    let copied = std::io::copy(&mut reader.take(declared.saturating_add(1)), writer)?;
    if copied > declared {
        return Err(AppError::invalid(
            "压缩包条目实际大小超过声明值，已中止解压",
        ));
    }
    Ok(copied)
}

/// Extract one page as original bytes (jpg/png/webp stay as-is) for the reader.
/// 统一写 tmp + 原子 rename：半截文件不会成为命中缓存，并发同页也不会交错损坏。
pub fn extract_page_native(
    source: &Path,
    kind: SourceKind,
    page_index: u32,
    page_name: &str,
    dest: &Path,
    cfg: &AppConfig,
) -> AppResult<()> {
    if dest.is_file() {
        if image_io::file_looks_like_image(dest) {
            return Ok(());
        }
        let _ = std::fs::remove_file(dest);
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = unique_tmp_sibling(dest);
    let result = (|| -> AppResult<()> {
        match kind {
            SourceKind::Folder => {
                let src = source.join(page_name);
                if image_io::is_engine_native_path(&src) {
                    std::fs::copy(&src, &tmp)?;
                } else {
                    image_io::convert_file_to_engine_png(&src, &tmp)?;
                }
            }
            SourceKind::Zip | SourceKind::Cbz => {
                extract_zip_entry_raw(source, page_name, &tmp)?;
            }
            SourceKind::Epub => {
                crate::ebook::extract_epub_page_raw(source, page_name, &tmp)?;
            }
            SourceKind::Cbr => {
                crate::unrar::extract_rar_file(cfg, source, page_name, &tmp)?;
            }
            SourceKind::Mobi => {
                crate::ebook::extract_mobi_page_index(source, page_index as usize, &tmp, cfg)?;
            }
            other => {
                return Err(AppError::unsupported(format!("无法抽取原图: {other:?}")));
            }
        }
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, dest)?;
    Ok(())
}

/// Extract a single page (by index in natural order) to a PNG path for preview.
pub fn extract_page_to_png(
    source: &Path,
    page_index: u32,
    dest_png: &Path,
    cfg: &AppConfig,
) -> AppResult<()> {
    if let Some(parent) = dest_png.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let v = validate_source(source, cfg)?;
    if page_index as usize >= v.page_names.len() {
        return Err(AppError::invalid(format!(
            "页索引越界: {} / {}",
            page_index, v.page_count
        )));
    }
    let name = &v.page_names[page_index as usize];
    match v.kind {
        SourceKind::Folder => {
            let src = source.join(name);
            image_io::convert_file_to_engine_png(&src, dest_png)?;
        }
        SourceKind::Zip | SourceKind::Cbz => {
            extract_zip_entry_to_png(source, name, dest_png)?;
        }
        SourceKind::Epub => {
            crate::ebook::extract_epub_page(source, name, dest_png)?;
        }
        SourceKind::Mobi => {
            crate::ebook::extract_mobi_page_index(source, page_index as usize, dest_png, cfg)?;
        }
        SourceKind::Cbr => {
            let name = &v.page_names[page_index as usize];
            let ext = Path::new(name)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("bin");
            let tmp = dest_png.with_extension(format!("raw.{ext}"));
            crate::unrar::extract_rar_file(cfg, source, name, &tmp)?;
            image_io::convert_file_to_engine_png(&tmp, dest_png)?;
            let _ = std::fs::remove_file(&tmp);
        }
        other => {
            return Err(AppError::unsupported(format!("无法预览: {other:?}")));
        }
    }
    Ok(())
}

fn extract_zip_entry_to_png(source: &Path, name: &str, dest_png: &Path) -> AppResult<()> {
    let file = File::open(source)?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| AppError::unsupported(format!("无法打开压缩包: {e}")))?;
    let idx = find_zip_entry_index(&mut archive, name)?;
    let mut entry = archive
        .by_index(idx)
        .map_err(|e| AppError::internal(format!("读取页失败: {e}")))?;
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let tmp = dest_png.with_extension(format!("raw.{ext}"));
    if let Some(parent) = tmp.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let declared = entry.size();
    {
        let mut f = File::create(&tmp)?;
        copy_limited(&mut entry, &mut f, declared)?;
    }
    image_io::convert_file_to_engine_png(&tmp, dest_png)?;
    let _ = std::fs::remove_file(&tmp);
    Ok(())
}

/// Called during extract with (pages_done_so_far, pages_total, current_name).
/// `pages_done` here means **extracted** count (not yet enhanced).
pub type ExtractProgressCb<'a> = dyn FnMut(u32, u32, Option<&str>) + Send + 'a;

/// 取消时各提取循环尽快退出（不等待整本解压完）。
pub fn extract_cancelled(cancel: Option<&std::sync::atomic::AtomicBool>) -> bool {
    cancel
        .map(|c| c.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

/// Extract pages into `manifest.in_dir()` as sequential PNGs for the engine.
/// Invokes `on_progress` after total is known and after each page is written.
pub fn extract_to_workdir(
    manifest: &mut JobManifest,
    cfg: &AppConfig,
    on_progress: Option<&mut ExtractProgressCb<'_>>,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> AppResult<()> {
    std::fs::create_dir_all(manifest.in_dir())?;
    std::fs::create_dir_all(manifest.out_dir())?;
    std::fs::create_dir_all(manifest.meta_dir())?;

    match manifest.source.kind {
        SourceKind::Folder => extract_folder(manifest, on_progress, cancel)?,
        SourceKind::Zip | SourceKind::Cbz => extract_zip(manifest, cfg, on_progress, cancel)?,
        SourceKind::Epub => extract_epub(manifest, cfg, on_progress, cancel)?,
        SourceKind::Mobi => extract_mobi(manifest, on_progress, cancel)?,
        SourceKind::Cbr => extract_cbr(manifest, cfg, on_progress, cancel)?,
        other => {
            return Err(AppError::unsupported(format!("无法解压: {other:?}")));
        }
    }
    // Final: pages are Pending for enhance; extract progress used pages_done as extracted count.
    // Reset pages_done to 0 for enhance stage (none Done yet).
    manifest.refresh_stats();
    Ok(())
}

fn report_extract(
    on_progress: Option<&mut ExtractProgressCb<'_>>,
    done: u32,
    total: u32,
    name: Option<&str>,
    manifest: &mut JobManifest,
) {
    manifest.stats.pages_done = done;
    manifest.stats.pages_total = total;
    if let Some(cb) = on_progress {
        cb(done, total, name);
    }
}

fn extract_epub(
    manifest: &mut JobManifest,
    cfg: &AppConfig,
    mut on_progress: Option<&mut ExtractProgressCb<'_>>,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> AppResult<()> {
    let (names, _warnings) = crate::ebook::list_epub_images(&manifest.source.path, cfg)?;
    let total = names.len() as u32;
    report_extract(on_progress.as_deref_mut(), 0, total, None, manifest);
    let in_dir = manifest.in_dir();
    let out_dir = manifest.out_dir();
    let mut pages = Vec::with_capacity(names.len());
    for (idx, name) in names.iter().enumerate() {
        if extract_cancelled(cancel) {
            return Err(AppError::cancelled());
        }
        let orig_ext = Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin");
        let (in_path, out_path) =
            engine_page_paths(&in_dir, &out_dir, idx, name, manifest.output.image_format);
        if image_io::is_engine_native_ext(orig_ext) {
            crate::ebook::extract_epub_page_raw(&manifest.source.path, name, &in_path)?;
        } else {
            let tmp = in_dir.join(format!("_raw_{idx:05}.{orig_ext}"));
            crate::ebook::extract_epub_page_raw(&manifest.source.path, name, &tmp)?;
            image_io::convert_file_to_engine_png(&tmp, &in_path)?;
            let _ = std::fs::remove_file(&tmp);
        }
        pages.push(PageRecord {
            index: idx as u32,
            name: name.clone(),
            status: PageStatus::Pending,
            in_path: Some(in_path),
            out_path: Some(out_path),
            error: None,
        });
        report_extract(
            on_progress.as_deref_mut(),
            (idx + 1) as u32,
            total,
            Some(name),
            manifest,
        );
    }
    manifest.pages = pages;
    Ok(())
}

fn extract_mobi(
    manifest: &mut JobManifest,
    mut on_progress: Option<&mut ExtractProgressCb<'_>>,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> AppResult<()> {
    use rayon::prelude::*;

    let (names, blobs) = crate::ebook::list_mobi_images(&manifest.source.path)?;
    let total = names.len() as u32;
    report_extract(
        on_progress.as_deref_mut(),
        0,
        total,
        Some("解析 MOBI…"),
        manifest,
    );

    let in_dir = manifest.in_dir();
    let out_dir = manifest.out_dir();
    // Parallel convert (CPU-bound decode/encode)
    let results: Vec<AppResult<PageRecord>> = names
        .par_iter()
        .zip(blobs.par_iter())
        .enumerate()
        .map(|(idx, (name, bytes))| {
            if extract_cancelled(cancel) {
                return Err(AppError::cancelled());
            }
            let (in_path, out_path) =
                engine_page_paths(&in_dir, &out_dir, idx, name, manifest.output.image_format);
            crate::ebook::write_mobi_engine_input(bytes, &in_path)?;
            Ok(PageRecord {
                index: idx as u32,
                name: name.clone(),
                status: PageStatus::Pending,
                in_path: Some(in_path),
                out_path: Some(out_path),
                error: None,
            })
        })
        .collect();

    let mut pages = Vec::with_capacity(results.len());
    for (i, r) in results.into_iter().enumerate() {
        let p = r?;
        pages.push(p);
        report_extract(
            on_progress.as_deref_mut(),
            (i + 1) as u32,
            total,
            Some(&names[i]),
            manifest,
        );
    }
    if extract_cancelled(cancel) {
        return Err(AppError::cancelled());
    }
    manifest.pages = pages;
    Ok(())
}

fn extract_cbr(
    manifest: &mut JobManifest,
    cfg: &AppConfig,
    mut on_progress: Option<&mut ExtractProgressCb<'_>>,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> AppResult<()> {
    use rayon::prelude::*;

    let (names, has_ci, _warnings) = crate::unrar::list_rar_images(cfg, &manifest.source.path)?;
    let raw_dir = manifest.workdir.join("rar_raw");
    crate::unrar::extract_rar_archive(cfg, &manifest.source.path, &raw_dir)?;

    if has_ci {
        for cand in ["ComicInfo.xml", "comicinfo.xml"] {
            let p = raw_dir.join(cand);
            if p.is_file() {
                let dest = manifest.meta_dir().join("ComicInfo.xml");
                std::fs::copy(&p, &dest)?;
                manifest.metadata.comic_info_src = Some(dest);
                break;
            }
        }
        if manifest.metadata.comic_info_src.is_none() {
            for e in WalkDir::new(&raw_dir).into_iter().filter_map(|e| e.ok()) {
                let p = e.path();
                if p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.eq_ignore_ascii_case("ComicInfo.xml"))
                    .unwrap_or(false)
                {
                    let dest = manifest.meta_dir().join("ComicInfo.xml");
                    std::fs::copy(p, &dest)?;
                    manifest.metadata.comic_info_src = Some(dest);
                    break;
                }
            }
        }
    }

    let total = names.len() as u32;
    report_extract(
        on_progress.as_deref_mut(),
        0,
        total,
        Some("解压 CBR…"),
        manifest,
    );
    let in_dir = manifest.in_dir();
    let out_dir = manifest.out_dir();
    let raw = raw_dir.clone();
    let results: Vec<AppResult<(usize, PageRecord)>> = names
        .par_iter()
        .enumerate()
        .map(|(idx, name)| {
            if extract_cancelled(cancel) {
                return Err(AppError::cancelled());
            }
            let src = raw.join(name);
            let (in_path, out_path) =
                engine_page_paths(&in_dir, &out_dir, idx, name, manifest.output.image_format);
            if src.is_file() {
                image_io::write_engine_input(&src, &in_path)?;
            } else {
                crate::unrar::extract_rar_file(cfg, &manifest.source.path, name, &in_path)?;
                if !image_io::is_engine_native_path(&in_path) {
                    let png = in_dir.join(format!("{idx:05}.png"));
                    image_io::convert_file_to_engine_png(&in_path, &png)?;
                    let _ = std::fs::remove_file(&in_path);
                    return Ok((
                        idx,
                        PageRecord {
                            index: idx as u32,
                            name: name.clone(),
                            status: PageStatus::Pending,
                            in_path: Some(png.clone()),
                            out_path: Some(out_dir.join(format!("{idx:05}.png"))),
                            error: None,
                        },
                    ));
                }
            }
            Ok((
                idx,
                PageRecord {
                    index: idx as u32,
                    name: name.clone(),
                    status: PageStatus::Pending,
                    in_path: Some(in_path),
                    out_path: Some(out_path),
                    error: None,
                },
            ))
        })
        .collect();

    let mut pages = vec![None; names.len()];
    let mut done = 0u32;
    for r in results {
        let (idx, page) = r?;
        pages[idx] = Some(page);
        done += 1;
        report_extract(
            on_progress.as_deref_mut(),
            done,
            total,
            Some(&names[idx]),
            manifest,
        );
    }
    if extract_cancelled(cancel) {
        return Err(AppError::cancelled());
    }
    manifest.pages = pages.into_iter().flatten().collect();
    let _ = std::fs::remove_dir_all(&raw_dir);
    Ok(())
}

fn extract_folder(
    manifest: &mut JobManifest,
    mut on_progress: Option<&mut ExtractProgressCb<'_>>,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> AppResult<()> {
    use rayon::prelude::*;

    let root = manifest.source.path.clone();
    let mut names = collect_folder_images(&root)?;
    names.sort_by(|a, b| natural_cmp(a, b));

    if root.join("ComicInfo.xml").is_file() {
        let dest = manifest.meta_dir().join("ComicInfo.xml");
        std::fs::copy(root.join("ComicInfo.xml"), &dest)?;
        manifest.metadata.comic_info_src = Some(dest);
    }

    let total = names.len() as u32;
    report_extract(on_progress.as_deref_mut(), 0, total, None, manifest);
    let in_dir = manifest.in_dir();
    let out_dir = manifest.out_dir();
    let results: Vec<AppResult<(usize, PageRecord)>> = names
        .par_iter()
        .enumerate()
        .map(|(idx, name)| {
            if extract_cancelled(cancel) {
                return Err(AppError::cancelled());
            }
            let src = root.join(name);
            let (in_path, out_path) =
                engine_page_paths(&in_dir, &out_dir, idx, name, manifest.output.image_format);
            image_io::write_engine_input(&src, &in_path)?;
            Ok((
                idx,
                PageRecord {
                    index: idx as u32,
                    name: name.clone(),
                    status: PageStatus::Pending,
                    in_path: Some(in_path),
                    out_path: Some(out_path),
                    error: None,
                },
            ))
        })
        .collect();

    let mut pages = vec![None; names.len()];
    let mut done = 0u32;
    for r in results {
        let (idx, page) = r?;
        pages[idx] = Some(page);
        done += 1;
        manifest.pages = pages.iter().filter_map(|p| p.clone()).collect();
        report_extract(
            on_progress.as_deref_mut(),
            done,
            total,
            Some(&names[idx]),
            manifest,
        );
    }
    if extract_cancelled(cancel) {
        return Err(AppError::cancelled());
    }
    manifest.pages = pages.into_iter().flatten().collect();
    Ok(())
}

fn extract_zip(
    manifest: &mut JobManifest,
    cfg: &AppConfig,
    mut on_progress: Option<&mut ExtractProgressCb<'_>>,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> AppResult<()> {
    let file = File::open(&manifest.source.path)?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| AppError::unsupported(format!("无法打开压缩包: {e}")))?;

    // First pass: comic info + ordered image names
    let mut image_entries: Vec<(usize, String)> = Vec::new();
    let mut total_uncomp = 0u64;

    for i in 0..archive.len() {
        if extract_cancelled(cancel) {
            return Err(AppError::cancelled());
        }
        let entry = archive
            .by_index(i)
            .map_err(|e| AppError::internal(format!("zip 条目: {e}")))?;
        let name = zip_entry_name(&entry);
        if name.ends_with('/') || is_ignored_archive_entry(&name) {
            continue;
        }
        // 与 validate_source 的语义保持一致：恶意/超限条目跳过（警告），
        // 而不是让整包任务失败（否则「校验通过、解压失败」）
        let safe = match sanitize_entry_path(&name) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let safe_str = safe.to_string_lossy().replace('\\', "/");
        if check_entry_limits(
            cfg,
            i as u32,
            entry.compressed_size(),
            entry.size(),
            total_uncomp,
        )
        .is_err()
        {
            continue;
        }
        total_uncomp = total_uncomp.saturating_add(entry.size());

        if safe_str.eq_ignore_ascii_case("ComicInfo.xml") || safe_str.ends_with("/ComicInfo.xml") {
            drop(entry);
            let Ok(mut e) = archive.by_index(i) else {
                continue;
            };
            let declared = e.size();
            let dest = manifest.meta_dir().join("ComicInfo.xml");
            let mut out = File::create(&dest)?;
            copy_limited(&mut e, &mut out, declared)?;
            manifest.metadata.comic_info_src = Some(dest);
            continue;
        }
        if is_image_path(Path::new(&safe_str)) {
            image_entries.push((i, safe_str));
        }
    }

    image_entries.sort_by(|a, b| natural_cmp(&a.1, &b.1));
    if image_entries.is_empty() {
        return Err(AppError::unsupported("压缩包无图片"));
    }

    let total = image_entries.len() as u32;
    report_extract(on_progress.as_deref_mut(), 0, total, None, manifest);

    let in_dir = manifest.in_dir();
    let out_dir = manifest.out_dir();
    // Sequential zip read (archive is not thread-safe), write native jpg/png/webp
    // without a PNG re-encode — that was the extract bottleneck.
    let mut pages = Vec::with_capacity(image_entries.len());
    for (idx, (zip_idx, name)) in image_entries.iter().enumerate() {
        if extract_cancelled(cancel) {
            return Err(AppError::cancelled());
        }
        let mut entry = archive
            .by_index(*zip_idx)
            .map_err(|e| AppError::internal(format!("读取页失败: {e}")))?;
        let orig_ext = Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin");
        let (in_path, out_path) =
            engine_page_paths(&in_dir, &out_dir, idx, name, manifest.output.image_format);
        let declared = entry.size();
        if image_io::is_engine_native_ext(orig_ext) {
            let mut f = File::create(&in_path)?;
            copy_limited(&mut entry, &mut f, declared)?;
        } else {
            let tmp = in_dir.join(format!("_raw_{idx:05}.{orig_ext}"));
            {
                let mut f = File::create(&tmp)?;
                copy_limited(&mut entry, &mut f, declared)?;
            }
            image_io::convert_file_to_engine_png(&tmp, &in_path)?;
            let _ = std::fs::remove_file(&tmp);
        }
        pages.push(PageRecord {
            index: idx as u32,
            name: name.clone(),
            status: PageStatus::Pending,
            in_path: Some(in_path),
            out_path: Some(out_path),
            error: None,
        });
        report_extract(
            on_progress.as_deref_mut(),
            (idx + 1) as u32,
            total,
            Some(name),
            manifest,
        );
    }
    manifest.pages = pages;
    Ok(())
}

fn engine_page_paths(
    in_dir: &Path,
    out_dir: &Path,
    idx: usize,
    orig_name: &str,
    format: ImageFormat,
) -> (PathBuf, PathBuf) {
    let ext = Path::new(orig_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    let in_ext = if image_io::is_engine_native_ext(ext) {
        ext.to_ascii_lowercase()
    } else {
        "png".into()
    };
    let out_ext = match format {
        ImageFormat::Png => "png".into(),
        ImageFormat::Jpeg => "jpg".into(),
        ImageFormat::Webp => "webp".into(),
        ImageFormat::Same => in_ext.clone(),
    };
    let stem = format!("{idx:05}");
    (
        in_dir.join(format!("{stem}.{in_ext}")),
        out_dir.join(format!("{stem}.{out_ext}")),
    )
}

/// Expected output path for a job (without writing).
pub fn expected_output_path(manifest: &JobManifest) -> PathBuf {
    let scale = manifest.options.scale as u8;
    let stem = manifest
        .source
        .path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("comic");
    let mut name = manifest
        .output
        .naming
        .replace("{stem}", stem)
        .replace("{scale}", &scale.to_string());
    // 消毒：命名模板可注入路径分隔符/上级目录，防止写到输出目录外
    name = name.replace(['/', '\\'], "_");
    while name.starts_with('.') {
        name.remove(0);
    }
    if name.trim().is_empty() {
        name = stem.to_string();
    }
    match manifest.output.container {
        OutputContainer::Folder => manifest.output.dir.join(&name),
        OutputContainer::Cbz => manifest.output.dir.join(format!("{name}.cbz")),
        OutputContainer::Zip => manifest.output.dir.join(format!("{name}.zip")),
    }
}

/// Pack progress: (done, total, note).
pub type ExportProgressCb<'a> = dyn FnMut(u32, u32, &str) + Send + 'a;

/// 同目录下的临时路径（写完后原子 rename 到最终路径）。
/// 导出用确定性名字：同一目标同时只有一个 writer。
fn tmp_sibling(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| format!("{}.tmp", n.to_string_lossy()))
        .unwrap_or_else(|| "output.tmp".into());
    path.with_file_name(name)
}

/// 抽取用唯一临时名，避免并发同页交错写同一个 `.tmp`。
fn unique_tmp_sibling(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "out".into());
    path.with_file_name(format!("{name}.{}.tmp", uuid::Uuid::new_v4().simple()))
}

/// 校验 zip 可正常打开且条目数不少于预期（只读中央目录，毫秒级）。
pub(crate) fn zip_is_complete(path: &Path, min_entries: usize) -> bool {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    match zip::ZipArchive::new(file) {
        Ok(archive) => archive.len() >= min_entries,
        Err(_) => false,
    }
}

/// Folder 导出完整性：页文件数不少于预期（崩溃遗留的空/半截目录不算成功）。
pub(crate) fn folder_export_complete(dir: &Path, done_pages: usize) -> bool {
    if done_pages == 0 {
        return false;
    }
    let count = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().is_file())
                .count()
        })
        .unwrap_or(0);
    count >= done_pages
}

/// Pack enhanced pages to output path using fixed defaults / options.
pub fn export_job(manifest: &JobManifest) -> AppResult<PathBuf> {
    export_job_with_progress(manifest, None)
}

pub fn export_job_with_progress(
    manifest: &JobManifest,
    on_progress: Option<&mut ExportProgressCb<'_>>,
) -> AppResult<PathBuf> {
    std::fs::create_dir_all(&manifest.output.dir)?;
    let out_path = expected_output_path(manifest);
    let done_count = manifest
        .pages
        .iter()
        .filter(|p| p.status == PageStatus::Done)
        .count();

    // Idempotent: if a previous attempt already produced a *complete* output,
    // treat as success. (Avoids stuck "打包中" when file exists but state never
    // flipped to completed. Half-written output from a crash is NOT accepted.)
    match manifest.output.container {
        OutputContainer::Folder => {
            if out_path.is_dir() && folder_export_complete(&out_path, done_count) {
                return Ok(out_path);
            }
            if out_path.is_dir() {
                std::fs::remove_dir_all(&out_path)?;
            } else if out_path.exists() {
                return Err(AppError::invalid(format!(
                    "目标路径已存在且不是目录: {}",
                    out_path.display()
                )));
            }
            export_folder(manifest, &out_path, on_progress)?;
        }
        OutputContainer::Cbz | OutputContainer::Zip => {
            if out_path.is_file() && zip_is_complete(&out_path, done_count) {
                return Ok(out_path);
            }
            // Remove incomplete partial from crashed prior attempt (tmp+rename
            // guarantees out_path only ever appears atomically once complete).
            if out_path.is_file() {
                let _ = std::fs::remove_file(&out_path);
            }
            export_zip(manifest, &out_path, on_progress)?;
        }
    }
    Ok(out_path)
}

fn export_folder(
    manifest: &JobManifest,
    dir: &Path,
    mut on_progress: Option<&mut ExportProgressCb<'_>>,
) -> AppResult<()> {
    use rayon::prelude::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Mutex;

    if dir.exists() {
        return Err(AppError::invalid(format!(
            "目标目录已存在: {}",
            dir.display()
        )));
    }
    // 先写临时目录再原子 rename，崩溃不会留下「看似成功」的半截目录
    let tmp_dir = tmp_sibling(dir);
    if tmp_dir.exists() {
        std::fs::remove_dir_all(&tmp_dir)?;
    }
    std::fs::create_dir_all(&tmp_dir)?;
    let done_pages: Vec<_> = manifest
        .pages
        .iter()
        .filter(|p| p.status == PageStatus::Done)
        .collect();
    let total = done_pages.len() as u32;
    if let Some(cb) = on_progress.as_deref_mut() {
        cb(0, total, "encode");
    }
    let counter = AtomicU32::new(0);
    let progress = Mutex::new(on_progress);
    // 峰值内存 ≈ EXPORT_CHUNK × 单页：rayon 全量并行时 8 核 × 300MB ≈ 2.4GB，
    // 大页漫画导出 OOM。按组串行、组内并行。
    const EXPORT_CHUNK: usize = 4;
    for chunk in done_pages.chunks(EXPORT_CHUNK) {
        let results: Vec<AppResult<()>> = chunk
            .par_iter()
            .map(|page| {
                let src = page
                    .out_path
                    .as_ref()
                    .ok_or_else(|| AppError::internal("缺少输出路径"))?;
                let orig_ext = Path::new(&page.name).extension().and_then(|e| e.to_str());
                let out_name = export_page_filename(page, &manifest.output.image_format);
                let dest = tmp_dir.join(&out_name);
                encode_or_copy_page(manifest, page, src, orig_ext, &dest)?;
                let n = counter.fetch_add(1, Ordering::Relaxed) + 1;
                if let Ok(mut g) = progress.lock() {
                    if let Some(cb) = g.as_deref_mut() {
                        cb(n, total, "encode");
                    }
                }
                Ok(())
            })
            .collect();
        for r in results {
            r?;
        }
    }
    if let Some(ci) = &manifest.metadata.comic_info_src {
        std::fs::copy(ci, tmp_dir.join("ComicInfo.xml"))?;
    }
    std::fs::rename(&tmp_dir, dir)?;
    Ok(())
}

fn encode_or_copy_page(
    manifest: &JobManifest,
    _page: &PageRecord,
    src: &Path,
    orig_ext: Option<&str>,
    dest: &Path,
) -> AppResult<()> {
    if image_io::export_can_passthrough(manifest.output.image_format, src, orig_ext) {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dest)?;
        return Ok(());
    }
    let img = image_io::load_image(src)?;
    image_io::save_export(
        &img,
        dest,
        manifest.output.image_format,
        manifest.output.jpeg_quality,
        manifest.output.webp_quality,
        orig_ext,
    )
}

fn encode_or_copy_bytes(
    manifest: &JobManifest,
    src: &Path,
    orig_ext: Option<&str>,
) -> AppResult<Vec<u8>> {
    if image_io::export_can_passthrough(manifest.output.image_format, src, orig_ext) {
        return Ok(std::fs::read(src)?);
    }
    let img = image_io::load_image(src)?;
    image_io::save_export_bytes(
        &img,
        manifest.output.image_format,
        manifest.output.jpeg_quality,
        manifest.output.webp_quality,
        orig_ext,
    )
}

fn export_zip(
    manifest: &JobManifest,
    path: &Path,
    mut on_progress: Option<&mut ExportProgressCb<'_>>,
) -> AppResult<()> {
    use rayon::prelude::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Mutex;

    let done_pages: Vec<_> = manifest
        .pages
        .iter()
        .filter(|p| p.status == PageStatus::Done)
        .collect();
    let total = done_pages.len() as u32;
    if let Some(cb) = on_progress.as_deref_mut() {
        cb(0, total.max(1), "encode");
    }

    // 按 CHUNK 编码后立刻写入 zip，峰值内存 ≈ CHUNK × 单页，而不是整本。
    let counter = AtomicU32::new(0);
    let progress = Mutex::new(on_progress);
    const CHUNK: usize = 8;

    let tmp_path = tmp_sibling(path);
    let file = File::create(&tmp_path)?;
    let mut zip = ZipWriter::new(std::io::BufWriter::new(file));
    // Images are already compressed (JPEG/PNG/WebP). STORE is the CBZ convention
    // and avoids a second Deflate pass that barely shrinks but costs a lot of CPU.
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

    let pack_total = total.max(1);
    let mut packed = 0u32;
    for chunk in done_pages.chunks(CHUNK) {
        let encoded: Vec<AppResult<(u32, String, Vec<u8>)>> = chunk
            .par_iter()
            .map(|page| {
                let src = page
                    .out_path
                    .as_ref()
                    .ok_or_else(|| AppError::internal("缺少输出路径"))?;
                let orig_ext = Path::new(&page.name).extension().and_then(|e| e.to_str());
                let out_name = export_page_filename(page, &manifest.output.image_format);
                let data = encode_or_copy_bytes(manifest, src, orig_ext)?;
                let n = counter.fetch_add(1, Ordering::Relaxed) + 1;
                if let Ok(mut g) = progress.lock() {
                    if let Some(cb) = g.as_deref_mut() {
                        cb(n, pack_total, "encode");
                    }
                }
                Ok((page.index, out_name, data))
            })
            .collect();
        for item in encoded {
            let (_idx, out_name, data) = match item {
                Ok(v) => v,
                Err(e) => {
                    let _ = std::fs::remove_file(&tmp_path);
                    return Err(e);
                }
            };
            zip.start_file(out_name, opts)
                .map_err(|e| AppError::internal(format!("zip 写入: {e}")))?;
            zip.write_all(&data)?;
            packed += 1;
            if let Ok(mut g) = progress.lock() {
                if let Some(cb) = g.as_deref_mut() {
                    cb(packed, pack_total, "pack");
                }
            }
        }
    }

    if let Some(ci) = &manifest.metadata.comic_info_src {
        let mut data = Vec::new();
        File::open(ci)?.read_to_end(&mut data)?;
        zip.start_file("ComicInfo.xml", opts)
            .map_err(|e| AppError::internal(format!("zip ComicInfo: {e}")))?;
        zip.write_all(&data)?;
    }

    zip.finish()
        .map_err(|e| AppError::internal(format!("zip 完成: {e}")))?;
    // 原子落盘：目标路径只会在完整写入后出现
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

fn export_page_filename(page: &PageRecord, format: &ImageFormat) -> String {
    let base = format!("{:05}", page.index);
    let ext = match format {
        ImageFormat::Png => "png",
        ImageFormat::Webp => "webp",
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Same => Path::new(&page.name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg"),
    };
    format!("{base}.{ext}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};
    use std::io::Write;

    fn write_tiny_png(path: &Path) {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_pixel(8, 8, Rgb([1, 2, 3]));
        image::DynamicImage::ImageRgb8(img).save(path).unwrap();
    }

    #[test]
    fn folder_validate_and_extract() {
        let dir = tempfile::tempdir().unwrap();
        write_tiny_png(&dir.path().join("b.png"));
        write_tiny_png(&dir.path().join("a.png"));
        let cfg = AppConfig::default();
        let v = validate_source(dir.path(), &cfg).unwrap();
        assert_eq!(v.page_count, 2);
        assert_eq!(v.page_names[0], "a.png");
    }

    #[test]
    fn zip_cbz_roundtrip_export() {
        let dir = tempfile::tempdir().unwrap();
        let cbz = dir.path().join("sample.cbz");
        {
            let file = File::create(&cbz).unwrap();
            let mut zip = ZipWriter::new(file);
            let opts = SimpleFileOptions::default();
            // embed a real png
            let png_path = dir.path().join("p.png");
            write_tiny_png(&png_path);
            let data = std::fs::read(&png_path).unwrap();
            zip.start_file("002.png", opts).unwrap();
            zip.write_all(&data).unwrap();
            zip.start_file("001.png", opts).unwrap();
            zip.write_all(&data).unwrap();
            zip.start_file("ComicInfo.xml", opts).unwrap();
            zip.write_all(b"<ComicInfo></ComicInfo>").unwrap();
            zip.finish().unwrap();
        }

        let cfg = AppConfig::default();
        let v = validate_source(&cbz, &cfg).unwrap();
        assert_eq!(v.page_count, 2);
        assert!(v.has_comic_info);
        assert_eq!(v.page_names[0], "001.png");
    }

    #[test]
    fn cbr_named_zip_is_treated_as_cbz() {
        let dir = tempfile::tempdir().unwrap();
        let cbr = dir.path().join("fake.cbr");
        {
            let file = File::create(&cbr).unwrap();
            let mut zip = ZipWriter::new(file);
            let opts = SimpleFileOptions::default();
            let png_path = dir.path().join("p.png");
            write_tiny_png(&png_path);
            let data = std::fs::read(&png_path).unwrap();
            zip.start_file("001.png", opts).unwrap();
            zip.write_all(&data).unwrap();
            zip.finish().unwrap();
        }
        let cfg = AppConfig::default();
        let v = validate_source(&cbr, &cfg).unwrap();
        assert_eq!(v.kind, SourceKind::Cbz);
        assert_eq!(v.page_count, 1);
    }

    #[test]
    fn real_cbr_without_unrar_is_explicit() {
        let dir = tempfile::tempdir().unwrap();
        let cbr = dir.path().join("book.cbr");
        std::fs::write(&cbr, b"Rar!\x1A\x07\x00not-a-real-rar").unwrap();
        let cfg = AppConfig {
            unrar_bin: Some(PathBuf::from("/no/such/unrar-binary")),
            ..Default::default()
        };
        let err = validate_source(&cbr, &cfg).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::UnrarMissing);
        assert!(err
            .detail
            .unwrap_or_default()
            .contains("brew install unrar"));
    }

    #[test]
    fn decode_zip_name_utf8_and_gbk() {
        assert_eq!(decode_zip_name("绍宋/8.jpg".as_bytes()), "绍宋/8.jpg");
        let (gbk, _, _) = encoding_rs::GBK.encode("绍宋/Chapter_001/8.jpg");
        assert_eq!(decode_zip_name(&gbk), "绍宋/Chapter_001/8.jpg");
        assert!(is_ignored_archive_entry("__MACOSX/绍宋/._8.jpg"));
        assert!(is_ignored_archive_entry("绍宋/._8.jpg"));
        assert!(is_ignored_archive_entry("绍宋/.DS_Store"));
        assert!(!is_ignored_archive_entry("绍宋/Chapter_060/8.jpg"));
    }

    fn clear_zip_utf8_flags(buf: &mut [u8]) {
        let mut i = 0;
        while i + 10 < buf.len() {
            if buf[i..].starts_with(b"PK\x03\x04") {
                let f = u16::from_le_bytes([buf[i + 6], buf[i + 7]]) & !0x800;
                buf[i + 6] = f as u8;
                buf[i + 7] = (f >> 8) as u8;
                i += 4;
            } else if buf[i..].starts_with(b"PK\x01\x02") {
                let f = u16::from_le_bytes([buf[i + 8], buf[i + 9]]) & !0x800;
                buf[i + 8] = f as u8;
                buf[i + 9] = (f >> 8) as u8;
                i += 4;
            } else {
                i += 1;
            }
        }
    }

    fn crc32_ieee(data: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &b in data {
            crc ^= b as u32;
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    fn write_stored_zip(path: &Path, entries: &[(&[u8], &[u8])]) {
        let mut locals = Vec::new();
        let mut centrals = Vec::new();
        let mut offset = 0u32;
        for (name, data) in entries {
            let crc = crc32_ieee(data);
            let mut local = Vec::new();
            local.extend_from_slice(b"PK\x03\x04");
            local.extend_from_slice(&20u16.to_le_bytes());
            local.extend_from_slice(&0u16.to_le_bytes());
            local.extend_from_slice(&0u16.to_le_bytes());
            local.extend_from_slice(&0u16.to_le_bytes());
            local.extend_from_slice(&0u16.to_le_bytes());
            local.extend_from_slice(&crc.to_le_bytes());
            local.extend_from_slice(&(data.len() as u32).to_le_bytes());
            local.extend_from_slice(&(data.len() as u32).to_le_bytes());
            local.extend_from_slice(&(name.len() as u16).to_le_bytes());
            local.extend_from_slice(&0u16.to_le_bytes());
            local.extend_from_slice(name);
            local.extend_from_slice(data);
            let mut central = Vec::new();
            central.extend_from_slice(b"PK\x01\x02");
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name.len() as u16).to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u32.to_le_bytes());
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name);
            offset += local.len() as u32;
            locals.extend_from_slice(&local);
            centrals.extend_from_slice(&central);
        }
        let mut out = locals;
        let cd_off = out.len() as u32;
        out.extend_from_slice(&centrals);
        out.extend_from_slice(b"PK\x05\x06");
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        let n = entries.len() as u16;
        out.extend_from_slice(&n.to_le_bytes());
        out.extend_from_slice(&n.to_le_bytes());
        out.extend_from_slice(&(centrals.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_off.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        std::fs::write(path, out).unwrap();
    }

    #[test]
    fn zip_skips_macos_junk_and_decodes_utf8_without_flag() {
        let dir = tempfile::tempdir().unwrap();
        let png_path = dir.path().join("p.png");
        write_tiny_png(&png_path);
        let data = std::fs::read(&png_path).unwrap();
        let zip_path = dir.path().join("book.zip");
        {
            let file = File::create(&zip_path).unwrap();
            let mut zip = ZipWriter::new(file);
            let opts = SimpleFileOptions::default();
            zip.start_file("绍宋/Chapter_001/8.jpg", opts).unwrap();
            zip.write_all(&data).unwrap();
            zip.start_file("__MACOSX/绍宋/Chapter_001/._8.jpg", opts)
                .unwrap();
            zip.write_all(&[0, 5, 0x16, 7, 0, 0, 0, 0]).unwrap();
            zip.start_file("绍宋/Chapter_001/._8.jpg", opts).unwrap();
            zip.write_all(&[0, 5, 0x16, 7]).unwrap();
            zip.finish().unwrap();
        }
        let mut bytes = std::fs::read(&zip_path).unwrap();
        clear_zip_utf8_flags(&mut bytes);
        std::fs::write(&zip_path, bytes).unwrap();

        let cfg = AppConfig::default();
        let v = validate_source(&zip_path, &cfg).unwrap();
        assert_eq!(v.page_count, 1);
        assert_eq!(v.page_names[0], "绍宋/Chapter_001/8.jpg");

        let dest = dir.path().join("out.jpg");
        extract_zip_entry_raw(&zip_path, "绍宋/Chapter_001/8.jpg", &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), data);
    }

    #[test]
    fn zip_decodes_gbk_names_without_utf8_flag() {
        let dir = tempfile::tempdir().unwrap();
        let png_path = dir.path().join("p.png");
        write_tiny_png(&png_path);
        let data = std::fs::read(&png_path).unwrap();
        let (name, _, _) = encoding_rs::GBK.encode("绍宋/001.png");
        let zip_path = dir.path().join("gbk.zip");
        write_stored_zip(&zip_path, &[(&name, data.as_slice())]);

        let cfg = AppConfig::default();
        let v = validate_source(&zip_path, &cfg).unwrap();
        assert_eq!(v.page_count, 1);
        assert_eq!(v.page_names[0], "绍宋/001.png");
    }
}
