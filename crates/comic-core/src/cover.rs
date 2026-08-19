//! Cover picking for library thumbs.
//!
//! Aimed at platform webtoon packs (chapter folders, watermark banners,
//! character posters before story pages). Rules are name + image stats only —
//! never a specific book title.

use image::DynamicImage;

/// How many leading pages to score.
pub const COVER_SCAN_PAGES: u32 = 16;

#[derive(Debug, Clone, Copy)]
pub struct CoverStats {
    pub luma_std: f32,
    pub chroma_mean: f32,
    pub top_white_ratio: f32,
    pub bottom_white_ratio: f32,
    pub gutter_rows: u32,
}

/// Explicit cover filenames. Highest name bonus.
fn is_explicit_cover_base(base: &str) -> bool {
    let b = base;
    b.contains("cover")
        || b.contains("封面")
        || b.contains("表纸")
        || b.contains("front")
        || b.contains("poster")
        || b.contains("thumbnail")
}

/// Credits / settings / ads: strong penalty, still scored so a named cover can win.
fn is_front_matter_name(normalized: &str) -> bool {
    normalized.contains("credit")
        || normalized.contains("copyright")
        || normalized.contains("advert")
        || normalized.contains("disclaimer")
        || normalized.contains("notice")
        || normalized.contains("版权")
        || normalized.contains("角色设定")
        || normalized.contains("设定")
        || normalized.contains("制作人员")
        || normalized.contains("预告")
        || normalized.contains("目录")
}

/// Extra/prologue folders often hold posters; light penalty only.
fn is_extra_segment(segment: &str) -> bool {
    matches!(
        segment,
        "extra"
            | "extras"
            | "bonus"
            | "prologue"
            | "appendix"
            | "credits"
            | "chapter_000"
            | "chapter-000"
            | "ch000"
            | "ch_000"
            | "000"
            | "番外"
            | "附录"
            | "特典"
            | "设定集"
    ) || segment.starts_with("chapter_000")
        || segment.starts_with("ch000")
}

pub fn cover_name_score(name: &str) -> i32 {
    let normalized = name.replace('\\', "/").to_lowercase();
    let mut score = 0;
    let base = normalized.rsplit('/').next().unwrap_or(normalized.as_str());
    if is_explicit_cover_base(base) {
        score += 800;
    }
    if is_front_matter_name(&normalized) {
        score -= 400;
    }
    for segment in normalized.split('/') {
        if is_extra_segment(segment) {
            score -= 40;
            break;
        }
    }
    score
}

pub fn cover_stats(img: &DynamicImage) -> CoverStats {
    let small = img.resize_exact(32, 48, image::imageops::FilterType::Triangle);
    let rgb = small.to_rgb8();
    let w = rgb.width();
    let h = rgb.height();
    let count = (w * h) as f32;
    let mut sum = 0.0f32;
    let mut sum_sq = 0.0f32;
    let mut chroma_sum = 0.0f32;
    let band = (h / 8).max(4);
    let mut top_white = 0u32;
    let mut bottom_white = 0u32;
    let mut gutter_rows = 0u32;
    for y in 0..h {
        let mut row_white = 0u32;
        for x in 0..w {
            let pixel = rgb.get_pixel(x, y);
            let luma =
                0.299 * f32::from(pixel[0]) + 0.587 * f32::from(pixel[1]) + 0.114 * f32::from(pixel[2]);
            sum += luma;
            sum_sq += luma * luma;
            let max_c = pixel[0].max(pixel[1]).max(pixel[2]);
            let min_c = pixel[0].min(pixel[1]).min(pixel[2]);
            chroma_sum += f32::from(max_c.saturating_sub(min_c));
            let near_white = pixel[0] > 240 && pixel[1] > 240 && pixel[2] > 240;
            if near_white {
                row_white += 1;
                if y < band {
                    top_white += 1;
                }
                if y >= h - band {
                    bottom_white += 1;
                }
            }
        }
        let mid = y >= band && y < h - band;
        if mid && row_white as f32 / w as f32 > 0.7 {
            gutter_rows += 1;
        }
    }
    let mean = sum / count.max(1.0);
    let var = (sum_sq / count.max(1.0) - mean * mean).max(0.0);
    let band_count = (band * w) as f32;
    CoverStats {
        luma_std: var.sqrt(),
        chroma_mean: chroma_sum / count.max(1.0),
        top_white_ratio: top_white as f32 / band_count.max(1.0),
        bottom_white_ratio: bottom_white as f32 / band_count.max(1.0),
        gutter_rows,
    }
}

