//! On-demand single-page enhance for the reader, with a bounded disk cache.

use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
use crate::pipeline::GpuLock;
use crate::preview::{options_from_dto, EnhanceOptionsDto};
use crate::reader::{extract_original, source_cache_key, ReaderPageFile};
use comic_engines::{EnhanceBatchRequest, UpscaleEngine};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

/// Soft cap for the reader enhance cache (oldest files evicted first).
pub const MAX_CACHE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Extra safety: do not keep more than this many enhanced pages.
pub const MAX_CACHE_FILES: usize = 400;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceCacheStats {
    pub bytes: u64,
    pub files: u32,
    pub max_bytes: u64,
    pub max_files: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceCacheClearResult {
    pub removed: u32,
    pub bytes_freed: u64,
}

pub fn cache_signature(options: Option<&EnhanceOptionsDto>) -> AppResult<String> {
    let opts = options_from_dto(options.cloned())?;
    let engine = match &options.and_then(|o| o.engine.as_deref()) {
        Some("realesrgan-coreml") | Some("esrgan-coreml") | Some("esrgan-anime") => {
            "realesrgan-coreml"
        }
        _ => "waifu2x-coreml",
    };
    let model = if engine == "realesrgan-coreml" {
        "anime-6b-4x-v2"
    } else {
        "anime-2x-v4"
    };
    let tta = if opts.tta { "t" } else { "" };
    let cap = reader_input_cap(engine);
    Ok(format!(
        "{engine}-{model}-sa-n{}{tta}-c{cap}-t{READER_TILE}-j",
        opts.noise
    ))
}

/// Do not shrink typical scans before Waifu2x; 2× of 2560 still fits the cache.
pub const MAX_INPUT_SIDE: u32 = 2560;
/// 4× Real-ESRGAN: keep enough source pixels so balloon text stays readable.
/// 512 crushed 1920px pages and the net painted mushy glyphs.
pub const ESRGAN_INPUT_SIDE: u32 = 1024;

pub fn reader_input_cap(engine: &str) -> u32 {
    match engine {
        "realesrgan-coreml" | "esrgan-coreml" | "esrgan-anime" => ESRGAN_INPUT_SIDE,
        _ => MAX_INPUT_SIDE,
    }
}
/// Explicit tile is faster than auto-0 on typical Apple / discrete GPUs.
const READER_TILE: u32 = 512;

pub fn cache_file(cfg: &AppConfig, source: &Path, page_index: u32, sig: &str) -> PathBuf {
    cfg.reader_enhance_dir()
        .join(source_cache_key(source))
        .join(sig)
        .join(format!("{page_index:04}.jpg"))
}

fn touch_mtime(path: &Path) {
    let now = SystemTime::now();
    if let Ok(f) = std::fs::File::open(path) {
        let _ = f.set_modified(now);
    }
}

fn collect_cache_files(root: &Path) -> Vec<(PathBuf, SystemTime, u64)> {
    let mut out = Vec::new();
    let Ok(walk) = std::fs::read_dir(root) else {
        return out;
    };
    let mut stack: Vec<PathBuf> = walk.filter_map(|e| e.ok().map(|e| e.path())).collect();
    while let Some(p) = stack.pop() {
        if p.is_dir() {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name == ".batch" || name == ".scratch" {
                continue;
            }
            if let Ok(rd) = std::fs::read_dir(&p) {
                stack.extend(rd.filter_map(|e| e.ok().map(|e| e.path())));
            }
            continue;
        }
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());
        if !matches!(ext.as_deref(), Some("png" | "jpg" | "jpeg")) {
            continue;
        }
        let fname = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if fname.contains(".in.") || fname.contains(".tmp.") {
            continue;
        }
        if let Ok(meta) = p.metadata() {
            out.push((
                p,
                meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                meta.len(),
            ));
        }
    }
    out
}

