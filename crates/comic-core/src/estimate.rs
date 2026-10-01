//! Disk usage estimation for an enhance job.
//!
//! 旧模型是「平均页 RGBA × scale² × 2 × 1.2」，有两个硬伤：
//!   1. 压缩包（CBZ/ZIP/CBR/EPUB/MOBI）一律用写死的 1200×1800 页，
//!      完全不看真实尺寸——一张 4800×7568 的扫描页被低估 16 倍；
//!   2. 管线落盘的是**编码后的文件**（源页 / 引擎输出 / 导出物），
//!      不是 RGBA 缓冲。按 RGBA 算等于凭空乘了 4 字节/像素。
//!
//! 实测：1.08 GiB 的《四万十食堂》被估成 12.67 GB，而真实峰值约 3.4 GiB。
//!
//! 现在的模型按管线真实的三个阶段累加：
//!   in_dir   —— 解出来的源页，≈ 包内页条目字节和（STORED 包≈包体积）
//!   out_dir  —— 引擎输出；Real-CUGAN 直出 JPEG，其余引擎写 PNG 中间页
//!   导出物   —— 最终 CBZ/ZIP/Folder
//!
//! 每页输出像素按 `pipeline.rs` 同一套上限推导；压缩后字节数用**源页自身的
//! bpp** 当内容代理（线稿低、彩页高），再乘编码器效率系数，而不是写死常数。

use crate::archive::validate_source;
use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
use crate::image_io;
use crate::job::{ImageFormat, SourceKind};
use comic_engines::EngineKind;
use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskEstimate {
    /// 整本作业的峰值占用（工作盘 in+out，加上导出物）
    pub estimate_bytes: u64,
    /// 预计最终导出物体积
    pub output_bytes: u64,
    pub free_bytes: u64,
    pub ok: bool,
    pub page_count: u32,
    pub message: Option<String>,
}

/// 没有可用的页尺寸时退回的兜底页
const DEFAULT_PAGE: (u32, u32) = (1200, 1800);
/// 抽样几页来代表整本（够稳且几乎不耗时）
const SAMPLE_PAGES: usize = 5;
/// Real-ESRGAN 的输入长边上限，与 pipeline.rs 的 input_cap 一致
/// （AnimeVideo 走 cfg.engine_input_max_side，见 model_bytes）
const ESRGAN_INPUT_CAP: u32 = 2560;
/// 源页 bpp → 输出 JPEG bpp 的效率系数（本项目的编码器略优于源编码器）
const JPEG_EFFICIENCY: f64 = 0.9;
/// bpp 夹取区间：防止一张纯色页或极端彩页把整本估算带飞
const JPEG_BPP_MIN: f64 = 0.04;
const JPEG_BPP_MAX: f64 = 0.9;
/// 源页 bpp 兜底值：字节总量未知（MOBI/EPUB/CBR 等）时的中性估计，
/// 取夹取区间中位而非 MIN——MIN 会让整本按纯色页低估
const FALLBACK_SRC_BPP: f64 = 0.25;
/// PNG 中间页实测 bpp（真实引擎输出，按页抽样）
const PNG_BPP: f64 = 1.3;
/// 安全系数
const SAFETY: f64 = 1.1;

/// 估算需要知道的作业参数：引擎决定中间页编码，格式决定导出编码。
#[derive(Debug, Clone, Copy)]
pub struct EstimateParams {
    pub scale: u8,
    pub engine: EngineKind,
    pub image_format: ImageFormat,
}

impl Default for EstimateParams {
    fn default() -> Self {
        Self {
            scale: 2,
            engine: EngineKind::RealCuganCoreMl,
            image_format: ImageFormat::Jpeg,
        }
    }
}

/// 源页抽样结果：平均页尺寸 + 源页字节总量
#[derive(Debug, Clone, Copy)]
struct SourceSample {
    avg_w: u32,
    avg_h: u32,
    /// 解压后页字节总和；未知时为 0
    source_bytes: u64,
    /// 首页扩展名（小写，jpeg 归一为 jpg）：Same 格式按它选导出 bpp 模型，
    /// 与 pipeline.rs 的 output_format 推断同口径；None 视为 jpeg
    first_ext: Option<&'static str>,
}

