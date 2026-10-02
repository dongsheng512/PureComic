//! Comic JPEG export: progressive, optimized Huffman, and chroma that matches the page.
//!
//! Gray pages (mean CIEDE2000 against their own lightness, on a 1/6 box thumbnail, below 0.5)
//! are stored as a single luma component. Color pages use 4:2:0 with box-averaged chroma.
//! The decision runs on the pixels about to be encoded, which for Real-CUGAN is the engine
//! RGB, so export can copy the file once.

use std::borrow::Cow;
use std::io::Write;
use std::path::Path;

use image::RgbImage;
use jpeg_encoder::{ChromaSubsamplingMethod, ColorType, Encoder, SamplingFactor};

use crate::EngineError;

/// Keep color when the thumbnail's mean CIEDE2000 from gray reaches this.
/// 0.5 is below the roughly-1.0 just-noticeable difference, so faint real color stays.
const COLOR_DE_MIN: f64 = 0.5;
const THUMB_FACTOR: u32 = 6;

/// Encode RGB8 into a comic JPEG. `quality` is clamped to 1–100.
pub fn encode_comic_jpeg(
    rgb: &[u8],
    width: u32,
    height: u32,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let quality = quality.clamp(1, 100);
    let width_u = u16::try_from(width).map_err(|_| format!("JPEG 宽度超过 65535 ({width})"))?;
    let height_u = u16::try_from(height).map_err(|_| format!("JPEG 高度超过 65535 ({height})"))?;
    if width == 0 || height == 0 {
        return Err("JPEG 尺寸为空".into());
    }
    let expect = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(3))
        .ok_or_else(|| "JPEG 尺寸过大".to_string())?;
    if rgb.len() < expect {
        return Err(format!("JPEG 像素缓冲不足: {} < {expect}", rgb.len()));
    }
    let rgb = &rgb[..expect];

    let mut buf = Vec::new();
    let mut encoder = Encoder::new(&mut buf, quality);
    // 固定 2 个扫描（DC 扫描 + AC 扫描）。本 crate 的 progressive 实现代价随扫描数
    // 单调上升：实测同一张引擎输出，prog(4) 比 baseline 还大 2.6%（彩页）/ 9.4%（灰页），
    // prog(12) 更大；而 prog(2) 与 baseline 持平且是全局最小。解码结果与 baseline
    // 逐像素相同，所以多出来的扫描是纯熵编码开销。**不要把扫描数调大。**
    encoder.set_progressive(true);
    encoder.set_progressive_scans(2);
    encoder.set_optimized_huffman_tables(true);

    if page_is_gray(rgb, width, height) {
        let luma = rec601_luma(rgb);
        encoder
            .encode(&luma, width_u, height_u, ColorType::Luma)
            .map_err(|e| e.to_string())?;
    } else {
        encoder.set_sampling_factor(SamplingFactor::R_4_2_0);
        encoder.set_chroma_subsampling_method(ChromaSubsamplingMethod::Average);
        encoder
            .encode(rgb, width_u, height_u, ColorType::Rgb)
            .map_err(|e| e.to_string())?;
    }
    Ok(buf)
}

/// Shrink so the long side is at most `max_side`. `0` leaves the image alone.
pub fn fit_long_side(image: &RgbImage, max_side: u32) -> Cow<'_, RgbImage> {
    let w = image.width();
    let h = image.height();
    let long = w.max(h);
    if max_side == 0 || long <= max_side || w == 0 || h == 0 {
        return Cow::Borrowed(image);
    }
    let scale = f64::from(max_side) / f64::from(long);
    let nw = (f64::from(w) * scale).round().max(1.0) as u32;
    let nh = (f64::from(h) * scale).round().max(1.0) as u32;
    Cow::Owned(image::imageops::resize(
        image,
        nw,
        nh,
        image::imageops::FilterType::Lanczos3,
    ))
}

pub fn write_comic_jpeg(path: &Path, image: &RgbImage, quality: u8) -> Result<(), EngineError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| EngineError::Io(e.to_string()))?;
    }
    let bytes = encode_comic_jpeg(image.as_raw(), image.width(), image.height(), quality)
        .map_err(EngineError::Image)?;
    let mut file = std::fs::File::create(path).map_err(|e| EngineError::Io(e.to_string()))?;
    file.write_all(&bytes)
        .map_err(|e| EngineError::Io(e.to_string()))?;
    Ok(())
}