/// Cached thumbs must pass this or they are regenerated.
pub fn cover_image_usable(img: &DynamicImage) -> bool {
    let stats = cover_stats(img);
    stats.luma_std >= 10.0 && stats.top_white_ratio < 0.8
}

pub fn cover_image_score(img: &DynamicImage) -> Option<i32> {
    let stats = cover_stats(img);
    if stats.luma_std < 10.0 {
        return None;
    }
    let mut score = (stats.luma_std * 3.0) as i32 + (stats.chroma_mean * 1.5) as i32;
    if stats.top_white_ratio > 0.75 {
        score -= 180;
    }
    if stats.bottom_white_ratio > 0.75 {
        score -= 80;
    }
    score -= (stats.gutter_rows as i32) * 12;
    Some(score)
}

pub fn total_cover_score(name: &str, img: &DynamicImage) -> Option<i32> {
    Some(cover_image_score(img)? + cover_name_score(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn solid(color: [u8; 3]) -> DynamicImage {
        let img = ImageBuffer::from_pixel(32, 48, Rgb(color));
        DynamicImage::ImageRgb8(img)
    }

    fn banner() -> DynamicImage {
        let mut img = ImageBuffer::new(32, 48);
        for (x, y, pixel) in img.enumerate_pixels_mut() {
            *pixel = if y < 10 {
                Rgb([252, 252, 252])
            } else {
                Rgb([18, 18, (x * 3) as u8])
            };
        }
        DynamicImage::ImageRgb8(img)
    }

    fn poster() -> DynamicImage {
        let mut img = ImageBuffer::new(32, 48);
        for (x, y, pixel) in img.enumerate_pixels_mut() {
            *pixel = Rgb([
                (x * 8 + 30) as u8,
                (y * 4 + 20) as u8,
                180u8.saturating_sub((y * 2) as u8),
            ]);
        }
        DynamicImage::ImageRgb8(img)
    }

    fn panels() -> DynamicImage {
        let mut img = ImageBuffer::new(32, 48);
        for (x, y, pixel) in img.enumerate_pixels_mut() {
            *pixel = if y == 16 || y == 17 || y == 30 || y == 31 {
                Rgb([250, 250, 250])
            } else {
                Rgb([
                    (x * 4) as u8,
                    (y * 3) as u8,
                    80,
                ])
            };
        }
        DynamicImage::ImageRgb8(img)
    }

    #[test]
    fn name_rules_are_type_level() {
        assert!(cover_name_score("vol/封面.jpg") >= 800);
        assert!(cover_name_score("Book/Cover.png") >= 800);
        assert!(cover_name_score("角色设定/01.jpg") <= -400);
        assert!(cover_name_score("credits/a.jpg") < 0);
        let extra = cover_name_score("Chapter_000/2.jpg");
        let story = cover_name_score("Chapter_001/1.jpg");
        assert!(extra < story);
        assert!(extra > -200);
    }

    #[test]
    fn visual_rules_reject_placeholder_and_watermark_title() {
        assert!(cover_image_score(&solid([40, 110, 170])).is_none());
        assert!(!cover_image_usable(&solid([40, 110, 170])));
        assert!(!cover_image_usable(&banner()));
        assert!(cover_image_usable(&poster()));
        let poster_s = cover_image_score(&poster()).unwrap();
        let banner_s = cover_image_score(&banner()).unwrap();
        assert!(poster_s > banner_s);
        assert!(cover_image_score(&poster()).unwrap() > cover_image_score(&panels()).unwrap());
    }

    #[test]
    fn combined_score_prefers_named_cover() {
        let img = poster();
        let named = total_cover_score("book/封面.jpg", &img).unwrap();
        let extra = total_cover_score("Chapter_000/2.jpg", &img).unwrap();
        assert!(named > extra);
    }
}
