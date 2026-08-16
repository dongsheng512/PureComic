//! EPUB / MOBI (Kindle) comic import — extract page images for the enhance pipeline.
//!
//! - **EPUB**: ZIP package; prefer reading order from OPF spine (xhtml → img), else natural-sort all images.
//! - **MOBI / AZW / AZW3**: via `mobi` crate image records (comic-style picture books).
//!
//! Export remains CBZ/Folder/ZIP (we do not re-pack EPUB/MOBI in MVP).

use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
use crate::image_io::{self, is_image_path};
use crate::natural_sort::natural_cmp;
use crate::security::{check_entry_limits, sanitize_entry_path};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use zip::ZipArchive;

/// Ordered list of image entry paths inside an EPUB (zip-relative, forward slashes).
pub fn list_epub_images(path: &Path, cfg: &AppConfig) -> AppResult<(Vec<String>, Vec<String>)> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(file)
        .map_err(|e| AppError::unsupported(format!("无法打开 EPUB（需为 ZIP 包）: {e}")))?;

    let mut all_images: Vec<String> = Vec::new();
    let mut total_uncomp = 0u64;
    let mut entry_index = 0u32;
    let mut warnings = Vec::new();

    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| AppError::internal(format!("EPUB 条目: {e}")))?;
        let name = entry.name().to_string();
        if name.ends_with('/') {
            continue;
        }
        let safe = sanitize_entry_path(&name)?;
        let safe_str = safe.to_string_lossy().replace('\\', "/");
        check_entry_limits(
            cfg,
            entry_index,
            entry.compressed_size(),
            entry.size(),
            total_uncomp,
        )?;
        total_uncomp = total_uncomp.saturating_add(entry.size());
        entry_index += 1;
        if is_image_path(Path::new(&safe_str)) {
            // skip common cover-only tiny decorations? keep all for comics
            all_images.push(safe_str);
        }
    }

    if all_images.is_empty() {
        return Err(AppError::unsupported(
            "EPUB 中未找到图片页（非图文混排漫画/画册可能不适用）",
        ));
    }

    // Attempt spine-based order
    let ordered = order_epub_images_by_opf(path, &all_images).unwrap_or_else(|e| {
        warnings.push(format!("未能按目录排序，改用文件名自然序: {e}"));
        let mut v = all_images.clone();
        v.sort_by(|a, b| natural_cmp(a, b));
        v
    });

    // de-dup while preserving order
    let mut seen = HashSet::new();
    let mut final_list = Vec::new();
    for n in ordered {
        if seen.insert(n.clone()) {
            final_list.push(n);
        }
    }
    // append any images not referenced by spine
    let mut rest = all_images;
    rest.sort_by(|a, b| natural_cmp(a, b));
    for n in rest {
        if seen.insert(n.clone()) {
            final_list.push(n);
            if warnings.iter().all(|w| !w.contains("附加未引用")) {
                warnings.push("部分图片未出现在阅读目录中，已附加到末尾".into());
            }
        }
    }

    Ok((final_list, warnings))
}

fn read_zip_entry_string(path: &Path, entry_name: &str) -> AppResult<String> {
    let file = File::open(path)?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| AppError::internal(format!("EPUB zip: {e}")))?;
    // try exact and common slash variants
    let candidates = [entry_name.to_string(), entry_name.replace('\\', "/")];
    for cand in &candidates {
        if let Ok(mut e) = archive.by_name(cand) {
            let mut s = String::new();
            e.read_to_string(&mut s)?;
            return Ok(s);
        }
    }
    // case-insensitive scan
    let want = entry_name.replace('\\', "/").to_ascii_lowercase();
    for i in 0..archive.len() {
        let mut e = archive
            .by_index(i)
            .map_err(|e| AppError::internal(e.to_string()))?;
        let n = e.name().replace('\\', "/");
        if n.to_ascii_lowercase() == want {
            let mut s = String::new();
            e.read_to_string(&mut s)?;
            return Ok(s);
        }
    }
    Err(AppError::not_found(format!("EPUB 缺少文件: {entry_name}")))
}

