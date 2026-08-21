//! CBR / RAR import via **system** `unrar` / `UnRAR` (never bundled).

use crate::config::AppConfig;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::image_io::is_image_path;
use crate::natural_sort::natural_cmp;
use crate::security::sanitize_entry_path;
use std::path::{Path, PathBuf};
use std::process::Command;

const INSTALL_HINT: &str = "CBR/RAR 需要系统安装 UnRAR（本应用不捆绑）。\
macOS：brew install unrar，或从 https://www.rarlab.com/rar_add.htm 下载；\
Linux：sudo apt install unrar；\
Windows：将 UnRAR.exe 加入 PATH。";

pub fn unrar_missing() -> AppError {
    AppError::new(ErrorCode::UnrarMissing, "未找到系统 unrar").with_detail(INSTALL_HINT)
}

/// Resolve unrar binary: config / env (debug only) / PATH / common brew locations.
pub fn resolve_unrar(cfg: &AppConfig) -> Option<PathBuf> {
    if let Some(p) = &cfg.unrar_bin {
        return p.is_file().then(|| p.clone());
    }
    // release 包忽略 COMIC_UNRAR_BIN 注入（外部二进制等同可执行代码）
    #[cfg(debug_assertions)]
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
    for (i, name) in entries.iter().enumerate() {
        // `lb` 只给名字、无尺寸信息：条目数硬上限在此执行，
        // 尺寸类限制（单页/总量）移到逐条解压时按真实字节数执行
        if i as u32 >= cfg.max_archive_entries {
            return Err(AppError::new(
                ErrorCode::UnsupportedFormat,
                format!("压缩包条目数超过上限 ({})", cfg.max_archive_entries),
            ));
        }
        let safe = sanitize_entry_path(name)?;
        let safe_str = safe.to_string_lossy().replace('\\', "/");
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

/// 逐条解压指定条目到 `dest_dir`（替代整包 `unrar x`）：
/// 每条走 `p` 流式导出，受 sanitize + 单页上限 + 累计总量约束，
/// 落点恒在 `dest_dir` 内。返回实际写入的总字节数。
pub fn extract_rar_entries(
    cfg: &AppConfig,
    archive: &Path,
    entry_names: &[String],
    dest_dir: &Path,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> AppResult<u64> {
    // 先净化全部条目名（不依赖 unrar 是否存在，恶意名字直接拒绝）
    for name in entry_names {
        sanitize_entry_path(name)?;
    }
    require_unrar(cfg)?;
    std::fs::create_dir_all(dest_dir)?;
    let dest_root = std::fs::canonicalize(dest_dir).unwrap_or_else(|_| dest_dir.to_path_buf());
    let mut total = 0u64;
    for name in entry_names {
        if crate::archive::extract_cancelled(cancel) {
            return Err(AppError::cancelled());
        }
        let safe = sanitize_entry_path(name)?;
        let dest = dest_dir.join(safe);
        let n = extract_rar_file(cfg, archive, name, &dest)?;
        // 防御性校验：真实落点必须仍在目标目录内
        match std::fs::canonicalize(&dest) {
            Ok(p) if p.starts_with(&dest_root) => {}
            _ => {
                let _ = std::fs::remove_file(&dest);
                return Err(AppError::path_traversal(format!("CBR 条目越界: {name}")));
            }
        }
        total += n;
        if total > cfg.max_extract_bytes {
            return Err(AppError::disk(format!(
                "CBR 解压总量将超过上限 ({} bytes)",
                cfg.max_extract_bytes
            )));
        }
    }
    Ok(total)
}

/// Extract one archived file to `dest` (original bytes), bounded by the
/// single-page size limit. Returns bytes written.
pub fn extract_rar_file(
    cfg: &AppConfig,
    archive: &Path,
    entry_name: &str,
    dest: &Path,
) -> AppResult<u64> {
    let bin = require_unrar(cfg)?;
    sanitize_entry_path(entry_name)?;
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
    // stdout 已整体缓冲；超单页上限即拒绝，防炸弹条目写满磁盘
    if out.stdout.len() as u64 > cfg.max_page_bytes {
        return Err(AppError::new(
            ErrorCode::UnsupportedFormat,
            format!(
                "CBR 条目解压后过大 ({} > {} bytes)",
                out.stdout.len(),
                cfg.max_page_bytes
            ),
        ));
    }
    std::fs::write(dest, &out.stdout)?;
    Ok(out.stdout.len() as u64)
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

    #[test]
    fn rar_entry_traversal_rejected_before_spawn() {
        let cfg = AppConfig {
            unrar_bin: Some(PathBuf::from("/no/such/unrar-binary")),
            ..Default::default()
        };
        let dir = tempfile::tempdir().unwrap();
        let err = extract_rar_entries(
            &cfg,
            Path::new("/no/such/archive.rar"),
            &["../evil.txt".to_string(), "ok/001.jpg".to_string()],
            &dir.path().join("out"),
            None,
        )
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::PathTraversal);
        // 越界名不得创建任何文件
        assert!(!dir.path().join("evil.txt").exists());
    }
}
