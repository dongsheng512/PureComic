//! Upscale engines: trait, mock, Core ML (Waifu2x / Real-CUGAN / Real-ESRGAN), optional Vulkan sidecars.

mod animevideo_coreml;
mod hub;
mod mock;
pub mod paths;
mod realcugan;
mod realcugan_coreml;
mod realesrgan_coreml;
mod waifu2x;
mod waifu2x_coreml;

pub use animevideo_coreml::AnimeVideoCoreMlEngine;
pub use hub::{EngineHub, EngineInfo};
pub use mock::MockEngine;
pub use paths::{
    host_target_triple, resolve_animevideo_coreml_model, resolve_realcugan_coreml_model,
    resolve_realcugan_coreml_model_for_noise, resolve_realcugan_paths,
    resolve_realesrgan_coreml_model, resolve_waifu2x_coreml_model,
    resolve_waifu2x_coreml_model_for_noise, resolve_waifu2x_paths, RealCuganPaths, Waifu2xPaths,
};
pub use realcugan::{CuganModelPack, RealCuganEngine};
pub use realcugan_coreml::RealCuganCoreMlEngine;
pub use realesrgan_coreml::RealEsrganCoreMlEngine;
pub use waifu2x::Waifu2xEngine;
pub use waifu2x_coreml::Waifu2xCoreMlEngine;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

/// Hard decode guardrails（与 comic-core 同值）：压缩炸弹可能通过字节级检查，
/// 但解码瞬间会展开成数 GB 像素缓冲——Rust 分配失败是 abort，不可恢复。
pub const HARD_MAX_IMAGE_SIDE: u32 = 16_384;
pub const HARD_MAX_IMAGE_PIXELS: u64 = 268_435_456; // 16384²

