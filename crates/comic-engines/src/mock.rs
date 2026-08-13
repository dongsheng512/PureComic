//! Mock engine: copies / nearest-neighbor upscales for CI and UI development.

use crate::{
    EnhanceBatchRequest, EnhanceBatchResult, EngineAvailability, EngineError, EngineKind,
    EngineStatus, GpuInfo, ScaleFactor, UpscaleEngine,
};
use async_trait::async_trait;
use image::imageops::FilterType;
use std::path::Path;
use tokio_util::sync::CancellationToken;
use tracing::info;

pub struct MockEngine {
    /// Simulated delay per page (ms)
    pub delay_ms: u64,
}

impl Default for MockEngine {
    fn default() -> Self {
        Self { delay_ms: 10 }
    }
}

#[async_trait]
impl UpscaleEngine for MockEngine {
    fn id(&self) -> EngineKind {
        EngineKind::Waifu2x
    }

    fn is_available(&self) -> EngineAvailability {
        EngineAvailability::Ready
    }

    fn status(&self) -> EngineStatus {
        EngineStatus {
            id: "mock".into(),
            available: true,
            detail: "开发/测试用 mock 引擎（非真实 Waifu2x）".into(),
            version: Some("0.1.0-mock".into()),
        }
    }

    async fn list_gpus(&self) -> Result<Vec<GpuInfo>, EngineError> {
        Ok(vec![
            GpuInfo {
                id: -1,
                name: "Mock CPU".into(),
                is_cpu: true,
            },
            GpuInfo {
                id: 0,
                name: "Mock GPU 0".into(),
                is_cpu: false,
            },
        ])
    }

    async fn enhance_batch(
        &self,
        req: EnhanceBatchRequest,
        cancel: CancellationToken,
    ) -> Result<EnhanceBatchResult, EngineError> {
        match req {
            EnhanceBatchRequest::Directory {
                input_dir,
                output_dir,
                params,
            } => {
                tokio::fs::create_dir_all(&output_dir)
                    .await
                    .map_err(|e| EngineError::Io(e.to_string()))?;
                let mut rd = tokio::fs::read_dir(&input_dir)
                    .await
                    .map_err(|e| EngineError::Io(e.to_string()))?;
                let mut ok = 0u32;
                let mut failed = 0u32;
                while let Some(entry) = rd
                    .next_entry()
                    .await
                    .map_err(|e| EngineError::Io(e.to_string()))?
                {
                    if cancel.is_cancelled() {
                        return Err(EngineError::Cancelled);
                    }
                    let path = entry.path();
                    if !path.is_file() {
                        continue;
                    }
                    let name = match path.file_name() {
                        Some(n) => n.to_os_string(),
                        None => continue,
                    };
                    let out = output_dir.join(name);
                    if let Err(e) = process_one(&path, &out, params.scale, self.delay_ms).await {
                        tracing::warn!("mock page failed: {e}");
                        failed += 1;
                    } else {
                        ok += 1;
                    }
                }
                info!(ok, failed, "mock directory batch done");
                Ok(EnhanceBatchResult {
                    pages_ok: ok,
                    pages_failed: failed,
                    message: Some("mock".into()),
                })
            }
            EnhanceBatchRequest::SingleFile {
                input,
                output,
                params,
            } => {
                if cancel.is_cancelled() {
                    return Err(EngineError::Cancelled);
                }
                process_one(&input, &output, params.scale, self.delay_ms).await?;
                Ok(EnhanceBatchResult {
                    pages_ok: 1,
                    pages_failed: 0,
                    message: Some("mock".into()),
                })
            }
        }
    }
}

async fn process_one(
    input: &Path,
    output: &Path,
    scale: ScaleFactor,
    delay_ms: u64,
) -> Result<(), EngineError> {
    if delay_ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    }
    let img = image::open(input).map_err(|e| EngineError::Image(e.to_string()))?;
    let factor = scale.as_u8() as u32;
    let out = if factor <= 1 {
        img
    } else {
        let w = img.width().saturating_mul(factor);
        let h = img.height().saturating_mul(factor);
        img.resize_exact(w, h, FilterType::Nearest)
    };
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }
    out.save(output)
        .map_err(|e| EngineError::Image(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EnhanceParams;
    use image::{ImageBuffer, Rgb};

    #[tokio::test]
    async fn mock_scales_2x() {
        let dir = tempfile::tempdir().unwrap();
        let inp = dir.path().join("in");
        let out = dir.path().join("out");
        std::fs::create_dir_all(&inp).unwrap();
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_pixel(4, 4, Rgb([9, 9, 9]));
        image::DynamicImage::ImageRgb8(img)
            .save(inp.join("00000.png"))
            .unwrap();
        let eng = MockEngine { delay_ms: 0 };
        let res = eng
            .enhance_batch(
                EnhanceBatchRequest::Directory {
                    input_dir: inp,
                    output_dir: out.clone(),
                    params: EnhanceParams::default(),
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(res.pages_ok, 1);
        let got = image::open(out.join("00000.png")).unwrap();
        assert_eq!(got.width(), 8);
    }
}
