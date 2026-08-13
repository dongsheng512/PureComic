//! Image decode/encode helpers (JPEG / PNG / WebP).
//! Grayscale → RGB for engine compatibility.

use crate::error::{AppError, AppResult, ErrorCode};
use crate::job::ImageFormat;
use image::{DynamicImage, ImageFormat as ImgFmt};
use std::path::Path;

pub const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp", "gif", "tif", "tiff"];

pub fn is_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn load_image(path: &Path) -> AppResult<DynamicImage> {
    image::open(path).map_err(|e| {
        AppError::new(ErrorCode::DecodeFail, format!("无法解码: {}", path.display()))
            .with_detail(e.to_string())
    })
}

/// Convert grayscale/LA to RGB(A) so Waifu2x-class models get 3 channels.
pub fn prepare_for_engine(img: DynamicImage) -> DynamicImage {
    match img {
        DynamicImage::ImageLuma8(_) | DynamicImage::ImageLuma16(_) => {
            DynamicImage::ImageRgb8(img.to_rgb8())
        }
        DynamicImage::ImageLumaA8(_) | DynamicImage::ImageLumaA16(_) => {
            DynamicImage::ImageRgba8(img.to_rgba8())
        }
        other => other,
    }
}

/// Write intermediate PNG for engine I/O (lossless default).
pub fn write_engine_png(img: &DynamicImage, path: &Path) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let prepared = prepare_for_engine(img.clone());
    prepared.save_with_format(path, ImgFmt::Png).map_err(|e| {
        AppError::new(ErrorCode::DecodeFail, "写入 PNG 失败").with_detail(e.to_string())
    })
}

pub fn save_export(
    img: &DynamicImage,
    path: &Path,
    format: ImageFormat,
    jpeg_quality: u8,
    _webp_quality: u8,
    source_ext: Option<&str>,
) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let fmt = match format {
        ImageFormat::Png => ImgFmt::Png,
        ImageFormat::Jpeg => ImgFmt::Jpeg,
        ImageFormat::Webp => ImgFmt::WebP,
        ImageFormat::Same => match source_ext.map(|s| s.to_ascii_lowercase()).as_deref() {
            Some("png") => ImgFmt::Png,
            Some("webp") => ImgFmt::WebP,
            _ => ImgFmt::Jpeg,
        },
    };

    match fmt {
        ImgFmt::Jpeg => {
            let rgb = img.to_rgb8();
            let mut file = std::fs::File::create(path)?;
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, jpeg_quality);
            enc.encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| {
                AppError::new(ErrorCode::DecodeFail, "JPEG 编码失败").with_detail(e.to_string())
            })?;
        }
        other => {
            img.save_with_format(path, other).map_err(|e| {
                AppError::new(ErrorCode::DecodeFail, "图像编码失败").with_detail(e.to_string())
            })?;
        }
    }
    Ok(())
}

pub fn convert_file_to_engine_png(src: &Path, dst: &Path) -> AppResult<()> {
    let img = load_image(src)?;
    write_engine_png(&img, dst)
}

/// waifu2x-ncnn-vulkan reads jpg/png/webp natively — skip decode/re-encode.
pub fn is_engine_native_ext(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "webp"
    )
}

pub fn is_engine_native_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(is_engine_native_ext)
        .unwrap_or(false)
}

/// Copy jpg/png/webp as-is; convert other formats to PNG for the engine.
pub fn write_engine_input(src: &Path, dest: &Path) -> AppResult<()> {
    if is_engine_native_path(src) {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(src, dest)?;
        return Ok(());
    }
    convert_file_to_engine_png(src, dest)
}

/// Encode export image into memory (avoids temp files during zip pack).
pub fn save_export_bytes(
    img: &DynamicImage,
    format: ImageFormat,
    jpeg_quality: u8,
    _webp_quality: u8,
    source_ext: Option<&str>,
) -> AppResult<Vec<u8>> {
    use std::io::Cursor;

    let fmt = match format {
        ImageFormat::Png => ImgFmt::Png,
        ImageFormat::Jpeg => ImgFmt::Jpeg,
        ImageFormat::Webp => ImgFmt::WebP,
        ImageFormat::Same => match source_ext.map(|s| s.to_ascii_lowercase()).as_deref() {
            Some("png") => ImgFmt::Png,
            Some("webp") => ImgFmt::WebP,
            _ => ImgFmt::Jpeg,
        },
    };

    match fmt {
        ImgFmt::Jpeg => {
            let rgb = img.to_rgb8();
            let mut buf = Vec::new();
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, jpeg_quality);
            enc.encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )
            .map_err(|e| {
                AppError::new(ErrorCode::DecodeFail, "JPEG 编码失败").with_detail(e.to_string())
            })?;
            Ok(buf)
        }
        other => {
            let mut buf = Cursor::new(Vec::new());
            img.write_to(&mut buf, other).map_err(|e| {
                AppError::new(ErrorCode::DecodeFail, "图像编码失败").with_detail(e.to_string())
            })?;
            Ok(buf.into_inner())
        }
    }
}

/// True when we can zip/copy the engine output without re-encoding.
pub fn export_can_passthrough(
    format: ImageFormat,
    src: &Path,
    source_ext: Option<&str>,
) -> bool {
    let src_ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());
    match format {
        ImageFormat::Png => matches!(src_ext.as_deref(), Some("png")),
        ImageFormat::Jpeg => matches!(src_ext.as_deref(), Some("jpg") | Some("jpeg")),
        ImageFormat::Webp => matches!(src_ext.as_deref(), Some("webp")),
        ImageFormat::Same => {
            let want = source_ext.map(|s| s.to_ascii_lowercase());
            match (want.as_deref(), src_ext.as_deref()) {
                (Some("jpg") | Some("jpeg"), Some("jpg") | Some("jpeg")) => true,
                (Some(a), Some(b)) => a == b,
                _ => false,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Luma, Rgb};

    #[test]
    fn gray_to_rgb() {
        let img: ImageBuffer<Luma<u8>, Vec<u8>> = ImageBuffer::from_pixel(2, 2, Luma([128]));
        let dyn_img = DynamicImage::ImageLuma8(img);
        let prepared = prepare_for_engine(dyn_img);
        assert!(matches!(prepared, DynamicImage::ImageRgb8(_)));
    }

    #[test]
    fn roundtrip_png() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.png");
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_pixel(4, 4, Rgb([10, 20, 30]));
        let dyn_img = DynamicImage::ImageRgb8(img);
        write_engine_png(&dyn_img, &path).unwrap();
        let loaded = load_image(&path).unwrap();
        assert_eq!(loaded.width(), 4);
    }

    #[test]
    fn jpeg_bytes_and_passthrough() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("a.png");
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_pixel(8, 8, Rgb([10, 20, 30]));
        let dyn_img = DynamicImage::ImageRgb8(img);
        write_engine_png(&dyn_img, &png).unwrap();
        assert!(export_can_passthrough(ImageFormat::Png, &png, Some("png")));
        assert!(!export_can_passthrough(ImageFormat::Jpeg, &png, Some("jpg")));
        let jpg_path = dir.path().join("a.jpg");
        std::fs::write(&jpg_path, [0xFF, 0xD8, 0xFF, 0xDB]).unwrap();
        assert!(export_can_passthrough(ImageFormat::Jpeg, &jpg_path, Some("jpg")));
        let jpg = save_export_bytes(&dyn_img, ImageFormat::Jpeg, 80, 90, Some("png")).unwrap();
        assert!(jpg.len() > 20);
        assert_eq!(&jpg[0..2], &[0xFF, 0xD8]);
    }
}