pub fn estimate_disk_usage(
    path: &Path,
    params: EstimateParams,
    cfg: &AppConfig,
    output_dir: Option<&Path>,
) -> AppResult<DiskEstimate> {
    let validated = validate_source(path, cfg)?;
    Ok(estimate_validated(
        path, params, cfg, output_dir, &validated,
    ))
}

/// Estimate from an existing validate result. Does not open the archive again.
pub fn estimate_validated(
    path: &Path,
    params: EstimateParams,
    cfg: &AppConfig,
    output_dir: Option<&Path>,
    validated: &crate::archive::ValidateResult,
) -> DiskEstimate {
    let sample = sample_source(path, validated);
    let breakdown = model_bytes(&sample, params, validated.page_count, cfg);
    // 异盘断言：工作盘峰值查工作卷，导出物查输出卷；同盘时两轴相加后查一次。
    // 输出目录无法定位卷（未选/路径不存在）时按同盘保守处理。
    let (free_bytes, ok, need) = if let Some(forced) = cfg.forced_free_bytes {
        (
            forced,
            disk_is_sufficient(forced, breakdown.peak),
            breakdown.peak,
        )
    } else {
        let _ = std::fs::create_dir_all(&cfg.work_root);
        let work_free = volume_free(&cfg.work_root);
        let out_dir = output_dir.filter(|p| p.is_dir());
        let out_free = out_dir.and_then(volume_free);
        let same_volume = match (out_dir, out_free) {
            (Some(dir), Some(_)) => {
                std::fs::canonicalize(dir)
                    .ok()
                    .and_then(|d| d.components().next().map(|c| c.as_os_str().to_owned()))
                    == std::fs::canonicalize(&cfg.work_root)
                        .ok()
                        .and_then(|d| d.components().next().map(|c| c.as_os_str().to_owned()))
            }
            _ => true,
        };
        if same_volume {
            let need = breakdown.peak;
            let free = work_free.or(out_free).unwrap_or(0);
            (free, disk_is_sufficient(free, need), need)
        } else {
            // 各查各卷：任一卷不足即不放行；展示用两卷较小值（前端单字段）
            let work_need = (breakdown.work as f64 * SAFETY) as u64;
            let out_need = (breakdown.output as f64 * SAFETY) as u64;
            let work_ok = disk_is_sufficient(work_free.unwrap_or(0), work_need);
            let out_ok = disk_is_sufficient(out_free.unwrap_or(0), out_need);
            let free = match (work_free, out_free) {
                (Some(a), Some(b)) => a.min(b),
                (Some(a), None) => a,
                (None, Some(b)) => b,
                (None, None) => 0,
            };
            (free, work_ok && out_ok, breakdown.peak)
        }
    };
    let message = if !ok {
        Some(format!(
            "磁盘空间不足：预计需要约 {}，当前可用 {}，已拒绝启动",
            human_bytes(need),
            human_bytes(free_bytes)
        ))
    } else {
        None
    };
    DiskEstimate {
        estimate_bytes: breakdown.peak,
        output_bytes: breakdown.output,
        free_bytes,
        ok,
        page_count: validated.page_count,
        message,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Breakdown {
    /// 工作盘峰值：in_dir + out_dir（未乘安全系数）
    work: u64,
    /// 导出物体积（未乘安全系数）
    output: u64,
    /// (work + output) × SAFETY：同卷总需求；异盘时仅作展示口径
    peak: u64,
}

fn model_bytes(
    sample: &SourceSample,
    params: EstimateParams,
    page_count: u32,
    cfg: &AppConfig,
) -> Breakdown {
    if page_count == 0 {
        return Breakdown {
            work: 0,
            output: 0,
            peak: 0,
        };
    }
    let pages_f = f64::from(page_count);
    let scale = u64::from(params.scale.max(1));

    // 与 pipeline.rs 相同的输入上限：Real-ESRGAN 用 2560，其余用配置值
    let cap = if matches!(params.engine, EngineKind::RealEsrganCoreMl) {
        ESRGAN_INPUT_CAP
    } else {
        cfg.engine_input_max_side.max(1)
    };

    // 单页：源像素 → 引擎输入像素（长边受 cap 限制）→ 输出像素（×scale²）
    let src_px = f64::from(sample.avg_w).max(1.0) * f64::from(sample.avg_h).max(1.0);
    let long_side = f64::from(sample.avg_w.max(sample.avg_h)).max(1.0);
    let shrink = (f64::from(cap) / long_side).min(1.0);
    let in_px = src_px * shrink * shrink;
    let mut out_px = in_px * (scale * scale) as f64;
    // Whole-book export scales the written page down to output_max_side.
    // Input cap stays put, so the model still sees the larger source.
    if cfg.output_max_side > 0 {
        let out_long = long_side * shrink * scale as f64;
        if out_long > f64::from(cfg.output_max_side) {
            let fit = f64::from(cfg.output_max_side) / out_long;
            out_px *= fit * fit;
        }
    }

    // 源页 bpp 作为内容代理；字节总量未知（MOBI/EPUB/CBR 解压后不可得）
    // 时退回中性 bpp——用 MIN 会把整本当纯色页系统性低估
    let src_bpp = if sample.source_bytes > 0 {
        sample.source_bytes as f64 / (pages_f * src_px)
    } else {
        FALLBACK_SRC_BPP
    };
    let jpeg_bpp = (src_bpp * JPEG_EFFICIENCY).clamp(JPEG_BPP_MIN, JPEG_BPP_MAX);
    let png_bpp = PNG_BPP.max(jpeg_bpp);

    // 引擎中间页：Real-CUGAN 在 JPEG 导出时直出 JPEG（导出可原样拷贝），
    // 其余引擎被 pipeline.rs 强制写成 PNG。规则与 pipeline.rs 保持一致。
    let intermediate_png = !(matches!(params.engine, EngineKind::RealCuganCoreMl)
        && matches!(params.image_format, ImageFormat::Jpeg));

    let jpeg_bytes = pages_f * out_px * jpeg_bpp;
    let intermediates = pages_f * out_px * if intermediate_png { png_bpp } else { jpeg_bpp };

    // 导出编码：JPEG 走我们的编码器；PNG 没压缩收益，规模与中间页同量级。
    // Same 按首页扩展选模型：PNG/WebP 源导出无损，按 png_bpp 算
    // （与 pipeline.rs 的 Same → output_format 推断同口径）
    let same_is_lossless = matches!(sample.first_ext, Some("png" | "webp"));
    let output = match params.image_format {
        ImageFormat::Png | ImageFormat::Webp => pages_f * out_px * png_bpp,
        ImageFormat::Jpeg => jpeg_bytes,
        ImageFormat::Same => {
            if same_is_lossless {
                pages_f * out_px * png_bpp
            } else {
                jpeg_bytes
            }
        }
    };

    let in_dir = sample.source_bytes as f64;
    let work = in_dir + intermediates;
    let peak = (work + output) * SAFETY;
    Breakdown {
        work: work as u64,
        output: output as u64,
        peak: peak as u64,
    }
}

/// 抽样源页几何与字节总量。只读图头，不解码整页。
fn sample_source(path: &Path, validated: &crate::archive::ValidateResult) -> SourceSample {
    let names = &validated.page_names;
    if names.is_empty() {
        return fallback_sample(path);
    }
    match validated.kind {
        SourceKind::Folder => sample_folder(path, names),
        SourceKind::Zip | SourceKind::Cbz => sample_zip(path, names),
        // EPUB / MOBI / CBR 的页不在普通 zip 里，退回包体积 + 兜底页尺寸
        _ => fallback_sample(path),
    }
}

fn fallback_sample(path: &Path) -> SourceSample {
    SourceSample {
        avg_w: DEFAULT_PAGE.0,
        avg_h: DEFAULT_PAGE.1,
        source_bytes: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        first_ext: None,
    }
}

/// Same 格式推断用的首页扩展名（jpeg 归一为 jpg）；非图片扩展返回 None
fn first_page_ext(names: &[String]) -> Option<&'static str> {
    let raw = names.first()?.rsplit('.').next()?;
    match raw.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some("jpg"),
        "png" => Some("png"),
        "webp" => Some("webp"),
        _ => None,
    }
}