fn order_epub_images_by_opf(path: &Path, all_images: &[String]) -> AppResult<Vec<String>> {
    // META-INF/container.xml → rootfile full-path
    let container = read_zip_entry_string(path, "META-INF/container.xml")?;
    let rootfile = extract_attr_value(&container, "rootfile", "full-path")
        .ok_or_else(|| AppError::unsupported("EPUB container.xml 无 rootfile"))?;
    let rootfile = rootfile.replace('\\', "/");
    let opf_dir = Path::new(&rootfile)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let opf = read_zip_entry_string(path, &rootfile)?;

    // manifest: id → href
    let mut id_to_href: HashMap<String, String> = HashMap::new();
    for (id, href) in extract_manifest_items(&opf) {
        let joined = join_epub_path(&opf_dir, &href);
        id_to_href.insert(id, joined);
    }

    // spine itemrefs order
    let spine_ids = extract_spine_idrefs(&opf);
    if spine_ids.is_empty() {
        return Err(AppError::unsupported("OPF spine 为空"));
    }

    let image_set: HashSet<String> = all_images.iter().cloned().collect();
    let mut ordered = Vec::new();
    let mut seen = HashSet::new();

    for id in spine_ids {
        let Some(href) = id_to_href.get(&id) else {
            continue;
        };
        // if spine points to an image directly
        if image_set.contains(href) {
            if seen.insert(href.clone()) {
                ordered.push(href.clone());
            }
            continue;
        }
        // else load xhtml and collect <img src>
        if let Ok(html) = read_zip_entry_string(path, href) {
            let base = Path::new(href)
                .parent()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            for src in extract_img_srcs(&html) {
                let full = join_epub_path(&base, &src);
                // normalize against zip paths
                let full = normalize_zip_path(&full);
                // match case-insensitively to all_images
                if let Some(real) = find_image_ci(&image_set, &full) {
                    if seen.insert(real.clone()) {
                        ordered.push(real);
                    }
                }
            }
        }
    }

    if ordered.is_empty() {
        return Err(AppError::unsupported("spine 未解析到图片"));
    }
    Ok(ordered)
}

fn find_image_ci(set: &HashSet<String>, path: &str) -> Option<String> {
    if set.contains(path) {
        return Some(path.to_string());
    }
    let lower = path.to_ascii_lowercase();
    set.iter()
        .find(|s| s.to_ascii_lowercase() == lower)
        .cloned()
}

fn join_epub_path(base: &str, href: &str) -> String {
    let href = href.split('#').next().unwrap_or(href).trim();
    if href.starts_with('/') {
        return href.trim_start_matches('/').to_string();
    }
    if base.is_empty() {
        return href.to_string();
    }
    let mut parts: Vec<&str> = base.split('/').filter(|s| !s.is_empty()).collect();
    for seg in href.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            parts.pop();
        } else {
            parts.push(seg);
        }
    }
    parts.join("/")
}

fn normalize_zip_path(p: &str) -> String {
    p.replace('\\', "/").trim_start_matches("./").to_string()
}

fn extract_attr_value(xml: &str, tag: &str, attr: &str) -> Option<String> {
    // lightweight scan: <tag ... attr="value"
    let tag_l = tag.to_ascii_lowercase();
    let attr_l = attr.to_ascii_lowercase();
    let lower = xml.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find(&format!("<{tag_l}")) {
        let start = search_from + rel;
        let end = lower[start..].find('>').map(|i| start + i)?;
        let slice = &xml[start..end];
        let slice_l = slice.to_ascii_lowercase();
        let key = format!("{attr_l}=\"");
        if let Some(a) = slice_l.find(&key) {
            let vstart = a + key.len();
            let raw = &slice[vstart..];
            if let Some(vend) = raw.find('"') {
                return Some(raw[..vend].to_string());
            }
        }
        let key2 = format!("{attr_l}='");
        if let Some(a) = slice_l.find(&key2) {
            let vstart = a + key2.len();
            let raw = &slice[vstart..];
            if let Some(vend) = raw.find('\'') {
                return Some(raw[..vend].to_string());
            }
        }
        search_from = end + 1;
    }
    None
}