fn page_is_gray(rgb: &[u8], width: u32, height: u32) -> bool {
    if rgb
        .as_chunks::<3>()
        .0
        .iter()
        .all(|p| p[0] == p[1] && p[1] == p[2])
    {
        return true;
    }
    mean_de_from_gray(rgb, width, height) < COLOR_DE_MIN
}

fn rec601_luma(rgb: &[u8]) -> Vec<u8> {
    rgb.as_chunks::<3>()
        .0
        .iter()
        .map(|p| {
            ((19_595 * p[0] as u32 + 38_470 * p[1] as u32 + 7_471 * p[2] as u32 + 32_768) >> 16)
                as u8
        })
        .collect()
}

fn mean_de_from_gray(rgb: &[u8], width: u32, height: u32) -> f64 {
    let factor = THUMB_FACTOR;
    let tw = (width / factor).max(1);
    let th = (height / factor).max(1);
    let fw = tw as usize;
    let fh = th as usize;
    let f = factor as usize;
    let w = width as usize;
    let h = height as usize;
    let mut sum = 0.0;
    for oy in 0..fh {
        for ox in 0..fw {
            let mut acc = [0u32; 3];
            let mut count = 0u32;
            let y0 = oy * f;
            let x0 = ox * f;
            for y in y0..(y0 + f).min(h) {
                let row = y * w;
                for x in x0..(x0 + f).min(w) {
                    let i = (row + x) * 3;
                    acc[0] += rgb[i] as u32;
                    acc[1] += rgb[i + 1] as u32;
                    acc[2] += rgb[i + 2] as u32;
                    count += 1;
                }
            }
            let lab = srgb_to_lab(
                (acc[0] / count) as u8,
                (acc[1] / count) as u8,
                (acc[2] / count) as u8,
            );
            sum += delta_e_2000(lab, [lab[0], 0.0, 0.0]);
        }
    }
    sum / (fw * fh) as f64
}

