//! Single-page Before/After preview (shares GpuLock with batch jobs).

use crate::archive::{self, extract_page_to_png};
use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
use crate::job::EnhanceOptions;
use crate::pipeline::GpuLock;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use comic_engines::{EnhanceBatchRequest, UpscaleEngine};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRequest {
    pub source: String,
    pub page_index: u32,
    #[serde(default)]
    pub options: Option<EnhanceOptionsDto>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnhanceOptionsDto {
    pub preset: Option<String>,
    pub scale: Option<u8>,
    pub noise_level: Option<i8>,
    pub tta: Option<bool>,
    pub gpu_id: Option<i32>,
    pub engine: Option<String>,
    pub cugan_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub page_index: u32,
    pub page_name: String,
    /// data URL image/png
    pub before_data_url: String,
    /// data URL image/png
    pub after_data_url: String,
    pub width_before: u32,
    pub height_before: u32,
    pub width_after: u32,
    pub height_after: u32,
    pub engine: String,
}

fn options_from_dto(dto: Option<EnhanceOptionsDto>) -> AppResult<EnhanceOptions> {
    use comic_engines::{QualityPreset, ScaleFactor};
    let dto = dto.unwrap_or_default();
    let preset = match dto.preset.as_deref().unwrap_or("balanced") {
        "fast" => QualityPreset::Fast,
        "quality" => QualityPreset::Quality,
        _ => QualityPreset::Balanced,
    };
    let mut o = EnhanceOptions::from_preset(preset);
    if let Some(s) = dto.scale {
        o.scale = ScaleFactor::try_from_u8(s).map_err(AppError::invalid)?;
    }
    if let Some(n) = dto.noise_level {
        if !(-1..=3).contains(&n) {
            return Err(AppError::invalid("noise_level 须在 -1..=3"));
        }
        o.noise = n;
    }
    if let Some(tta) = dto.tta {
        o.tta = tta;
    }
    if let Some(g) = dto.gpu_id {
        o.gpu_id = Some(g);
    }
    if let Some(eng) = dto.engine.as_deref() {
        o.engine = match eng {
            "realcugan" | "cugan" => comic_engines::EngineKind::RealCugan,
            _ => comic_engines::EngineKind::Waifu2x,
        };
    }
    if let Some(cm) = dto.cugan_model {
        o.cugan_model = cm;
    }
    Ok(o)
}

fn file_to_data_url_png(path: &Path) -> AppResult<(String, u32, u32)> {
    let img = crate::image_io::load_image(path)?;
    let w = img.width();
    let h = img.height();
    let mut buf = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut buf);
        img.write_to(&mut cursor, image::ImageFormat::Png)
            .map_err(|e| {
                AppError::new(crate::error::ErrorCode::DecodeFail, "预览编码失败")
                    .with_detail(e.to_string())
            })?;
    }
    let url = format!("data:image/png;base64,{}", B64.encode(&buf));
    Ok((url, w, h))
}

/// Run one-page enhance preview under the global GPU lock.
pub async fn preview_page(
    source: &Path,
    page_index: u32,
    options: Option<EnhanceOptionsDto>,
    engine: Arc<dyn UpscaleEngine>,
    gpu: GpuLock,
    cfg: &AppConfig,
) -> AppResult<PreviewResult> {
    let opts = options_from_dto(options)?;
    let v = archive::validate_source(source, cfg)?;
    if page_index as usize >= v.page_names.len() {
        return Err(AppError::invalid(format!(
            "页索引越界: {} (共 {} 页)",
            page_index, v.page_count
        )));
    }
    let page_name = v.page_names[page_index as usize].clone();

    let work = cfg
        .work_root
        .join("preview")
        .join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&work)?;
    let before_png = work.join("before.png");
    let after_png = work.join("after.png");

    extract_page_to_png(source, page_index, &before_png, cfg)?;

    // Thumbnail intermediate for huge pages (display + faster mock); max side 2048 for engine input optional
    // Keep full page for fidelity within max_image_side.

    let cancel = CancellationToken::new();
    let _guard = gpu.lock().await;
    engine
        .enhance_batch(
            EnhanceBatchRequest::SingleFile {
                input: before_png.clone(),
                output: after_png.clone(),
                params: opts.to_engine_params(),
            },
            cancel,
        )
        .await?;

    if !after_png.is_file() {
        return Err(AppError::internal("预览输出未生成"));
    }

    let (before_data_url, width_before, height_before) = file_to_data_url_png(&before_png)?;
    let (after_data_url, width_after, height_after) = file_to_data_url_png(&after_png)?;

    // best-effort cleanup
    let _ = std::fs::remove_dir_all(&work);

    Ok(PreviewResult {
        page_index,
        page_name,
        before_data_url,
        after_data_url,
        width_before,
        height_before,
        width_after,
        height_after,
        engine: engine.status().id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::new_gpu_lock;
    use comic_engines::MockEngine;
    use image::{ImageBuffer, Rgb};

    #[tokio::test]
    async fn preview_folder_page() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("pages");
        std::fs::create_dir_all(&src).unwrap();
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_pixel(16, 12, Rgb([3, 4, 5]));
        image::DynamicImage::ImageRgb8(img)
            .save(src.join("a.png"))
            .unwrap();

        let mut cfg = AppConfig::default();
        cfg.work_root = tmp.path().join("work");
        cfg.ensure_dirs().unwrap();

        let engine: Arc<dyn UpscaleEngine> = Arc::new(MockEngine { delay_ms: 0 });
        let gpu = new_gpu_lock();
        let res = preview_page(
            &src,
            0,
            Some(EnhanceOptionsDto {
                preset: Some("fast".into()),
                scale: Some(2),
                ..Default::default()
            }),
            engine,
            gpu,
            &cfg,
        )
        .await
        .unwrap();
        assert!(res.before_data_url.starts_with("data:image/png;base64,"));
        assert!(res.after_data_url.starts_with("data:image/png;base64,"));
        assert_eq!(res.width_before, 16);
        assert_eq!(res.width_after, 32);
        assert_eq!(res.height_after, 24);
    }
}