fn extract_manifest_items(opf: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let lower = opf.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find("<item") {
        let start = search_from + rel;
        let Some(end_rel) = lower[start..].find('>') else {
            break;
        };
        let end = start + end_rel;
        let slice = &opf[start..end];
        let id = attr_from_tag(slice, "id");
        let href = attr_from_tag(slice, "href");
        if let (Some(id), Some(href)) = (id, href) {
            out.push((id, href));
        }
        search_from = end + 1;
    }
    out
}

fn extract_spine_idrefs(opf: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = opf.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find("<itemref") {
        let start = search_from + rel;
        let Some(end_rel) = lower[start..].find('>') else {
            break;
        };
        let end = start + end_rel;
        let slice = &opf[start..end];
        if let Some(idref) = attr_from_tag(slice, "idref") {
            out.push(idref);
        }
        search_from = end + 1;
    }
    out
}

fn attr_from_tag(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let name_l = name.to_ascii_lowercase();
    for quote in ['"', '\''] {
        let key = format!("{name_l}={quote}");
        if let Some(a) = lower.find(&key) {
            let vstart = a + key.len();
            let raw = &tag[vstart..];
            if let Some(vend) = raw.find(quote) {
                return Some(raw[..vend].to_string());
            }
        }
    }
    None
}

fn extract_img_srcs(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = html.to_ascii_lowercase();
    // <img ... src="...">
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find("<img") {
        let start = search_from + rel;
        let Some(end_rel) = lower[start..].find('>') else {
            break;
        };
        let end = start + end_rel;
        let slice = &html[start..end];
        if let Some(src) = attr_from_tag(slice, "src") {
            if !src.starts_with("data:") {
                out.push(src);
            }
        }
        // also xlink:href for svg image
        if let Some(src) = attr_from_tag(slice, "xlink:href") {
            out.push(src);
        }
        search_from = end + 1;
    }
    // <image href="..."> in SVG
    search_from = 0;
    while let Some(rel) = lower[search_from..].find("<image") {
        let start = search_from + rel;
        let Some(end_rel) = lower[start..].find('>') else {
            break;
        };
        let end = start + end_rel;
        let slice = &html[start..end];
        if let Some(src) =
            attr_from_tag(slice, "href").or_else(|| attr_from_tag(slice, "xlink:href"))
        {
            out.push(src);
        }
        search_from = end + 1;
    }
    out
}

/// Extract one EPUB image entry to `dest` (original bytes; no re-encode).
pub fn extract_epub_page_raw(source: &Path, entry_name: &str, dest: &Path) -> AppResult<()> {
    let file = File::open(source)?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| AppError::unsupported(format!("无法打开 EPUB: {e}")))?;
    let mut found = None;
    let want = entry_name.replace('\\', "/");
    for i in 0..archive.len() {
        let e = archive
            .by_index(i)
            .map_err(|e| AppError::internal(e.to_string()))?;
        let n = e.name().replace('\\', "/");
        if n == want || n.eq_ignore_ascii_case(&want) {
            found = Some(i);
            break;
        }
    }
    let idx = found.ok_or_else(|| AppError::not_found(format!("EPUB 中无页: {entry_name}")))?;
    let entry = archive
        .by_index(idx)
        .map_err(|e| AppError::internal(e.to_string()))?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let declared = entry.size();
    let mut f = File::create(dest)?;
    // 与 zip 路径一致：篡改声明大小的条目不得绕过上限写满磁盘
    std::io::copy(&mut entry.take(declared.saturating_add(1)), &mut f)?;
    if f.metadata().map(|m| m.len()).unwrap_or(0) > declared {
        return Err(AppError::invalid("EPUB 条目实际大小超过声明值，已中止解压"));
    }
    Ok(())
}

