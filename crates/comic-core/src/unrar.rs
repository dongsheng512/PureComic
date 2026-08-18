//! CBR / RAR import via **system** `unrar` / `UnRAR` (never bundled).

use crate::config::AppConfig;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::image_io::is_image_path;
use crate::natural_sort::natural_cmp;
use crate::security::{check_entry_limits, sanitize_entry_path};
use std::path::{Path, PathBuf};
use std::process::Command;

const INSTALL_HINT: &str = "CBR/RAR 需要系统安装 UnRAR（本应用不捆绑）。\
macOS：brew install unrar，或从 https://www.rarlab.com/rar_add.htm 下载；\
Linux：sudo apt install unrar；\
Windows：将 UnRAR.exe 加入 PATH。";

pub fn unrar_missing() -> AppError {
    AppError::new(ErrorCode::UnrarMissing, "未找到系统 unrar").with_detail(INSTALL_HINT)
}

/// Resolve unrar binary: config / env / PATH / common brew locations.
pub fn resolve_unrar(cfg: &AppConfig) -> Option<PathBuf> {
    if let Some(p) = &cfg.unrar_bin {
        return p.is_file().then(|| p.clone());
    }
    if let Ok(p) = std::env::var("COMIC_UNRAR_BIN") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    let names = ["unrar", "UnRAR", "unrar.exe", "UnRAR.exe"];
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for name in names {
                let cand = dir.join(name);
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }
    }
    for cand in [
        "/opt/homebrew/bin/unrar",
        "/usr/local/bin/unrar",
        "/usr/bin/unrar",
        "/opt/local/bin/unrar",
    ] {
        let p = PathBuf::from(cand);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

pub fn require_unrar(cfg: &AppConfig) -> AppResult<PathBuf> {
    resolve_unrar(cfg).ok_or_else(unrar_missing)
}

/// Bare file list inside the RAR/CBR (`unrar lb`).
pub fn list_rar_entries(cfg: &AppConfig, archive: &Path) -> AppResult<Vec<String>> {
    let bin = require_unrar(cfg)?;
    let out = Command::new(&bin)
        .args(["lb", "-idq", "-p-"])
        .arg(archive)
        .output()
        .map_err(|_| unrar_missing())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        return Err(AppError::new(
            ErrorCode::UnsupportedFormat,
            format!("无法列出 CBR/RAR 内容: {}{}", err.trim(), stdout.trim()),
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut names = Vec::new();
    for line in text.lines() {
        let name = line.trim().replace('\\', "/");
        if name.is_empty() || name.ends_with('/') {
            continue;
        }
        names.push(name);
    }
    Ok(names)
}

pub fn list_rar_images(
    cfg: &AppConfig,
    archive: &Path,
) -> AppResult<(Vec<String>, bool, Vec<String>)> {
    let entries = list_rar_entries(cfg, archive)?;
    let mut images = Vec::new();
    let mut has_comic_info = false;
    let mut warnings = Vec::new();
    let mut total_uncomp = 0u64;
    for (i, name) in entries.iter().enumerate() {
        let safe = sanitize_entry_path(name)?;
        let safe_str = safe.to_string_lossy().replace('\\', "/");
        check_entry_limits(cfg, i as u32, 0, 0, total_uncomp)?;
        total_uncomp = total_uncomp.saturating_add(1);
        if safe_str.eq_ignore_ascii_case("ComicInfo.xml") || safe_str.ends_with("/ComicInfo.xml") {
            has_comic_info = true;
            continue;
        }
        if crate::archive::is_ignored_archive_entry(&safe_str) {
            continue;
        }
        if is_image_path(Path::new(&safe_str)) {
            images.push(safe_str);
        }
    }
    images.sort_by(|a, b| natural_cmp(a, b));
    if images.is_empty() {
        return Err(AppError::unsupported("CBR/RAR 中未找到图片页"));
    }
    if images.len() as u32 > cfg.max_archive_entries {
        warnings.push("页数接近上限".into());
    }
    Ok((images, has_comic_info, warnings))
}

/// Extract entire archive into `dest` (creates dir).
pub fn extract_rar_archive(cfg: &AppConfig, archive: &Path, dest: &Path) -> AppResult<()> {
    let bin = require_unrar(cfg)?;
    std::fs::create_dir_all(dest)?;
    let dest_str = dest
        .to_str()
        .ok_or_else(|| AppError::invalid("解压路径包含非法字符"))?;
    let dest_arg = if dest_str.ends_with('/') {
        dest_str.to_string()
    } else {
        format!("{dest_str}/")
    };
    let out = Command::new(&bin)
        .args(["x", "-o+", "-idq", "-p-"])
        .arg(archive)
        .arg(&dest_arg)
        .output()
        .map_err(|e| AppError::internal(format!("启动 unrar 失败: {e}")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::new(
            ErrorCode::ProcessFail,
            format!("unrar 解压失败: {}", err.trim()),
        ));
    }
    Ok(())
}

/// Extract one archived file to `dest` (original bytes).
pub fn extract_rar_file(
    cfg: &AppConfig,
    archive: &Path,
    entry_name: &str,
    dest: &Path,
) -> AppResult<()> {
    let bin = require_unrar(cfg)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let out = Command::new(&bin)
        .args(["p", "-inul", "-p-"])
        .arg(archive)
        .arg(entry_name)
        .output()
        .map_err(|e| AppError::internal(format!("启动 unrar 失败: {e}")))?;
    if !out.status.success() || out.stdout.is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::not_found(format!(
            "CBR 中找不到页 {entry_name}: {}",
            err.trim()
        )));
    }
    std::fs::write(dest, &out.stdout)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_unrar_is_explicit() {
        let cfg = AppConfig {
            unrar_bin: Some(PathBuf::from("/no/such/unrar-binary")),
            ..Default::default()
        };
        // Isolate PATH so we don't accidentally find a system unrar
        let err = require_unrar(&cfg).unwrap_err();
        assert_eq!(err.code, ErrorCode::UnrarMissing);
        assert!(err.message.contains("unrar"));
    }

    #[test]
    fn missing_error_mentions_install() {
        let e = unrar_missing();
        assert_eq!(e.code, ErrorCode::UnrarMissing);
        assert!(e.detail.unwrap_or_default().contains("brew install unrar"));
    }
}
