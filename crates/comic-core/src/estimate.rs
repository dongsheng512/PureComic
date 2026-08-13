//! Disk usage estimation: RGBA intermediate model + free space check.

use crate::archive::validate_source;
use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
use crate::image_io;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskEstimate {
    pub estimate_bytes: u64,
    pub free_bytes: u64,
    pub ok: bool,
    pub page_count: u32,
    pub message: Option<String>,
}

/// Rough estimate: sum of decoded RGBA * scale^2 * 2 (in+out) * safety 1.2
/// For sources we cannot decode yet, use 1200*1800*4 as page default.
pub fn estimate_disk_usage(path: &Path, scale: u8, cfg: &AppConfig) -> AppResult<DiskEstimate> {
    let v = validate_source(path, cfg)?;
    let scale = scale.max(1) as u64;
    let safety_num = 12u64;
    let safety_den = 10u64;

    let mut rgba_sum: u64 = 0;
    // Sample first few pages if folder/zip already validated names — use defaults for speed
    let default_page = 1200u64 * 1800 * 4;
    for name in v.page_names.iter().take(5) {
        let sample = match v.kind {
            crate::job::SourceKind::Folder => {
                let p = path.join(name);
                image_io::load_image(&p)
                    .ok()
                    .map(|img| (img.width() as u64) * (img.height() as u64) * 4)
            }
            _ => None,
        };
        rgba_sum = rgba_sum.saturating_add(sample.unwrap_or(default_page));
    }
    let sampled = v.page_names.len().min(5) as u64;
    let avg = rgba_sum.checked_div(sampled).unwrap_or(default_page);
    let per_page = avg
        .saturating_mul(scale)
        .saturating_mul(scale)
        .saturating_mul(2)
        .saturating_mul(safety_num)
        / safety_den;
    let estimate_bytes = per_page.saturating_mul(v.page_count as u64);

    let free_bytes = cfg
        .forced_free_bytes
        .or_else(|| {
            let _ = std::fs::create_dir_all(&cfg.work_root);
            free_space(&cfg.work_root).ok()
        })
        .unwrap_or(0);
    let ok = disk_is_sufficient(free_bytes, estimate_bytes);
    let message = if !ok {
        Some(format!(
            "磁盘空间不足：预计需要约 {}，当前可用 {}，已拒绝启动",
            human_bytes(estimate_bytes),
            human_bytes(free_bytes)
        ))
    } else {
        None
    };

    Ok(DiskEstimate {
        estimate_bytes,
        free_bytes,
        ok,
        page_count: v.page_count,
        message,
    })
}

fn free_space(path: &Path) -> std::io::Result<u64> {
    // Ensure path exists for statfs
    let p = if path.exists() {
        path.to_path_buf()
    } else {
        std::env::temp_dir()
    };
    fs2::available_space(p)
}

/// Reject when free space is unknown (0) or not strictly greater than the estimate.
pub fn disk_is_sufficient(free_bytes: u64, estimate_bytes: u64) -> bool {
    free_bytes > 0 && free_bytes > estimate_bytes
}

pub fn assert_disk_ok(path: &Path, scale: u8, cfg: &AppConfig) -> AppResult<DiskEstimate> {
    let est = estimate_disk_usage(path, scale, cfg)?;
    if !est.ok {
        return Err(AppError::disk(
            est.message.clone().unwrap_or_else(|| "磁盘空间不足".into()),
        ));
    }
    Ok(est)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppConfig;
    use image::{ImageBuffer, Rgb};

    #[test]
    fn insufficient_when_free_zero_or_too_small() {
        assert!(!disk_is_sufficient(0, 100));
        assert!(!disk_is_sufficient(100, 100));
        assert!(disk_is_sufficient(101, 100));
    }

    #[test]
    fn hundred_pages_rejected_when_forced_small_disk() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("pages");
        std::fs::create_dir_all(&src).unwrap();
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_pixel(8, 8, Rgb([1, 2, 3]));
        for i in 0..120 {
            image::DynamicImage::ImageRgb8(img.clone())
                .save(src.join(format!("{i:03}.png")))
                .unwrap();
        }
        let mut cfg = AppConfig::default();
        cfg.work_root = dir.path().join("work");
        cfg.forced_free_bytes = Some(1024);
        let est = estimate_disk_usage(&src, 2, &cfg).unwrap();
        assert!(est.page_count >= 100);
        assert!(!est.ok);
        let err = assert_disk_ok(&src, 2, &cfg).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::DiskInsufficient);
        assert!(err.message.contains("磁盘空间不足"));
    }
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
