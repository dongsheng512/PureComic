//! 解析「用 PureComic 打开」传入的路径：CLI 参数 / file:// URL / 系统 Opened 事件。
//! 仅放行已存在的漫画扩展或图片文件夹，防止任意路径注入。

use std::path::{Path, PathBuf};
use url::Url;

const COMIC_EXTS: &[&str] = &["cbz", "cbr", "zip", "rar", "epub", "mobi", "azw", "azw3"];

pub fn is_allowed_comic_path(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    if path.is_dir() {
        return true;
    }
    if !path.is_file() {
        return false;
    }
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| COMIC_EXTS.iter().any(|x| e.eq_ignore_ascii_case(x)))
        .unwrap_or(false)
}

/// 规范化为绝对路径字符串；非法或不存在则 None。
pub fn normalize_open_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_matches('"');
    if trimmed.is_empty() || trimmed.starts_with('-') {
        return None;
    }
    let path = if let Ok(url) = Url::parse(trimmed) {
        if url.scheme() == "file" {
            url.to_file_path().ok()?
        } else {
            // 非 file URL（如 deep link）忽略
            return None;
        }
    } else {
        PathBuf::from(trimmed)
    };
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    if !is_allowed_comic_path(&path) {
        return None;
    }
    Some(path.to_string_lossy().into_owned())
}

pub fn extract_open_paths(args: &[String]) -> Vec<String> {
    // args[0] 是可执行文件
    args.iter()
        .skip(1)
        .filter_map(|a| normalize_open_path(a))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_flags_and_empty() {
        assert!(normalize_open_path("").is_none());
        assert!(normalize_open_path("--help").is_none());
    }
}