/// Extract one EPUB image entry to engine PNG (preview).
pub fn extract_epub_page(source: &Path, entry_name: &str, dest_png: &Path) -> AppResult<()> {
    let ext = Path::new(entry_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let tmp = dest_png.with_extension(format!("raw.{ext}"));
    extract_epub_page_raw(source, entry_name, &tmp)?;
    image_io::convert_file_to_engine_png(&tmp, dest_png)?;
    let _ = std::fs::remove_file(&tmp);
    Ok(())
}

// --------------- MOBI / AZW / AZW3 ---------------

/// List synthetic page names and extract-ready indices for MOBI images.
pub fn list_mobi_images(path: &Path) -> AppResult<(Vec<String>, Vec<Vec<u8>>)> {
    let data = std::fs::read(path)?;
    let book = mobi::Mobi::new(data).map_err(|e| {
        AppError::unsupported(format!(
            "无法解析 MOBI/AZW（可能是加密或非标准 Kindle 格式）: {e}"
        ))
    })?;

    let images = book.image_records();
    if images.is_empty() {
        return Err(AppError::unsupported(
            "该 MOBI/AZW 中未提取到图片（纯文字书或不支持的版本）",
        ));
    }

    let mut names = Vec::new();
    let mut blobs = Vec::new();
    for (i, rec) in images.into_iter().enumerate() {
        let Some(img) = unwrap_kindle_image(rec.content) else {
            continue;
        };
        let ext = sniff_image_ext(img).unwrap_or("bin");
        if ext == "bin" {
            continue;
        }
        names.push(format!("mobi_page_{i:05}.{ext}"));
        blobs.push(img.to_vec());
    }
    if names.is_empty() {
        return Err(AppError::unsupported("MOBI 图片记录无法识别为图像"));
    }
    Ok((names, blobs))
}

/// Kindle sometimes wraps JPEG/PNG in a `CRES` resource or a short PDB prefix.
pub fn unwrap_kindle_image(bytes: &[u8]) -> Option<&[u8]> {
    if sniff_image_ext(bytes).is_some() {
        return Some(bytes);
    }
    if bytes.starts_with(b"CRES") {
        for skip in [8, 12, 16, 20] {
            if bytes.len() > skip && sniff_image_ext(&bytes[skip..]).is_some() {
                return Some(&bytes[skip..]);
            }
        }
    }
    let limit = bytes.len().saturating_sub(12).min(512);
    for i in 1..limit {
        if sniff_image_ext(&bytes[i..]).is_some() {
            return Some(&bytes[i..]);
        }
    }
    None
}

fn exth_u32(book: &mobi::Mobi, rec: mobi::headers::ExthRecord) -> Option<u32> {
    let chunks = book.metadata.exth.get_record(rec)?;
    let b = chunks.first()?;
    match b.len() {
        4 => Some(u32::from_be_bytes([b[0], b[1], b[2], b[3]])),
        2 => Some(u16::from_be_bytes([b[0], b[1]]) as u32),
        1 => Some(b[0] as u32),
        _ => None,
    }
}

fn record_image<'a>(records: &'a [mobi::record::RawRecord<'a>], idx: usize) -> Option<&'a [u8]> {
    let rec = records.get(idx)?;
    unwrap_kindle_image(rec.content)
}

fn valid_exth_offset(v: u32) -> Option<u32> {
    if v == u32::MAX {
        None
    } else {
        Some(v)
    }
}

/// Cover bytes: EXTH cover/thumb first, never "largest page".
pub fn mobi_cover_bytes(path: &Path) -> AppResult<Vec<u8>> {
    let data = std::fs::read(path)?;
    let book = mobi::Mobi::new(data)
        .map_err(|e| AppError::unsupported(format!("无法解析 MOBI/AZW: {e}")))?;
    let first_raw = book.metadata.mobi.first_image_index;
    if first_raw == u32::MAX {
        return Err(AppError::unsupported("该 MOBI 未声明图片记录"));
    }
    let first = first_raw as usize;
    let raw = book.raw_records();
    let recs = raw.records();

    if let Some(off) =
        exth_u32(&book, mobi::headers::ExthRecord::CoverOffset).and_then(valid_exth_offset)
    {
        if let Some(img) = record_image(recs, first.saturating_add(off as usize)) {
            return Ok(img.to_vec());
        }
    }
    if let Some(off) =
        exth_u32(&book, mobi::headers::ExthRecord::ThumbOffset).and_then(valid_exth_offset)
    {
        if let Some(img) = record_image(recs, first.saturating_add(off as usize)) {
            return Ok(img.to_vec());
        }
    }

    let fake = exth_u32(&book, mobi::headers::ExthRecord::HasFakeCover).unwrap_or(0) == 1;
    let start = if fake { first.saturating_add(1) } else { first };
    for rec in recs.iter().skip(start) {
        if let Some(img) = unwrap_kindle_image(rec.content) {
            return Ok(img.to_vec());
        }
    }

    Err(AppError::unsupported("该 MOBI 中找不到封面图"))
}

fn sniff_image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some("png");
    }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("webp");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("gif");
    }
    if bytes.starts_with(b"BM") {
        return Some("bmp");
    }
    None
}

