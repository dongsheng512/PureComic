//! Upscale engines: trait, mock, waifu2x-ncnn-vulkan sidecar.

mod hub;
mod mock;
pub mod paths;
mod realcugan;
mod realesrgan_coreml;
mod waifu2x;
mod waifu2x_coreml;

pub use hub::{EngineHub, EngineInfo};
pub use mock::MockEngine;
pub use paths::{
    host_target_triple, resolve_realcugan_paths, resolve_realesrgan_coreml_model,
    resolve_waifu2x_coreml_model, resolve_waifu2x_coreml_model_for_noise, resolve_waifu2x_paths,
    RealCuganPaths, Waifu2xPaths,
};
pub use realcugan::{CuganModelPack, RealCuganEngine};
pub use realesrgan_coreml::RealEsrganCoreMlEngine;
pub use waifu2x::Waifu2xEngine;
pub use waifu2x_coreml::Waifu2xCoreMlEngine;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineKind {
    Waifu2x,
    Waifu2xCoreMl,
    RealEsrganCoreMl,
    RealCugan,
    #[cfg(feature = "anime4k")]
    Anime4K2x,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QualityPreset {
    Fast,
    Balanced,
    Quality,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum ScaleFactor {
    X1 = 1,
    X2 = 2,
    X3 = 3,
    X4 = 4,
}

impl ScaleFactor {
    pub fn try_from_u8(v: u8) -> Result<Self, String> {
        match v {
            1 => Ok(Self::X1),
            2 => Ok(Self::X2),
            3 => Ok(Self::X3),
            4 => Ok(Self::X4),
            8 => Err("scale=8 属于多 pass，当前仅支持 1/2/3/4".into()),
            other => Err(format!("无效 scale: {other}")),
        }
    }

    pub fn as_u8(self) -> u8 {
        self as u8
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnhanceParams {
    pub engine: EngineKind,
    pub scale: ScaleFactor,
    pub noise_level: i8,
    pub preset: QualityPreset,
    pub tile_size: Option<u32>,
    pub gpu_id: Option<i32>,
    pub tta: bool,
    /// waifu2x `-j load:proc:save` (optional; engine may auto-fill)
    #[serde(default)]
    pub jobs: Option<String>,
    /// waifu2x `-f jpg|png|webp` so export can skip a second encode
    #[serde(default)]
    pub output_format: Option<String>,
    /// Real-CUGAN pack: se | pro | nose
    #[serde(default)]
    pub cugan_model: Option<String>,
}

impl Default for EnhanceParams {
    fn default() -> Self {
        Self {
            engine: EngineKind::Waifu2x,
            scale: ScaleFactor::X2,
            noise_level: 1,
            preset: QualityPreset::Balanced,
            tile_size: None,
            gpu_id: None,
            tta: false,
            jobs: None,
            output_format: None,
            cugan_model: None,
        }
    }
}

#[derive(Debug, Clone)]
pub enum EnhanceBatchRequest {
    Directory {
        input_dir: PathBuf,
        output_dir: PathBuf,
        params: EnhanceParams,
    },
    SingleFile {
        input: PathBuf,
        output: PathBuf,
        params: EnhanceParams,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnhanceBatchResult {
    pub pages_ok: u32,
    pub pages_failed: u32,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuInfo {
    pub id: i32,
    pub name: String,
    pub is_cpu: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineAvailability {
    Ready,
    MissingBinary,
    ChecksumMismatch,
    Unavailable(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub id: String,
    pub available: bool,
    pub detail: String,
    pub version: Option<String>,
}

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("binary missing or checksum mismatch")]
    BinaryIntegrity,
    #[error("gpu unavailable: {0}")]
    GpuUnavailable(String),
    #[error("oom or tile failure")]
    OutOfMemory,
    #[error("timeout after {0:?}")]
    Timeout(Duration),
    #[error("cancelled")]
    Cancelled,
    #[error("process failed: {0}")]
    Process(String),
    #[error("decode/encode: {0}")]
    Image(String),
    #[error("io: {0}")]
    Io(String),
}

impl From<std::io::Error> for EngineError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

#[async_trait]
pub trait UpscaleEngine: Send + Sync {
    fn id(&self) -> EngineKind;
    fn is_available(&self) -> EngineAvailability;
    fn status(&self) -> EngineStatus;
    async fn list_gpus(&self) -> Result<Vec<GpuInfo>, EngineError>;
    async fn enhance_batch(
        &self,
        req: EnhanceBatchRequest,
        cancel: CancellationToken,
    ) -> Result<EnhanceBatchResult, EngineError>;
}

/// Verify file SHA-256 hex digest (lowercase).
pub fn verify_sha256(path: &std::path::Path, expected_hex: &str) -> Result<(), EngineError> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    if !path.is_file() {
        return Err(EngineError::BinaryIntegrity);
    }
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let got = hex::encode(hasher.finalize());
    if got.eq_ignore_ascii_case(expected_hex.trim()) {
        Ok(())
    } else {
        Err(EngineError::BinaryIntegrity)
    }
}