fn prune_empty_dirs(root: &Path) {
    let Ok(rd) = std::fs::read_dir(root) else {
        return;
    };
    for ent in rd.flatten() {
        let p = ent.path();
        if !p.is_dir() {
            continue;
        }
        prune_empty_dirs(&p);
        if std::fs::read_dir(&p)
            .map(|mut i| i.next().is_none())
            .unwrap_or(false)
        {
            let _ = std::fs::remove_dir(&p);
        }
    }
}

/// Evict oldest cache files until under the given caps.
pub fn evict_cache(cfg: &AppConfig, max_bytes: u64, max_files: usize) -> AppResult<()> {
    let root = cfg.reader_enhance_dir();
    if !root.is_dir() {
        return Ok(());
    }
    let mut files = collect_cache_files(&root);
    let mut total: u64 = files.iter().map(|f| f.2).sum();
    if files.len() <= max_files && total <= max_bytes {
        return Ok(());
    }
    files.sort_by_key(|f| f.1);
    let mut count = files.len();
    for (path, _, len) in files {
        if count <= max_files && total <= max_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
            count = count.saturating_sub(1);
        }
    }
    prune_empty_dirs(&root);
    Ok(())
}

pub fn cache_stats(cfg: &AppConfig) -> EnhanceCacheStats {
    let root = cfg.reader_enhance_dir();
    let files = if root.is_dir() {
        collect_cache_files(&root)
    } else {
        Vec::new()
    };
    EnhanceCacheStats {
        bytes: files.iter().map(|f| f.2).sum(),
        files: files.len() as u32,
        max_bytes: MAX_CACHE_BYTES,
        max_files: MAX_CACHE_FILES as u32,
    }
}

pub fn clear_cache(cfg: &AppConfig) -> AppResult<EnhanceCacheClearResult> {
    let root = cfg.reader_enhance_dir();
    if !root.is_dir() {
        return Ok(EnhanceCacheClearResult {
            removed: 0,
            bytes_freed: 0,
        });
    }
    let files = collect_cache_files(&root);
    let bytes_freed = files.iter().map(|f| f.2).sum();
    let removed = files.len() as u32;
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::create_dir_all(&root);
    Ok(EnhanceCacheClearResult {
        removed,
        bytes_freed,
    })
}

pub fn lookup_pages(
    source: &Path,
    page_indexes: &[u32],
    options: Option<EnhanceOptionsDto>,
    cfg: &AppConfig,
) -> AppResult<Vec<ReaderPageFile>> {
    let sig = cache_signature(options.as_ref())?;
    let mut out = Vec::new();
    let names = crate::reader::listed_pages(source, cfg)
        .map(|(_, n)| n)
        .unwrap_or_default();
    for &i in page_indexes {
        let path = cache_file(cfg, source, i, &sig);
        if cache_ready(&path) {
            touch_mtime(&path);
            let name = names
                .get(i as usize)
                .cloned()
                .unwrap_or_else(|| format!("page-{i}"));
            out.push(ReaderPageFile {
                index: i,
                name,
                kind: "enhanced".into(),
                path: path.display().to_string(),
            });
        }
    }
    Ok(out)
}

fn reader_engine_params(opts: &crate::job::EnhanceOptions) -> comic_engines::EnhanceParams {
    let mut params = opts.to_engine_params();
    params.tta = false;
    params.output_format = Some("jpg".into());
    params.tile_size = Some(READER_TILE);
    params.jobs = Some("2:2:2".into());
    if params.engine == comic_engines::EngineKind::RealEsrganCoreMl {
        params.scale = comic_engines::ScaleFactor::X4;
    }
    params
}

fn image_max_side(path: &Path) -> AppResult<u32> {
    if let Ok((w, h)) = crate::image_io::image_dimensions(path) {
        return Ok(w.max(h));
    }
    let img = crate::image_io::load_image(path)?;
    Ok(img.width().max(img.height()))
}