fn sample_folder(path: &Path, names: &[String]) -> SourceSample {
    let mut total = 0u64;
    let mut dims = Vec::new();
    // 等距抽样几何：只取前几页会让封面/彩页权重偏高
    let step = names.len().div_ceil(SAMPLE_PAGES).max(1);
    for (i, name) in names.iter().enumerate() {
        let full = path.join(name);
        if let Ok(meta) = std::fs::metadata(&full) {
            total = total.saturating_add(meta.len());
        }
        if i % step == 0 && dims.len() < SAMPLE_PAGES {
            if let Ok((w, h)) = image_io::image_dimensions(&full) {
                if w > 0 && h > 0 {
                    dims.push((w, h));
                }
            }
        }
    }
    SourceSample {
        avg_w: average_side(&dims, 0),
        avg_h: average_side(&dims, 1),
        source_bytes: total,
        first_ext: first_page_ext(names),
    }
}

fn sample_zip(path: &Path, names: &[String]) -> SourceSample {
    let Ok(file) = std::fs::File::open(path) else {
        return fallback_sample(path);
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return fallback_sample(path);
    };
    // by_name 对中央目录是线性查找：几千页 × 每页一次 = O(n²)，先建索引
    // （file_names 借 archive 不可变，收集成 owned 后再可变使用）
    let index: std::collections::HashMap<String, usize> = archive
        .file_names()
        .map(str::to_owned)
        .enumerate()
        .map(|(i, n)| (n, i))
        .collect();
    let step = names.len().div_ceil(SAMPLE_PAGES).max(1);
    let mut total = 0u64;
    let mut dims = Vec::new();
    for (i, name) in names.iter().enumerate() {
        let Some(&idx) = index.get(name) else {
            continue;
        };
        let Ok(entry) = archive.by_index(idx) else {
            continue;
        };
        total = total.saturating_add(entry.size());
        if i % step == 0 && dims.len() < SAMPLE_PAGES {
            let mut buf = Vec::new();
            // 头部足够解码出宽高；限制读取量，避免为估算搬整页
            if entry.take(256 * 1024).read_to_end(&mut buf).is_ok() {
                if let Ok((w, h)) = dimensions_of(&buf) {
                    if w > 0 && h > 0 {
                        dims.push((w, h));
                    }
                }
            }
        }
    }
    if total == 0 {
        total = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    SourceSample {
        avg_w: average_side(&dims, 0),
        avg_h: average_side(&dims, 1),
        source_bytes: total,
        first_ext: first_page_ext(names),
    }
}

fn dimensions_of(bytes: &[u8]) -> AppResult<(u32, u32)> {
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| AppError::internal(format!("猜测图片格式失败: {e}")))?;
    reader
        .into_dimensions()
        .map_err(|e| AppError::internal(format!("读取图片尺寸失败: {e}")))
}

