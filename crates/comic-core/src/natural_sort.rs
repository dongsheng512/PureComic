//! Natural (human) sort for comic page names: `2.jpg` < `10.jpg`.

use regex::Regex;
use std::cmp::Ordering;
use std::sync::OnceLock;

fn digit_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\d+|\D+").expect("regex"))
}

/// Split into alternating non-digit / digit chunks for natural compare.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let a_lower = a.to_lowercase();
    let b_lower = b.to_lowercase();
    let a_parts: Vec<&str> = digit_re().find_iter(&a_lower).map(|m| m.as_str()).collect();
    let b_parts: Vec<&str> = digit_re().find_iter(&b_lower).map(|m| m.as_str()).collect();

    for (ap, bp) in a_parts.iter().zip(b_parts.iter()) {
        let a_num = ap.parse::<u128>().ok();
        let b_num = bp.parse::<u128>().ok();
        let ord = match (a_num, b_num) {
            (Some(an), Some(bn)) => an.cmp(&bn),
            _ => ap.cmp(bp),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    a_parts.len().cmp(&b_parts.len())
}

pub fn natural_sort_paths(paths: &mut [impl AsRef<str>]) {
    paths.sort_by(|a, b| natural_cmp(a.as_ref(), b.as_ref()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_order() {
        let mut names = vec![
            "img10.jpg".to_string(),
            "img2.jpg".to_string(),
            "img1.jpg".to_string(),
        ];
        natural_sort_paths(&mut names);
        assert_eq!(names, vec!["img1.jpg", "img2.jpg", "img10.jpg"]);
    }

    #[test]
    fn nested_like() {
        assert_eq!(natural_cmp("ch2/p1.png", "ch10/p1.png"), Ordering::Less);
    }
}
