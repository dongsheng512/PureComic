//! Folder / ZIP / CBZ import & export with safety limits.
//! ComicInfo.xml is byte-preserved when present.

use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
use crate::image_io::{self, is_image_path};
use crate::job::{ImageFormat, JobManifest, OutputContainer, PageRecord, PageStatus, SourceKind};
use crate::natural_sort::natural_cmp;
use crate::security::{check_entry_limits, sanitize_entry_path};
use std::fs::File;
use std::io::{Read, Write};
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
        let name = entry.name().to_string();
        if name.ends_with('/') {
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
pub fn extract_zip_entry_raw(source: &Path, name: &str, dest: &Path) -> AppResult<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = File::open(source)?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| AppError::unsupported(format!("无法打开压缩包: {e}")))?;
    let want = name.replace('\\', "/");
    if archive.by_name(&want).is_ok() {
        let mut entry = archive
            .by_name(&want)
            .map_err(|e| AppError::internal(format!("读取页失败: {e}")))?;
        let mut f = File::create(dest)?;
        std::io::copy(&mut entry, &mut f)?;
        return Ok(());
    }
    let mut found = None;
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| AppError::internal(format!("zip 条目: {e}")))?;
        let ename = entry.name().replace('\\', "/");
        if ename == want {
            found = Some(i);
            break;
        }
    }
    let idx = found.ok_or_else(|| AppError::not_found(format!("压缩包中找不到页: {name}")))?;
    let mut entry = archive
        .by_index(idx)
        .map_err(|e| AppError::internal(format!("读取页失败: {e}")))?;
    let mut f = File::create(dest)?;
    std::io::copy(&mut entry, &mut f)?;
    Ok(())
}

/// Extract one page as original bytes (jpg/png/webp stay as-is) for the reader.
pub fn extract_page_native(
    source: &Path,
    kind: SourceKind,
    page_index: u32,
    page_name: &str,
    dest: &Path,
    cfg: &AppConfig,
) -> AppResult<()> {
    if dest.is_file() {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match kind {
        SourceKind::Folder => {
            let src = source.join(page_name);
            if image_io::is_engine_native_path(&src) {
                std::fs::copy(&src, dest)?;
            } else {
                image_io::convert_file_to_engine_png(&src, dest)?;
            }
        }
        SourceKind::Zip | SourceKind::Cbz => {
            extract_zip_entry_raw(source, page_name, dest)?;
        }
        SourceKind::Epub => {
            crate::ebook::extract_epub_page_raw(source, page_name, dest)?;
        }
        SourceKind::Cbr => {
            crate::unrar::extract_rar_file(cfg, source, page_name, dest)?;
        }
        SourceKind::Mobi => {
            crate::ebook::extract_mobi_page_index(source, page_index as usize, dest)?;
        }
        other => {
            return Err(AppError::unsupported(format!("无法抽取原图: {other:?}")));
        }
    }
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
            crate::ebook::extract_mobi_page_index(source, page_index as usize, dest_png)?;
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
    let mut found = None;
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| AppError::internal(format!("zip 条目: {e}")))?;
        let ename = entry.name().to_string();
        if ename.ends_with('/') {
            continue;
        }
        let safe = sanitize_entry_path(&ename)?;
        let safe_str = safe.to_string_lossy().replace('\\', "/");
        if safe_str == name {
            found = Some(i);
            break;
        }
    }
    let idx = found.ok_or_else(|| AppError::not_found(format!("压缩包中找不到页: {name}")))?;
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
    {
        let mut f = File::create(&tmp)?;
        std::io::copy(&mut entry, &mut f)?;
    }
    image_io::convert_file_to_engine_png(&tmp, dest_png)?;
    let _ = std::fs::remove_file(&tmp);
    Ok(())
}

/// Called during extract with (pages_done_so_far, pages_total, current_name).
/// `pages_done` here means **extracted** count (not yet enhanced).
pub type ExtractProgressCb<'a> = dyn FnMut(u32, u32, Option<&str>) + Send + 'a;