fn average_side(dims: &[(u32, u32)], idx: usize) -> u32 {
    let fallback = if idx == 0 {
        DEFAULT_PAGE.0
    } else {
        DEFAULT_PAGE.1
    };
    if dims.is_empty() {
        return fallback;
    }
    let sum: u64 = dims
        .iter()
        .map(|d| u64::from(if idx == 0 { d.0 } else { d.1 }))
        .sum();
    (sum / dims.len() as u64).max(1) as u32
}

/// Free space on the volume that holds `path`. Missing path is unknown, not the temp disk.
fn volume_free(path: &Path) -> Option<u64> {
    let probe = if path.exists() {
        path.to_path_buf()
    } else {
        path.parent()?.to_path_buf()
    };
    if !probe.exists() {
        return None;
    }
    fs2::available_space(probe).ok()
}

/// Reject when free space is unknown (0) or not strictly greater than the estimate.
pub fn disk_is_sufficient(free_bytes: u64, estimate_bytes: u64) -> bool {
    free_bytes > 0 && free_bytes > estimate_bytes
}

pub fn assert_disk_ok(
    path: &Path,
    params: EstimateParams,
    cfg: &AppConfig,
    output_dir: Option<&Path>,
) -> AppResult<DiskEstimate> {
    let est = estimate_disk_usage(path, params, cfg, output_dir)?;
    if !est.ok {
        return Err(AppError::disk(
            est.message.clone().unwrap_or_else(|| "磁盘空间不足".into()),
        ));
    }
    Ok(est)
}