fn pick_reader_scale(
    _max_side: u32,
    requested: comic_engines::ScaleFactor,
) -> comic_engines::ScaleFactor {
    // Real-CUGAN has no 1× weights (only up2x/up3x/up4x).
    if requested.as_u8() < 2 {
        comic_engines::ScaleFactor::X2
    } else {
        requested
    }
}

fn cache_ready(path: &Path) -> bool {
    path.is_file() && path.metadata().map(|m| m.len() > 128).unwrap_or(false)
}

fn passthrough_ext(path: &Path) -> Option<&'static str> {
    if let Ok(reader) = image::ImageReader::open(path).and_then(|r| r.with_guessed_format()) {
        return match reader.format() {
            Some(image::ImageFormat::Jpeg) => Some("jpg"),
            Some(image::ImageFormat::Png) => Some("png"),
            _ => None,
        };
    }
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => Some("jpg"),
        Some("png") => Some("png"),
        _ => None,
    }
}

fn write_engine_input(original: &Path, dest: &Path, cap: u32) -> AppResult<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let img = crate::image_io::prepare_for_engine(crate::image_io::load_image(original)?);
    let img = if img.width().max(img.height()) > cap {
        img.resize(cap, cap, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    crate::image_io::write_engine_png(&img, dest)
}

fn link_or_copy(src: &Path, dest: &Path) -> AppResult<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if dest.exists() {
        let _ = std::fs::remove_file(dest);
    }
    std::fs::hard_link(src, dest).or_else(|_| std::fs::copy(src, dest).map(|_| ()))?;
    Ok(())
}

/// Prefer the original file when it is already small enough; otherwise write a resized JPEG.
fn prepare_reader_input(
    original: &Path,
    scratch: &Path,
    stem: &str,
    requested: comic_engines::ScaleFactor,
    cap: u32,
) -> AppResult<(PathBuf, bool, comic_engines::ScaleFactor)> {
    let max_side = image_max_side(original)?;
    let scale = pick_reader_scale(max_side, requested);
    if max_side <= cap {
        if passthrough_ext(original).is_some() {
            return Ok((original.to_path_buf(), false, scale));
        }
        let dest = scratch.join(format!("{stem}-in.png"));
        let img = crate::image_io::prepare_for_engine(crate::image_io::load_image(original)?);
        crate::image_io::write_engine_png(&img, &dest)?;
        return Ok((dest, true, scale));
    }
    let dest = scratch.join(format!("{stem}-in.png"));
    write_engine_input(original, &dest, cap)?;
    Ok((dest, true, scale))
}

