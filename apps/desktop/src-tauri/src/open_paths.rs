//! 解析「用 PureComic 打开」传入的路径：CLI 参数 / file:// URL / 系统 Opened 事件。
//! 仅放行已存在的漫画扩展或图片文件夹，防止任意路径注入。

use std::path::{Path, PathBuf};
use url::Url;

const COMIC_EXTS: &[&str] = &["cbz", "cbr", "zip", "rar", "epub", "mobi", "azw", "azw3"];
const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"];

fn has_comic_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| COMIC_EXTS.iter().any(|x| e.eq_ignore_ascii_case(x)))
        .unwrap_or(false)
}

fn is_image_file(path: &Path) -> bool {
    path.extension()
        .and_then(|x| x.to_str())
        .map(|x| IMAGE_EXTS.iter().any(|i| x.eq_ignore_ascii_case(i)))
        .unwrap_or(false)
}

/// 目录需包含至少一个漫画/图片文件。最多下探 3 层，每层/总计有上限，避免扫整盘。
fn dir_contains_comic_content(path: &Path) -> bool {
    const MAX_DEPTH: usize = 3;
    const MAX_PER_DIR: usize = 128;
    const MAX_VISITS: usize = 512;

    fn walk(path: &Path, depth: usize, visits: &mut usize) -> bool {
        if depth > MAX_DEPTH || *visits >= MAX_VISITS {
            return false;
        }
        let rd = match std::fs::read_dir(path) {
            Ok(rd) => rd,
            Err(_) => return false,
        };
        for (n, e) in rd.flatten().enumerate() {
            if n >= MAX_PER_DIR || *visits >= MAX_VISITS {
                break;
            }
            *visits += 1;
            let p = e.path();
            if p.is_file() && (has_comic_ext(&p) || is_image_file(&p)) {
                return true;
            }
            if p.is_dir() && walk(&p, depth + 1, visits) {
                return true;
            }
        }
        false
    }

    let mut visits = 0usize;
    walk(path, 0, &mut visits)
}

pub fn is_allowed_comic_path(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    if path.is_dir() {
        return dir_contains_comic_content(path);
    }
    if !path.is_file() {
        return false;
    }
    has_comic_ext(path)
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

    #[test]
    fn accepts_nested_folder_comic() {
        let root = std::env::temp_dir().join(format!(
            "purecomic-open-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let nested = root.join("Vol1").join("Ch1");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("001.jpg"), [0xff, 0xd8, 0xff, 0xd9]).unwrap();
        assert!(is_allowed_comic_path(&root));
        let _ = std::fs::remove_dir_all(&root);
    }
}