/// Extract pages into `manifest.in_dir()` as sequential PNGs for the engine.
/// Invokes `on_progress` after total is known and after each page is written.
pub fn extract_to_workdir(
    manifest: &mut JobManifest,
    cfg: &AppConfig,
    on_progress: Option<&mut ExtractProgressCb<'_>>,
) -> AppResult<()> {
    std::fs::create_dir_all(manifest.in_dir())?;
    std::fs::create_dir_all(manifest.out_dir())?;
    std::fs::create_dir_all(manifest.meta_dir())?;

    match manifest.source.kind {
        SourceKind::Folder => extract_folder(manifest, on_progress)?,
        SourceKind::Zip | SourceKind::Cbz => extract_zip(manifest, cfg, on_progress)?,
        SourceKind::Epub => extract_epub(manifest, cfg, on_progress)?,
        SourceKind::Mobi => extract_mobi(manifest, on_progress)?,
        SourceKind::Cbr => extract_cbr(manifest, cfg, on_progress)?,
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
) -> AppResult<()> {
    let (names, _warnings) = crate::ebook::list_epub_images(&manifest.source.path, cfg)?;
    let total = names.len() as u32;
    report_extract(on_progress.as_deref_mut(), 0, total, None, manifest);
    let in_dir = manifest.in_dir();
    let out_dir = manifest.out_dir();
    let mut pages = Vec::with_capacity(names.len());
    for (idx, name) in names.iter().enumerate() {
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
        manifest.pages = pages.clone();
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
        manifest.pages = pages.clone();
        report_extract(
            on_progress.as_deref_mut(),
            (i + 1) as u32,
            total,
            Some(&names[i]),
            manifest,
        );
    }
    manifest.pages = pages;
    Ok(())
}

fn extract_cbr(
    manifest: &mut JobManifest,
    cfg: &AppConfig,
    mut on_progress: Option<&mut ExtractProgressCb<'_>>,
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
        manifest.pages = pages.iter().filter_map(|p| p.clone()).collect();
        report_extract(
            on_progress.as_deref_mut(),
            done,
            total,
            Some(&names[idx]),
            manifest,
        );
    }
    manifest.pages = pages.into_iter().flatten().collect();
    let _ = std::fs::remove_dir_all(&raw_dir);
    Ok(())
}

fn extract_folder(
    manifest: &mut JobManifest,
    mut on_progress: Option<&mut ExtractProgressCb<'_>>,
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
    manifest.pages = pages.into_iter().flatten().collect();
    Ok(())
}