pub fn extract_mobi_page_bytes(bytes: &[u8], dest_png: &Path) -> AppResult<()> {
    let payload = unwrap_kindle_image(bytes).unwrap_or(bytes);
    write_mobi_engine_input(payload, dest_png)
}

/// Write MOBI image bytes in a format waifu2x can read (copy jpg/png/webp).
pub fn write_mobi_engine_input(bytes: &[u8], dest: &Path) -> AppResult<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let sniff = sniff_image_ext(bytes).unwrap_or("bin");
    if image_io::is_engine_native_ext(sniff) {
        std::fs::write(dest, bytes)?;
        return Ok(());
    }
    let tmp = dest.with_extension(format!("raw.{sniff}"));
    std::fs::write(&tmp, bytes)?;
    image_io::convert_file_to_engine_png(&tmp, dest)?;
    let _ = std::fs::remove_file(&tmp);
    Ok(())
}

/// MOBI 解析展开目录（work/mobi-cache/<hash>-<len>-<mtime>）。
/// 目录名带内容指纹：文件变化即换新目录，不会命中陈旧缓存。
fn mobi_cache_path(source: &Path, cfg: &AppConfig) -> PathBuf {
    use sha2::{Digest, Sha256};
    use std::time::UNIX_EPOCH;

    let meta = std::fs::metadata(source).ok();
    let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(source.to_string_lossy().as_bytes());
    let digest: String = hasher
        .finalize()
        .iter()
        .take(6)
        .map(|b| format!("{b:02x}"))
        .collect();
    cfg.work_root
        .join("mobi-cache")
        .join(format!("mobi-{digest}-{len}-{mtime}"))
}

/// MOBI 缓存构建互斥：预取窗口内多页并发首建时，
/// 若不串行化，B 的「先删旧目录再 rename」会删掉 A 刚建好的目录，
/// 导致并发读页误报「索引越界」。
static MOBI_CACHE_BUILD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 把整本书展开进 tmp 目录（调用方持有构建锁）。
fn build_mobi_cache_into(source: &Path, tmp: &Path) -> AppResult<()> {
    std::fs::create_dir_all(tmp)?;
    let (_names, blobs) = list_mobi_images(source)?;
    for (i, b) in blobs.iter().enumerate() {
        std::fs::write(tmp.join(format!("{i:05}.img")), b)?;
    }
    std::fs::write(tmp.join("meta.json"), "1")?;
    Ok(())
}