fn srgb_to_lab(r: u8, g: u8, b: u8) -> [f64; 3] {
    fn linear(u: f64) -> f64 {
        if u <= 0.04045 {
            u / 12.92
        } else {
            ((u + 0.055) / 1.055).powf(2.4)
        }
    }
    fn f(t: f64) -> f64 {
        let delta = 6.0 / 29.0;
        if t > delta * delta * delta {
            t.cbrt()
        } else {
            t / (3.0 * delta * delta) + 4.0 / 29.0
        }
    }
    let r = linear(r as f64 / 255.0);
    let g = linear(g as f64 / 255.0);
    let b = linear(b as f64 / 255.0);
    let x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
    let y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
    let z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041;
    let fx = f(x / 0.95047);
    let fy = f(y);
    let fz = f(z / 1.08883);
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

fn delta_e_2000(lab1: [f64; 3], lab2: [f64; 3]) -> f64 {
    let (l1, a1, b1) = (lab1[0], lab1[1], lab1[2]);
    let (l2, a2, b2) = (lab2[0], lab2[1], lab2[2]);
    let avg_lp = (l1 + l2) / 2.0;
    let c1 = a1.hypot(b1);
    let c2 = a2.hypot(b2);
    let avg_c = (c1 + c2) / 2.0;
    let avg_c7 = avg_c.powi(7);
    let g = 0.5 * (1.0 - (avg_c7 / (avg_c7 + 25.0_f64.powi(7))).sqrt());
    let a1p = (1.0 + g) * a1;
    let a2p = (1.0 + g) * a2;
    let c1p = a1p.hypot(b1);
    let c2p = a2p.hypot(b2);
    let avg_cp = (c1p + c2p) / 2.0;
    let h1p = hue_deg(b1, a1p);
    let h2p = hue_deg(b2, a2p);
    let avg_hp = if (h1p - h2p).abs() > 180.0 {
        if h1p + h2p < 360.0 {
            (h1p + h2p + 360.0) / 2.0
        } else {
            (h1p + h2p - 360.0) / 2.0
        }
    } else {
        (h1p + h2p) / 2.0
    };
    let t = 1.0 - 0.17 * (avg_hp - 30.0).to_radians().cos()
        + 0.24 * (2.0 * avg_hp).to_radians().cos()
        + 0.32 * (3.0 * avg_hp + 6.0).to_radians().cos()
        - 0.20 * (4.0 * avg_hp - 63.0).to_radians().cos();
    let mut dh = h2p - h1p;
    if dh.abs() > 180.0 {
        if h2p <= h1p {
            dh += 360.0;
        } else {
            dh -= 360.0;
        }
    }
    let dlp = l2 - l1;
    let dcp = c2p - c1p;
    let dhp = 2.0 * (c1p * c2p).sqrt() * (dh / 2.0).to_radians().sin();
    let lp50 = avg_lp - 50.0;
    let sl = 1.0 + (0.015 * lp50 * lp50) / (20.0 + lp50 * lp50).sqrt();
    let sc = 1.0 + 0.045 * avg_cp;
    let sh = 1.0 + 0.015 * avg_cp * t;
    let dtheta = 30.0 * (-((avg_hp - 275.0) / 25.0).powi(2)).exp();
    let avg_cp7 = avg_cp.powi(7);
    let rc = 2.0 * (avg_cp7 / (avg_cp7 + 25.0_f64.powi(7))).sqrt();
    let rt = -rc * (2.0 * dtheta).to_radians().sin();
    ((dlp / sl).powi(2) + (dcp / sc).powi(2) + (dhp / sh).powi(2) + rt * (dcp / sc) * (dhp / sh))
        .sqrt()
}

fn hue_deg(b: f64, a: f64) -> f64 {
    let h = b.atan2(a).to_degrees();
    if h < 0.0 {
        h + 360.0
    } else {
        h
    }
}

#[cfg(test)]
struct JpegFrame {
    marker: u8,
    /// Per-component horizontal and vertical sampling factors.
    sampling: Vec<(u8, u8)>,
}

/// Start-of-frame marker and each component's (h, v) sampling.
#[cfg(test)]
fn jpeg_frame(bytes: &[u8]) -> Option<JpegFrame> {
    let mut i = 0;
    while i + 3 < bytes.len() {
        if bytes[i] != 0xFF {
            i += 1;
            continue;
        }
        let mut marker = bytes[i + 1];
        let mut mpos = i + 1;
        while marker == 0xFF && mpos + 1 < bytes.len() {
            mpos += 1;
            marker = bytes[mpos];
        }
        i = mpos + 1;
        if marker == 0xD8 || marker == 0xD9 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            continue;
        }
        if i + 1 >= bytes.len() {
            break;
        }
        let len = u16::from_be_bytes([bytes[i], bytes[i + 1]]) as usize;
        if matches!(marker, 0xC0 | 0xC2) && i + 8 <= bytes.len() {
            let nf = bytes[i + 7];
            let mut sampling = Vec::with_capacity(nf as usize);
            let mut p = i + 8;
            for _ in 0..nf {
                if p + 2 >= bytes.len() {
                    return None;
                }
                let hv = bytes[p + 1];
                sampling.push((hv >> 4, hv & 0x0F));
                p += 3;
            }
            return Some(JpegFrame { marker, sampling });
        }
        if len < 2 {
            break;
        }
        i += len;
    }
    None
}

