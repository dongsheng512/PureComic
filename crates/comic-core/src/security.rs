//! Archive safety limits: zip bomb, path traversal, symlink rejection.

use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
use std::path::{Component, Path, PathBuf};

pub fn sanitize_entry_path(name: &str) -> AppResult<PathBuf> {
    let path = Path::new(name);
    if path.is_absolute() {
        return Err(AppError::path_traversal(format!(
            "拒绝绝对路径条目: {name}"
        )));
    }
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::Normal(s) => out.push(s),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(AppError::path_traversal(format!("拒绝父目录穿越: {name}")));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::path_traversal(format!("拒绝非法路径: {name}")));
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err(AppError::path_traversal("空路径条目"));
    }
    Ok(out)
}

pub fn check_entry_limits(
    cfg: &AppConfig,
    entry_index: u32,
    compressed_size: u64,
    uncompressed_size: u64,
    total_uncompressed: u64,
) -> AppResult<()> {
    if entry_index >= cfg.max_archive_entries {
        return Err(AppError::new(
            crate::error::ErrorCode::UnsupportedFormat,
            format!("压缩包条目数超过上限 ({})", cfg.max_archive_entries),
        ));
    }
    if uncompressed_size > cfg.max_page_bytes {
        return Err(AppError::new(
            crate::error::ErrorCode::UnsupportedFormat,
            format!(
                "单文件解压后过大 ({} > {} bytes)",
                uncompressed_size, cfg.max_page_bytes
            ),
        ));
    }
    if total_uncompressed.saturating_add(uncompressed_size) > cfg.max_extract_bytes {
        return Err(AppError::disk(format!(
            "解压总量将超过上限 ({} bytes)",
            cfg.max_extract_bytes
        )));
    }
    // Zip-bomb 启发：仅当「解压后较大」且压缩比异常时拦截。
    // 小文件高压缩比（漫画线稿）很常见，不应拒绝。
    const RATIO_CHECK_MIN_UNCOMPRESSED: u64 = 8 * 1024 * 1024; // 8 MiB
    if compressed_size > 0 && uncompressed_size >= RATIO_CHECK_MIN_UNCOMPRESSED {
        let ratio = uncompressed_size as f64 / compressed_size as f64;
        if ratio > cfg.max_compression_ratio {
            return Err(AppError::new(
                crate::error::ErrorCode::UnsupportedFormat,
                format!(
                    "可疑压缩比 {:.1}（上限 {}，条目解压后 {} bytes）",
                    ratio, cfg.max_compression_ratio, uncompressed_size
                ),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal() {
        assert!(sanitize_entry_path("../etc/passwd").is_err());
        assert!(sanitize_entry_path("/abs/path").is_err());
        assert!(sanitize_entry_path("ok/page.jpg").is_ok());
    }

    #[test]
    fn allows_high_ratio_small_entries() {
        let cfg = AppConfig::default();
        // 5 MiB 解压 / ~45 KiB 压缩 ≈ 110×，漫画常见，且 < 8 MiB 门槛 → 放行
        assert!(check_entry_limits(&cfg, 0, 45_000, 5_000_000, 0).is_ok());
    }

    #[test]
    fn rejects_bomb_like_ratio_on_large_entry() {
        let cfg = AppConfig::default();
        // 50 MiB / 50 KiB = 1000× > 500，且解压后 ≥ 8 MiB → 拒绝
        assert!(check_entry_limits(&cfg, 0, 50_000, 50 * 1024 * 1024, 0).is_err());
    }
}