/// 原子安装缓存目录：tmp 构建完成后 rename 到 dir（调用方持有构建锁）。
/// 只清理超过 10 分钟的 tmp-* 构建残留——不删并发中的 tmp，也不删其它书的指纹缓存。
fn install_mobi_cache(source: &Path, dir: &Path) -> AppResult<()> {
    let parent = dir
        .parent()
        .ok_or_else(|| AppError::internal("MOBI 缓存目录无父目录"))?;
    std::fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(
        "tmp-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    if let Err(e) = build_mobi_cache_into(source, &tmp) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    if dir.exists() {
        let _ = std::fs::remove_dir_all(dir);
    }
    std::fs::rename(&tmp, dir)?;
    if let Ok(rd) = std::fs::read_dir(parent) {
        let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(10 * 60);
        for e in rd.flatten() {
            let is_tmp = e.file_name().to_string_lossy().starts_with("tmp-");
            let stale = e
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| t < cutoff)
                .unwrap_or(false);
            if is_tmp && stale {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    Ok(())
}

/// 首次把 MOBI 全部图片展开到缓存目录，之后按页读取——
/// 避免每翻一页都整本重读 + 全量解析（500MB 的 AZW3 = O(全书)/页）。
fn ensure_mobi_cache(source: &Path, cfg: &AppConfig) -> AppResult<PathBuf> {
    let dir = mobi_cache_path(source, cfg);
    if dir.join("meta.json").is_file() {
        return Ok(dir);
    }
    let _guard = MOBI_CACHE_BUILD_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // 双重检查：等锁期间可能已有其它线程建好
    if dir.join("meta.json").is_file() {
        return Ok(dir);
    }
    install_mobi_cache(source, &dir)?;
    Ok(dir)
}

pub fn extract_mobi_page_index(
    source: &Path,
    page_index: usize,
    dest_png: &Path,
    cfg: &AppConfig,
) -> AppResult<()> {
    let dir = ensure_mobi_cache(source, cfg)?;
    let file = dir.join(format!("{page_index:05}.img"));
    if let Ok(bytes) = std::fs::read(&file) {
        return extract_mobi_page_bytes(&bytes, dest_png);
    }
    // 页文件缺失（缓存被并发重建的窗口击中）：持锁强制重建一次自愈
    {
        let _guard = MOBI_CACHE_BUILD_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !file.is_file() {
            install_mobi_cache(source, &dir)?;
        }
    }
    let bytes = std::fs::read(&file)
        .map_err(|_| AppError::invalid(format!("MOBI 页索引越界: {page_index}")))?;
    extract_mobi_page_bytes(&bytes, dest_png)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn tiny_png_bytes() -> Vec<u8> {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.png");
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_pixel(8, 8, Rgb([1, 2, 3]));
        image::DynamicImage::ImageRgb8(img).save(&p).unwrap();
        std::fs::read(p).unwrap()
    }

    #[test]
    fn epub_lists_images_natural_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let epub = dir.path().join("sample.epub");
        let png = tiny_png_bytes();
        {
            let f = File::create(&epub).unwrap();
            let mut z = ZipWriter::new(f);
            let opts = SimpleFileOptions::default();
            z.start_file("mimetype", opts).unwrap();
            z.write_all(b"application/epub+zip").unwrap();
            z.start_file("META-INF/container.xml", opts).unwrap();
            z.write_all(
                br#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#,
            )
            .unwrap();
            z.start_file("OEBPS/content.opf", opts).unwrap();
            z.write_all(
                br#"<?xml version="1.0"?>
<package>
  <manifest>
    <item id="p1" href="Text/p1.xhtml" media-type="application/xhtml+xml"/>
    <item id="i1" href="Images/b.png" media-type="image/png"/>
    <item id="i2" href="Images/a.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="p1"/>
  </spine>
</package>"#,
            )
            .unwrap();
            z.start_file("OEBPS/Text/p1.xhtml", opts).unwrap();
            z.write_all(
                br#"<?xml version="1.0"?>
<html><body>
<img src="../Images/a.png"/>
<img src="../Images/b.png"/>
</body></html>"#,
            )
            .unwrap();
            z.start_file("OEBPS/Images/b.png", opts).unwrap();
            z.write_all(&png).unwrap();
            z.start_file("OEBPS/Images/a.png", opts).unwrap();
            z.write_all(&png).unwrap();
            z.finish().unwrap();
        }
        let cfg = AppConfig::default();
        let (pages, _w) = list_epub_images(&epub, &cfg).unwrap();
        assert_eq!(pages.len(), 2);
        // spine order: a then b
        assert!(pages[0].ends_with("Images/a.png") || pages[0].contains("a.png"));
        assert!(pages[1].contains("b.png"));
    }

    #[test]
    fn unwraps_cres_wrapped_jpeg() {
        let mut blob = b"CRES".to_vec();
        blob.extend_from_slice(&[0u8; 12]);
        blob.extend_from_slice(&[0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4]);
        let img = unwrap_kindle_image(&blob).unwrap();
        assert!(img.starts_with(&[0xFF, 0xD8, 0xFF]));
    }

    #[test]
    fn unwraps_plain_png() {
        let png = tiny_png_bytes();
        let img = unwrap_kindle_image(&png).unwrap();
        assert_eq!(img, png.as_slice());
    }
}