fn human_bytes(n: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let x = n as f64;
    if x >= GB {
        format!("{:.2} GB", x / GB)
    } else if x >= MB {
        format!("{:.1} MB", x / MB)
    } else if x >= KB {
        format!("{:.0} KB", x / KB)
    } else {
        format!("{n} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(w: u32, h: u32, src_bytes: u64) -> SourceSample {
        SourceSample {
            avg_w: w,
            avg_h: h,
            source_bytes: src_bytes,
            first_ext: None,
        }
    }

    fn cfg_with_cap(cap: u32) -> AppConfig {
        AppConfig {
            engine_input_max_side: cap,
            output_max_side: 0,
            ..Default::default()
        }
    }

    #[test]
    fn insufficient_when_free_zero_or_too_small() {
        assert!(!disk_is_sufficient(0, 100));
        assert!(!disk_is_sufficient(100, 100));
        assert!(disk_is_sufficient(101, 100));
    }

    #[test]
    fn real_page_geometry_beats_the_old_flat_default() {
        // 4800x7568 扫描页、164 页、源 1.16 GB。导出长边收到 3200 后，
        // 峰值主要是解出来的源页，不再是 8192 宽的中间 JPEG。
        let cfg = AppConfig {
            output_max_side: 3200,
            ..cfg_with_cap(4096)
        };
        let params = EstimateParams::default();
        let b = model_bytes(&sample(4800, 7568, 1_156_838_038), params, 164, &cfg);
        let gib = 1024.0 * 1024.0 * 1024.0;
        let peak_gib = b.peak as f64 / gib;
        assert!(
            (1.2..=2.4).contains(&peak_gib),
            "peak {peak_gib:.2} GiB out of plausible range"
        );
        let uncapped = model_bytes(
            &sample(4800, 7568, 1_156_838_038),
            params,
            164,
            &cfg_with_cap(4096),
        );
        assert!(b.output < uncapped.output / 4);
    }

    #[test]
    fn jpeg_intermediates_are_far_cheaper_than_png() {
        let cfg = cfg_with_cap(4096);
        let s = sample(4800, 7568, 700_000_000);
        let jpeg = model_bytes(
            &s,
            EstimateParams {
                engine: EngineKind::RealCuganCoreMl,
                image_format: ImageFormat::Jpeg,
                scale: 2,
            },
            100,
            &cfg,
        );
        let png = model_bytes(
            &s,
            EstimateParams {
                engine: EngineKind::Waifu2xCoreMl,
                image_format: ImageFormat::Jpeg,
                scale: 2,
            },
            100,
            &cfg,
        );
        // waifu2x 走 PNG 中间页，工作盘占用应显著更高
        assert!(
            png.work > jpeg.work * 2,
            "png work {} should dwarf jpeg work {}",
            png.work,
            jpeg.work
        );
        // 但两者导出物都是 JPEG，体积应一致
        assert_eq!(png.output, jpeg.output);
    }

    #[test]
    fn input_cap_limits_output_pixels() {
        let small = model_bytes(
            &sample(4800, 7568, 50_000_000),
            EstimateParams::default(),
            10,
            &cfg_with_cap(4096),
        );
        let big = model_bytes(
            &sample(4800, 7568, 50_000_000),
            EstimateParams::default(),
            10,
            &cfg_with_cap(8192),
        );
        assert!(big.output > small.output);
    }

    #[test]
    fn esrgan_uses_its_own_smaller_cap() {
        let cfg = cfg_with_cap(4096);
        let s = sample(4800, 7568, 50_000_000);
        let cugan = model_bytes(
            &s,
            EstimateParams {
                engine: EngineKind::RealCuganCoreMl,
                image_format: ImageFormat::Jpeg,
                scale: 2,
            },
            10,
            &cfg,
        );
        let esrgan = model_bytes(
            &s,
            EstimateParams {
                engine: EngineKind::RealEsrganCoreMl,
                image_format: ImageFormat::Jpeg,
                scale: 4,
            },
            10,
            &cfg,
        );
        // ESRGAN 输入被压到 2560，但倍率是 4x
        assert!(esrgan.output > 0 && cugan.output > 0);
        assert_ne!(esrgan.output, cugan.output);
    }

    #[test]
    fn zero_pages_is_zero() {
        let b = model_bytes(
            &sample(100, 100, 0),
            EstimateParams::default(),
            0,
            &AppConfig::default(),
        );
        assert_eq!(
            b,
            Breakdown {
                work: 0,
                output: 0,
                peak: 0
            }
        );
    }

    #[test]
    fn peak_covers_source_plus_intermediates_plus_export() {
        let cfg = cfg_with_cap(4096);
        let b = model_bytes(
            &sample(4800, 7568, 400_000_000),
            EstimateParams::default(),
            50,
            &cfg,
        );
        assert!(
            b.work >= 400_000_000,
            "work must at least hold the extracted pages"
        );
        assert!(b.peak > b.work, "peak must include the export artefact");
        assert!(b.output > 0);
    }

    #[test]
    fn dimension_probe_reads_headers_without_full_decode() {
        use image::{ImageBuffer, Rgb};
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.jpg");
        let img: ImageBuffer<Rgb<u8>, _> = ImageBuffer::from_pixel(64, 48, Rgb([9, 9, 9]));
        image::DynamicImage::ImageRgb8(img)
            .save_with_format(&p, image::ImageFormat::Jpeg)
            .unwrap();
        let bytes = std::fs::read(&p).unwrap();
        assert_eq!(dimensions_of(&bytes).unwrap(), (64, 48));
    }

    #[test]
    fn create_job_path_is_rejected_when_the_volume_is_too_small() {
        use image::{ImageBuffer, Rgb};
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("pages");
        std::fs::create_dir_all(&src).unwrap();
        let img: ImageBuffer<Rgb<u8>, _> = ImageBuffer::from_pixel(64, 48, Rgb([1, 2, 3]));
        for i in 0..12 {
            image::DynamicImage::ImageRgb8(img.clone())
                .save_with_format(src.join(format!("{i:02}.jpg")), image::ImageFormat::Jpeg)
                .unwrap();
        }
        let cfg = AppConfig {
            work_root: dir.path().join("work"),
            forced_free_bytes: Some(1024),
            ..Default::default()
        };
        let est = estimate_disk_usage(&src, EstimateParams::default(), &cfg, None).unwrap();
        assert_eq!(est.page_count, 12);
        assert!(!est.ok);
        let err = assert_disk_ok(&src, EstimateParams::default(), &cfg, None).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::DiskInsufficient);
        assert!(err.message.contains("磁盘空间不足"));

        // 同一本书给足空间就应放行
        let roomy = AppConfig {
            forced_free_bytes: Some(1 << 40),
            ..cfg.clone()
        };
        assert!(assert_disk_ok(&src, EstimateParams::default(), &roomy, None).is_ok());
    }
}
