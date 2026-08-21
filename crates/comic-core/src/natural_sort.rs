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
        let ord = match (ap.parse::<u128>(), bp.parse::<u128>()) {
            (Ok(an), Ok(bn)) => {
                // 数值相等时短者在前（"2" < "002"），保证前导零名页序稳定
                an.cmp(&bn).then_with(|| ap.len().cmp(&bp.len()))
            }
            // 超长数字串 parse 失败：退回字典序，不产生不稳定结果
            _ => ap.cmp(bp),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    a_parts
        .len()
        .cmp(&b_parts.len())
        .then_with(|| a_lower.cmp(&b_lower))
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

    #[test]
    fn leading_zero_names_order_stably() {
        // 数值相等时短者在前，两次比较结果必须互逆（不得 Equal）
        assert_eq!(natural_cmp("2.jpg", "002.jpg"), Ordering::Less);
        assert_eq!(natural_cmp("002.jpg", "2.jpg"), Ordering::Greater);
    }

    #[test]
    fn oversized_digit_chunks_fall_back_to_lexicographic() {
        let big = "9".repeat(50);
        let bigger = "9".repeat(51);
        // u128 解析失败 → 字典序：前缀短者在前
        assert_eq!(natural_cmp(&big, &bigger), Ordering::Less);
        assert_eq!(natural_cmp(&bigger, &big), Ordering::Greater);
    }
}