/// Decode 前的尺寸守卫：超限返回 Image 错误而不是尝试分配。
pub fn check_hard_dimensions(w: u32, h: u32) -> Result<(), EngineError> {
    if w > HARD_MAX_IMAGE_SIDE
        || h > HARD_MAX_IMAGE_SIDE
        || (w as u64).saturating_mul(h as u64) > HARD_MAX_IMAGE_PIXELS
    {
        return Err(EngineError::Image(format!(
            "图像尺寸超过安全上限 ({w}x{h})"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineKind {
    Waifu2x,
    Waifu2xCoreMl,
    RealEsrganCoreMl,
    RealCuganCoreMl,
    AnimeVideoCoreMl,
    RealCugan,
    #[cfg(feature = "anime4k")]
    Anime4K2x,
}

#[cfg(test)]
mod dimension_tests {
    use super::*;

    #[test]
    fn limit_boundary_is_allowed() {
        assert!(check_hard_dimensions(16_384, 16_384).is_ok());
        assert!(check_hard_dimensions(1, 1).is_ok());
        // 边长受限时像素总量恒不超限（冗余防线的边界自洽）
        assert_eq!((16_384u64).saturating_mul(16_384), HARD_MAX_IMAGE_PIXELS);
    }

    #[test]
    fn oversized_side_is_rejected() {
        let err = check_hard_dimensions(16_385, 100).unwrap_err();
        assert!(matches!(err, EngineError::Image(_)));
        let err = check_hard_dimensions(100, 30_000).unwrap_err();
        assert!(matches!(err, EngineError::Image(_)));
    }
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
            engine: EngineKind::RealCuganCoreMl,
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
    /// 运行时线程参数，例如 `2:2:2`。没有则前端再从说明文字里认。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threads: Option<String>,
    /// 目录批处理 / 逐页 / Core ML。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_mock: bool,
}

impl EngineStatus {
    pub fn new(
        id: impl Into<String>,
        available: bool,
        detail: impl Into<String>,
        version: Option<String>,
    ) -> Self {
        Self {
            id: id.into(),
            available,
            detail: detail.into(),
            version,
            threads: None,
            mode: None,
            is_mock: false,
        }
    }
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

struct ShaCacheHit {
    mtime: SystemTime,
    len: u64,
    /// Lowercased expected digest this hit was computed against.
    expected: String,
}

/// Successful SHA checks only. Failures are not cached so a replaced file
/// (same path, later matching pin) is re-read instead of sticking on a miss.
fn sha_cache() -> std::sync::MutexGuard<'static, HashMap<PathBuf, ShaCacheHit>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, ShaCacheHit>>> = OnceLock::new();
    CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
fn sha_compute_counts() -> std::sync::MutexGuard<'static, HashMap<PathBuf, u64>> {
    static COUNTS: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();
    COUNTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn file_fingerprint(path: &Path) -> Option<(SystemTime, u64)> {
    let meta = path.metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    Some((meta.modified().ok()?, meta.len()))
}

fn hash_file_sha256(path: &Path) -> Result<String, EngineError> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
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
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(test)]
fn note_sha_compute(path: &Path) {
    *sha_compute_counts().entry(path.to_path_buf()).or_insert(0) += 1;
}

#[cfg(test)]
pub fn sha256_compute_count(path: &Path) -> u64 {
    sha_compute_counts().get(path).copied().unwrap_or(0)
}

/// Verify file SHA-256 hex digest (lowercase).
///
/// Process-level cache: if `mtime` + `len` are unchanged and the expected
/// digest matches a previous **success**, skip re-hashing the whole binary.
///
/// # 威胁模型（别把这个缓存当成防篡改手段）
///
/// 缓存命中判据是 `mtime + len + expected` 三者相同 —— 这只是**省掉重复哈希**的
/// 性能优化，**不是**完整性证明。攻击者只要做一个等长改写再用 `utimensat` 把 mtime
/// 回写成原值，就能让命中继续成立，从而绕开一次校验。也就是说：
///
/// - 能防：传输/打包环节造成的截断、错版本、磁盘损坏（长度或 mtime 通常都会变）。
/// - 不能防：**对本地文件有写权限的**攻击者精心构造的替换。
///
/// 如果将来要拿它挡本地篡改，必须换掉校验依据（例如每次启动都重新哈希、把摘要记在
/// 只读位置，或用系统代码签名 / 文件权限做真正的锚）。
/// 为避免这条弱化被误读，缓存只存成功项、失败一律不缓存，且 mtime 用纳秒精度。
pub fn verify_sha256(path: &Path, expected_hex: &str) -> Result<(), EngineError> {
    if !path.is_file() {
        return Err(EngineError::BinaryIntegrity);
    }
    let expected = expected_hex.trim().to_ascii_lowercase();
    let fp = file_fingerprint(path);
    if let Some((mtime, len)) = fp {
        let cache = sha_cache();
        if let Some(hit) = cache.get(path) {
            if hit.mtime == mtime && hit.len == len && hit.expected == expected {
                return Ok(());
            }
        }
    }

    #[cfg(test)]
    note_sha_compute(path);

    let got = hash_file_sha256(path)?;
    if !got.eq_ignore_ascii_case(&expected) {
        return Err(EngineError::BinaryIntegrity);
    }
    if let Some((mtime, len)) = fp.or_else(|| file_fingerprint(path)) {
        sha_cache().insert(
            path.to_path_buf(),
            ShaCacheHit {
                mtime,
                len,
                expected,
            },
        );
    }
    Ok(())
}

#[cfg(test)]
mod verify_sha256_tests {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Write;

    fn sha_hex(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    #[test]
    fn second_check_skips_rehash() {
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        tmp.write_all(b"purecomic-sha-cache").unwrap();
        tmp.flush().unwrap();
        let path = tmp.path().to_path_buf();
        let sum = sha_hex(b"purecomic-sha-cache");
        let before = sha256_compute_count(&path);
        verify_sha256(&path, &sum).unwrap();
        verify_sha256(&path, &sum).unwrap();
        verify_sha256(&path, &sum.to_ascii_uppercase()).unwrap();
        assert_eq!(sha256_compute_count(&path), before + 1);
    }

    #[test]
    fn mismatch_is_not_cached() {
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        tmp.write_all(b"aaa").unwrap();
        tmp.flush().unwrap();
        let path = tmp.path().to_path_buf();
        let before = sha256_compute_count(&path);
        let wrong = sha_hex(b"bbb");
        assert!(verify_sha256(&path, &wrong).is_err());
        assert!(verify_sha256(&path, &wrong).is_err());
        assert_eq!(sha256_compute_count(&path), before + 2);
    }

    #[test]
    fn content_change_rehashes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bin");
        std::fs::write(&path, b"v1").unwrap();
        let s1 = sha_hex(b"v1");
        verify_sha256(&path, &s1).unwrap();
        let after_first = sha256_compute_count(&path);
        std::fs::write(&path, b"v2").unwrap();
        assert!(verify_sha256(&path, &s1).is_err());
        verify_sha256(&path, &sha_hex(b"v2")).unwrap();
        assert!(sha256_compute_count(&path) >= after_first + 2);
    }
}