/// Number of scans (SOS segments). Walks entropy-coded data properly, so it
/// counts real scan headers rather than bytes that merely look like markers.
#[cfg(test)]
fn jpeg_scans(bytes: &[u8]) -> usize {
    let mut i = 0usize;
    let mut scans = 0usize;
    while i + 1 < bytes.len() {
        if bytes[i] != 0xFF {
            i += 1;
            continue;
        }
        let marker = bytes[i + 1];
        if marker == 0xFF || marker == 0x00 {
            i += 1;
            continue;
        }
        if marker == 0xD9 {
            break;
        }
        // standalone markers carry no length field
        if marker == 0xD8 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        let Some(len) = bytes
            .get(i + 2..i + 4)
            .map(|s| u16::from_be_bytes([s[0], s[1]]) as usize)
        else {
            break;
        };
        if marker == 0xDA {
            scans += 1;
        }
        i += 2 + len;
        // skip this scan's entropy-coded data up to the next real marker
        while i + 1 < bytes.len() {
            if bytes[i] != 0xFF {
                i += 1;
                continue;
            }
            let next = bytes[i + 1];
            if next == 0x00 || (0xD0..=0xD7).contains(&next) {
                i += 2;
                continue;
            }
            if next == 0xFF {
                i += 1;
                continue;
            }
            break;
        }
    }
    scans
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, px: [u8; 3]) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 3) as usize);
        for _ in 0..w * h {
            v.extend_from_slice(&px);
        }
        v
    }

    #[test]
    fn gray_page_is_progressive_luma() {
        let jpg = encode_comic_jpeg(&solid(32, 24, [40, 40, 40]), 32, 24, 92).unwrap();
        let frame = jpeg_frame(&jpg).unwrap();
        assert_eq!(frame.marker, 0xC2, "progressive SOF2");
        assert_eq!(frame.sampling, vec![(1, 1)]);
    }

    #[test]
    fn color_page_is_progressive_420() {
        let jpg = encode_comic_jpeg(&solid(32, 24, [220, 30, 40]), 32, 24, 92).unwrap();
        let frame = jpeg_frame(&jpg).unwrap();
        assert_eq!(frame.marker, 0xC2);
        assert_eq!(frame.sampling, vec![(2, 2), (1, 1), (1, 1)]);
    }

    #[test]
    fn chroma_noise_that_averages_out_stays_gray() {
        // ±2 on blue cancels inside each 6×6 block, so the 1/6 thumbnail is gray.
        let mut raw = Vec::new();
        for i in 0..18 * 12 {
            let b = if i % 2 == 0 { 130 } else { 126 };
            raw.extend_from_slice(&[128, 128, b]);
        }
        let jpg = encode_comic_jpeg(&raw, 18, 12, 92).unwrap();
        let frame = jpeg_frame(&jpg).unwrap();
        assert_eq!(frame.sampling.len(), 1);
    }

    #[test]
    fn progressive_scans_stay_at_two_per_component() {
        // set_progressive_scans(n) 是「每分量 n 个扫描」：灰度 1 分量 → 2 个，
        // 彩色 3 分量 → 6 个。本 crate 的 progressive 体积随扫描数单调上升
        // （见 encode_comic_jpeg 的注释），所以锁死在 2，别改回默认的 4。
        for px in [[40u8, 40, 40], [220, 30, 40]] {
            let jpg = encode_comic_jpeg(&solid(32, 24, px), 32, 24, 92).unwrap();
            let comps = jpeg_frame(&jpg).unwrap().sampling.len();
            assert_eq!(
                jpeg_scans(&jpg),
                2 * comps,
                "expected 2 scans per component for {px:?}"
            );
        }
    }

    #[test]
    fn odd_size_roundtrips() {
        let raw = solid(7, 5, [10, 180, 40]);
        let jpg = encode_comic_jpeg(&raw, 7, 5, 90).unwrap();
        let decoded = image::load_from_memory(&jpg).unwrap().to_rgb8();
        assert_eq!(decoded.dimensions(), (7, 5));
        let p = decoded.get_pixel(3, 2).0;
        assert!(p[1] > p[0] && p[1] > p[2]);
    }

    #[test]
    fn long_side_cap_preserves_aspect() {
        let rgb = image::RgbImage::from_pixel(80, 40, image::Rgb([10, 20, 30]));
        let fitted = fit_long_side(&rgb, 40);
        assert_eq!(fitted.dimensions(), (40, 20));
        assert_eq!(fit_long_side(&rgb, 0).dimensions(), (80, 40));
        assert_eq!(fit_long_side(&rgb, 100).dimensions(), (80, 40));
    }

    #[test]
    fn identical_lab_is_zero() {
        let lab = srgb_to_lab(12, 80, 200);
        assert!(delta_e_2000(lab, lab) < 1e-9);
        assert!(delta_e_2000(lab, [lab[0], 0.0, 0.0]) > 1.0);
    }
}