fn harvest_output(dir: &Path, stem: &str) -> Option<PathBuf> {
    for ext in ["jpg", "jpeg", "png", "webp"] {
        let p = dir.join(format!("{stem}.{ext}"));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn install_cache(tmp: &Path, dest: &Path) -> AppResult<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(tmp, dest).or_else(|_| {
        std::fs::copy(tmp, dest).map(|_| {
            let _ = std::fs::remove_file(tmp);
        })
    })?;
    Ok(())
}

/// Unique scratch files so concurrent jobs for the same page cannot delete each other's input.
async fn enhance_one_page(
    engine: Arc<dyn UpscaleEngine>,
    gpu: GpuLock,
    original: &Path,
    dest: &Path,
    params: comic_engines::EnhanceParams,
    cancel: CancellationToken,
    cfg: &AppConfig,
) -> AppResult<()> {
    if cache_ready(dest) {
        return Ok(());
    }
    if dest.is_file() {
        let _ = std::fs::remove_file(dest);
    }
    let scratch = cfg.reader_enhance_dir().join(".scratch");
    std::fs::create_dir_all(&scratch)?;
    let id = Uuid::new_v4();
    let id_s = id.to_string();
    let cap = if params.engine == comic_engines::EngineKind::RealEsrganCoreMl {
        ESRGAN_INPUT_SIDE
    } else {
        MAX_INPUT_SIDE
    };
    let (prepared, owned_in, scale) =
        prepare_reader_input(original, &scratch, &id_s, params.scale, cap)?;
    let mut params = params;
    params.scale = scale;
    let tmp = scratch.join(format!("{id}-out.jpg"));

    let cleanup = || {
        if owned_in {
            let _ = std::fs::remove_file(&prepared);
        }
        let _ = std::fs::remove_file(&tmp);
    };

    if cache_ready(dest) {
        cleanup();
        return Ok(());
    }
    if cancel.is_cancelled() {
        cleanup();
        return Err(AppError::cancelled());
    }

    let _guard = gpu.lock().await;
    if cache_ready(dest) {
        drop(_guard);
        cleanup();
        return Ok(());
    }
    if cancel.is_cancelled() {
        drop(_guard);
        cleanup();
        return Err(AppError::cancelled());
    }
    if !prepared.is_file() {
        drop(_guard);
        cleanup();
        return Err(AppError::invalid(format!(
            "输入图不存在: {}",
            prepared.display()
        )));
    }

    let run = engine
        .enhance_batch(
            EnhanceBatchRequest::SingleFile {
                input: prepared.clone(),
                output: tmp.clone(),
                params,
            },
            cancel,
        )
        .await;
    drop(_guard);
    if owned_in {
        let _ = std::fs::remove_file(&prepared);
    }
    run?;
    if !tmp.is_file() {
        cleanup();
        return Err(AppError::internal("增强输出未生成"));
    }
    install_cache(&tmp, dest)?;
    if !cache_ready(dest) {
        let _ = std::fs::remove_file(dest);
        return Err(AppError::internal("增强结果无效"));
    }
    evict_cache(cfg, MAX_CACHE_BYTES, MAX_CACHE_FILES)?;
    Ok(())
}

/// Enhance pages: cache hit returns immediately; misses share one engine process when possible.
pub async fn enhance_pages(
    source: &Path,
    page_indexes: &[u32],
    options: Option<EnhanceOptionsDto>,
    engine: Arc<dyn UpscaleEngine>,
    gpu: GpuLock,
    cfg: &AppConfig,
    cancel: CancellationToken,
) -> AppResult<Vec<ReaderPageFile>> {
    if page_indexes.is_empty() {
        return Err(AppError::invalid("需要至少一页"));
    }
    if cancel.is_cancelled() {
        return Err(AppError::cancelled());
    }
    let mut opts = options_from_dto(options.clone())?;
    opts.engine = match options.as_ref().and_then(|o| o.engine.as_deref()) {
        Some("realesrgan-coreml") | Some("esrgan-coreml") | Some("esrgan-anime") => {
            comic_engines::EngineKind::RealEsrganCoreMl
        }
        _ => comic_engines::EngineKind::Waifu2xCoreMl,
    };
    let params = reader_engine_params(&opts);
    let sig = cache_signature(options.as_ref())?;
    let names = crate::reader::listed_pages(source, cfg)
        .map(|(_, n)| n)
        .unwrap_or_default();
    let mut out = Vec::with_capacity(page_indexes.len());
    let mut missing: Vec<(u32, String, PathBuf, PathBuf)> = Vec::new();

    for &i in page_indexes {
        let dest = cache_file(cfg, source, i, &sig);
        let name = names
            .get(i as usize)
            .cloned()
            .unwrap_or_else(|| format!("page-{i}"));
        if cache_ready(&dest) {
            touch_mtime(&dest);
            out.push(ReaderPageFile {
                index: i,
                name,
                kind: "enhanced".into(),
                path: dest.display().to_string(),
            });
            continue;
        }
        let (extracted_name, original) = extract_original(source, i, cfg)?;
        missing.push((i, extracted_name, original, dest));
    }

    if missing.is_empty() {
        return Ok(out);
    }
    if cancel.is_cancelled() {
        return if out.is_empty() {
            Err(AppError::cancelled())
        } else {
            Ok(out)
        };
    }

    if missing.len() == 1 {
        let (i, name, original, dest) = missing.remove(0);
        enhance_one_page(engine, gpu, &original, &dest, params, cancel, cfg).await?;
        out.push(ReaderPageFile {
            index: i,
            name,
            kind: "enhanced".into(),
            path: dest.display().to_string(),
        });
        return Ok(out);
    }

    // Group by adaptive scale so one process can share a model load.
    let batch_root = cfg
        .reader_enhance_dir()
        .join(".batch")
        .join(Uuid::new_v4().to_string());
    let mut groups: std::collections::BTreeMap<u8, Vec<(u32, String, PathBuf)>> =
        std::collections::BTreeMap::new();
    for (i, name, original, dest) in missing {
        let stem = format!("{i:04}");
        let cap = if params.engine == comic_engines::EngineKind::RealEsrganCoreMl {
            ESRGAN_INPUT_SIDE
        } else {
            MAX_INPUT_SIDE
        };
        match prepare_reader_input(
            &original,
            &batch_root.join("prep"),
            &stem,
            params.scale,
            cap,
        ) {
            Ok((prepared, owned, scale)) => {
                let batch_in = batch_root.join(format!("in-s{}", scale.as_u8()));
                let ext = passthrough_ext(&prepared).unwrap_or("jpg");
                let staged = batch_in.join(format!("{stem}.{ext}"));
                if let Err(e) = if owned {
                    if let Some(parent) = staged.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    std::fs::rename(&prepared, &staged)
                        .or_else(|_| {
                            std::fs::copy(&prepared, &staged).map(|_| {
                                let _ = std::fs::remove_file(&prepared);
                            })
                        })
                        .map_err(AppError::from)
                } else {
                    link_or_copy(&prepared, &staged)
                } {
                    let _ = std::fs::remove_dir_all(&batch_root);
                    return Err(e);
                }
                groups
                    .entry(scale.as_u8())
                    .or_default()
                    .push((i, name, dest));
            }
            Err(e) => {
                let _ = std::fs::remove_dir_all(&batch_root);
                return Err(e);
            }
        }
    }

    if cancel.is_cancelled() {
        let _ = std::fs::remove_dir_all(&batch_root);
        return if out.is_empty() {
            Err(AppError::cancelled())
        } else {
            Ok(out)
        };
    }

    let mut last_err: Option<AppError> = None;
    for (scale, pages) in groups {
        if cancel.is_cancelled() {
            break;
        }
        let mut p = params.clone();
        p.scale = match comic_engines::ScaleFactor::try_from_u8(scale) {
            Ok(s) => s,
            Err(e) => {
                last_err = Some(AppError::invalid(e));
                continue;
            }
        };
        let batch_in = batch_root.join(format!("in-s{scale}"));
        let batch_out = batch_root.join(format!("out-s{scale}"));
        if let Err(e) = std::fs::create_dir_all(&batch_out) {
            last_err = Some(e.into());
            continue;
        }
        let _guard = gpu.lock().await;
        if cancel.is_cancelled() {
            drop(_guard);
            break;
        }
        let result = engine
            .enhance_batch(
                EnhanceBatchRequest::Directory {
                    input_dir: batch_in,
                    output_dir: batch_out.clone(),
                    params: p,
                },
                cancel.clone(),
            )
            .await;
        drop(_guard);
        if let Err(e) = result {
            last_err = Some(e.into());
        }
        for (i, name, dest) in pages {
            let stem = format!("{i:04}");
            if let Some(found) = harvest_output(&batch_out, &stem) {
                if install_cache(&found, &dest).is_ok() && cache_ready(&dest) {
                    out.push(ReaderPageFile {
                        index: i,
                        name,
                        kind: "enhanced".into(),
                        path: dest.display().to_string(),
                    });
                } else {
                    let _ = std::fs::remove_file(&dest);
                }
            }
        }
    }
    let _ = std::fs::remove_dir_all(&batch_root);
    evict_cache(cfg, MAX_CACHE_BYTES, MAX_CACHE_FILES)?;

    if out.is_empty() {
        return Err(last_err.unwrap_or_else(|| AppError::internal("增强输出未生成")));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::new_gpu_lock;
    use comic_engines::MockEngine;
    use image::{ImageBuffer, Rgb};

    fn folder_with_pages(dir: &Path, n: u32) {
        std::fs::create_dir_all(dir).unwrap();
        for i in 0..n {
            let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
                ImageBuffer::from_pixel(8, 6, Rgb([i as u8, 2, 3]));
            image::DynamicImage::ImageRgb8(img)
                .save(dir.join(format!("{i:04}.png")))
                .unwrap();
        }
    }

    fn test_cfg(tmp: &Path) -> AppConfig {
        let mut cfg = AppConfig::default();
        cfg.work_root = tmp.join("work");
        cfg.ensure_dirs().unwrap();
        cfg
    }

    #[test]
    fn signature_defaults_to_waifu2x_coreml() {
        let a = cache_signature(None).unwrap();
        assert!(a.starts_with("waifu2x-coreml-"), "{a}");
        let b = cache_signature(Some(&EnhanceOptionsDto {
            engine: Some("realesrgan-coreml".into()),
            ..Default::default()
        }))
        .unwrap();
        assert!(b.starts_with("realesrgan-coreml-"), "{b}");
        assert_ne!(a, b);
        let remapped = cache_signature(Some(&EnhanceOptionsDto {
            engine: Some("realcugan".into()),
            ..Default::default()
        }))
        .unwrap();
        assert!(remapped.starts_with("waifu2x-coreml-"), "{remapped}");
    }

    #[test]
    fn evict_drops_oldest() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = test_cfg(tmp.path());
        let root = cfg.reader_enhance_dir();
        let dir = root.join("book").join("sig");
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..5u32 {
            let p = dir.join(format!("{i:04}.png"));
            std::fs::write(&p, vec![1u8; 64]).unwrap();
            let t = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(10 + i as u64);
            let f = std::fs::File::open(&p).unwrap();
            f.set_modified(t).unwrap();
        }
        evict_cache(&cfg, 64 * 3, 3).unwrap();
        let left = collect_cache_files(&root);
        assert_eq!(left.len(), 3);
    }

    #[tokio::test]
    async fn enhance_then_lookup_hits() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("pages");
        folder_with_pages(&src, 2);
        let cfg = test_cfg(tmp.path());
        let engine: Arc<dyn UpscaleEngine> = Arc::new(MockEngine { delay_ms: 0 });
        let gpu = new_gpu_lock();
        let opts = Some(EnhanceOptionsDto {
            engine: Some("realcugan".into()),
            scale: Some(2),
            ..Default::default()
        });
        let first = enhance_pages(
            &src,
            &[0, 1],
            opts.clone(),
            engine.clone(),
            gpu.clone(),
            &cfg,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(first.len(), 2);
        assert!(first.iter().all(|p| p.kind == "enhanced"));
        for p in &first {
            assert!(PathBuf::from(&p.path).is_file());
        }
        let hit = lookup_pages(&src, &[0, 1], opts.clone(), &cfg).unwrap();
        assert_eq!(hit.len(), 2);
        let again = enhance_pages(
            &src,
            &[0],
            opts,
            engine,
            gpu,
            &cfg,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(again[0].path, first[0].path);
        let stats = cache_stats(&cfg);
        assert_eq!(stats.files, 2);
        let cleared = clear_cache(&cfg).unwrap();
        assert_eq!(cleared.removed, 2);
        assert!(lookup_pages(&src, &[0], None, &cfg).unwrap().is_empty());
    }
}
