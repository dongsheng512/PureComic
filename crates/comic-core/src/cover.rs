//! Cover picking for library thumbs.
//!
//! 1. A file named like a cover (`cover` / `封面` / `表纸` / …) wins.
//! 2. Otherwise use page 0, or page 1 if the first image is unusable
//!    (solid placeholder / decode failure).

use image::DynamicImage;

/// True when the filename itself says this is the cover.
pub fn is_explicit_cover_name(name: &str) -> bool {
    let n = name.replace('\\', "/").to_lowercase();
    let file = n.rsplit('/').next().unwrap_or(n.as_str());
    let stem = file.rsplit_once('.').map(|(s, _)| s).unwrap_or(file);
    stem.contains("cover")
        || stem.contains("封面")
        || stem.contains("表纸")
        || stem.contains("front")
}

fn luma_std(img: &DynamicImage) -> f32 {
    let small = img.resize_exact(32, 48, image::imageops::FilterType::Triangle);
    let rgb = small.to_rgb8();
    let n = (rgb.width() * rgb.height()) as f32;
    let mut sum = 0.0f32;
    let mut sum_sq = 0.0f32;
    for pixel in rgb.pixels() {
        let luma =
            0.299 * f32::from(pixel[0]) + 0.587 * f32::from(pixel[1]) + 0.114 * f32::from(pixel[2]);
        sum += luma;
        sum_sq += luma * luma;
    }
    let mean = sum / n.max(1.0);
    (sum_sq / n.max(1.0) - mean * mean).max(0.0).sqrt()
}

/// Cached thumbs / candidate pages: reject solid-color placeholders only.
pub fn cover_image_usable(img: &DynamicImage) -> bool {
    luma_std(img) >= 10.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn solid(color: [u8; 3]) -> DynamicImage {
        DynamicImage::ImageRgb8(ImageBuffer::from_pixel(32, 48, Rgb(color)))
    }

    fn noisy() -> DynamicImage {
        let mut img = ImageBuffer::new(32, 48);
        for (x, y, pixel) in img.enumerate_pixels_mut() {
            *pixel = Rgb([(x * 8) as u8, (y * 5) as u8, 90]);
        }
        DynamicImage::ImageRgb8(img)
    }

    #[test]
    fn explicit_cover_is_filename_only() {
        assert!(is_explicit_cover_name("vol/封面.jpg"));
        assert!(is_explicit_cover_name("Book/Cover.png"));
        assert!(is_explicit_cover_name("表纸.webp"));
        assert!(!is_explicit_cover_name("Chapter_000/1.jpg"));
        assert!(!is_explicit_cover_name("001.jpg"));
        assert!(!is_explicit_cover_name("credits/a.jpg"));
    }

    #[test]
    fn usable_rejects_solid_keeps_normal_pages() {
        assert!(!cover_image_usable(&solid([40, 110, 170])));
        assert!(cover_image_usable(&noisy()));
    }
}