fn extract_zip(
    manifest: &mut JobManifest,
    cfg: &AppConfig,
    mut on_progress: Option<&mut ExtractProgressCb<'_>>,
) -> AppResult<()> {
    let file = File::open(&manifest.source.path)?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| AppError::unsupported(format!("无法打开压缩包: {e}")))?;

    // First pass: comic info + ordered image names
    let mut image_entries: Vec<(usize, String)> = Vec::new();
    let mut total_uncomp = 0u64;

    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| AppError::internal(format!("zip 条目: {e}")))?;
        let name = entry.name().to_string();
        if name.ends_with('/') {
            continue;
        }
        let safe = sanitize_entry_path(&name)?;
        let safe_str = safe.to_string_lossy().replace('\\', "/");
        check_entry_limits(
            cfg,
            i as u32,
            entry.compressed_size(),
            entry.size(),
            total_uncomp,
        )?;
        total_uncomp = total_uncomp.saturating_add(entry.size());

        if safe_str.eq_ignore_ascii_case("ComicInfo.xml") || safe_str.ends_with("/ComicInfo.xml") {
            drop(entry);
            let mut e = archive.by_index(i).unwrap();
            let dest = manifest.meta_dir().join("ComicInfo.xml");
            let mut out = File::create(&dest)?;
            std::io::copy(&mut e, &mut out)?;
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
        let mut entry = archive
            .by_index(*zip_idx)
            .map_err(|e| AppError::internal(format!("读取页失败: {e}")))?;
        let orig_ext = Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin");
        let (in_path, out_path) =
            engine_page_paths(&in_dir, &out_dir, idx, name, manifest.output.image_format);
        if image_io::is_engine_native_ext(orig_ext) {
            let mut f = File::create(&in_path)?;
            std::io::copy(&mut entry, &mut f)?;
        } else {
            let tmp = in_dir.join(format!("_raw_{idx:05}.{orig_ext}"));
            {
                let mut f = File::create(&tmp)?;
                std::io::copy(&mut entry, &mut f)?;
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
        manifest.pages = pages.clone();
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
    let name = manifest
        .output
        .naming
        .replace("{stem}", stem)
        .replace("{scale}", &scale.to_string());
    match manifest.output.container {
        OutputContainer::Folder => manifest.output.dir.join(&name),
        OutputContainer::Cbz => manifest.output.dir.join(format!("{name}.cbz")),
        OutputContainer::Zip => manifest.output.dir.join(format!("{name}.zip")),
    }
}

/// Pack progress: (done, total, note).
pub type ExportProgressCb<'a> = dyn FnMut(u32, u32, &str) + Send + 'a;

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

    // Idempotent: if a previous attempt already produced output, treat as success.
    // (Avoids stuck "打包中" when file exists but state never flipped to completed.)
    match manifest.output.container {
        OutputContainer::Folder => {
            if out_path.is_dir() {
                return Ok(out_path);
            }
            export_folder(manifest, &out_path, on_progress)?;
        }
        OutputContainer::Cbz | OutputContainer::Zip => {
            if out_path.is_file() && out_path.metadata().map(|m| m.len() > 1024).unwrap_or(false) {
                return Ok(out_path);
            }
            // Remove incomplete partial from crashed prior attempt
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
    std::fs::create_dir_all(dir)?;
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
    let results: Vec<AppResult<()>> = done_pages
        .par_iter()
        .map(|page| {
            let src = page
                .out_path
                .as_ref()
                .ok_or_else(|| AppError::internal("缺少输出路径"))?;
            let orig_ext = Path::new(&page.name).extension().and_then(|e| e.to_str());
            let out_name = export_page_filename(page, &manifest.output.image_format);
            let dest = dir.join(&out_name);
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
    if let Some(ci) = &manifest.metadata.comic_info_src {
        std::fs::copy(ci, dir.join("ComicInfo.xml"))?;
    }
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

    // Parallel encode/copy into memory, then sequential zip write.
    let counter = AtomicU32::new(0);
    let progress = Mutex::new(on_progress);
    let encoded: Vec<AppResult<(u32, String, Vec<u8>)>> = done_pages
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
                    cb(n, total.max(1), "encode");
                }
            }
            Ok((page.index, out_name, data))
        })
        .collect();

    let mut items = Vec::with_capacity(encoded.len());
    for item in encoded {
        items.push(item?);
    }
    items.sort_by_key(|(idx, _, _)| *idx);

    let file = File::create(path)?;
    let mut zip = ZipWriter::new(std::io::BufWriter::new(file));
    // Images are already compressed (JPEG/PNG/WebP). STORE is the CBZ convention
    // and avoids a second Deflate pass that barely shrinks but costs a lot of CPU.
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

    let pack_total = items.len() as u32;
    for (i, (_idx, out_name, data)) in items.into_iter().enumerate() {
        zip.start_file(out_name, opts)
            .map_err(|e| AppError::internal(format!("zip 写入: {e}")))?;
        zip.write_all(&data)?;
        if let Ok(mut g) = progress.lock() {
            if let Some(cb) = g.as_deref_mut() {
                cb((i as u32) + 1, pack_total.max(1), "pack");
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
        let mut cfg = AppConfig::default();
        cfg.unrar_bin = Some(PathBuf::from("/no/such/unrar-binary"));
        let err = validate_source(&cbr, &cfg).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::UnrarMissing);
        assert!(err
            .detail
            .unwrap_or_default()
            .contains("brew install unrar"));
    }
}
