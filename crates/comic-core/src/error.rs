use serde::{Deserialize, Serialize};
use thiserror::Error;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    BinaryIntegrity,
    GpuUnavailable,
    Oom,
    Timeout,
    Cancelled,
    DecodeFail,
    DiskInsufficient,
    UnsupportedFormat,
    PathTraversal,
    UnrarMissing,
    ProcessFail,
    Internal,
    NotFound,
    InvalidArgument,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BinaryIntegrity => "BINARY_INTEGRITY",
            Self::GpuUnavailable => "GPU_UNAVAILABLE",
            Self::Oom => "OOM",
            Self::Timeout => "TIMEOUT",
            Self::Cancelled => "CANCELLED",
            Self::DecodeFail => "DECODE_FAIL",
            Self::DiskInsufficient => "DISK_INSUFFICIENT",
            Self::UnsupportedFormat => "UNSUPPORTED_FORMAT",
            Self::PathTraversal => "PATH_TRAVERSAL",
            Self::UnrarMissing => "UNRAR_MISSING",
            Self::ProcessFail => "PROCESS_FAIL",
            Self::Internal => "INTERNAL",
            Self::NotFound => "NOT_FOUND",
            Self::InvalidArgument => "INVALID_ARGUMENT",
        }
    }
}

#[derive(Debug, Clone, Error, Serialize, Deserialize)]
#[error("{message}")]
pub struct AppError {
    pub code: ErrorCode,
    /// zh-CN message for UI
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, msg)
    }

    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument, msg)
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, msg)
    }

    pub fn unsupported(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::UnsupportedFormat, msg)
    }

    pub fn disk(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::DiskInsufficient, msg)
    }

    pub fn path_traversal(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::PathTraversal, msg)
    }

    pub fn cancelled() -> Self {
        Self::new(ErrorCode::Cancelled, "任务已取消")
    }

    pub fn unrar_missing() -> Self {
        crate::unrar::unrar_missing()
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::internal(format!("IO 错误: {e}")).with_detail(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::internal(format!("JSON 错误: {e}")).with_detail(e.to_string())
    }
}

impl From<comic_engines::EngineError> for AppError {
    fn from(e: comic_engines::EngineError) -> Self {
        use comic_engines::EngineError;
        match e {
            EngineError::BinaryIntegrity => Self::new(
                ErrorCode::BinaryIntegrity,
                "Waifu2x 引擎损坏或校验失败，请重新安装应用或运行 scripts/fetch-waifu2x.sh",
            ),
            EngineError::GpuUnavailable(s) => {
                Self::new(ErrorCode::GpuUnavailable, format!("GPU 不可用: {s}")).with_detail(s)
            }
            EngineError::OutOfMemory => Self::new(ErrorCode::Oom, "显存/内存不足，可尝试减小分块"),
            EngineError::Timeout(d) => Self::new(ErrorCode::Timeout, format!("处理超时 ({d:?})")),
            EngineError::Cancelled => Self::cancelled(),
            EngineError::Process(s) => {
                Self::new(ErrorCode::ProcessFail, "引擎进程失败").with_detail(s)
            }
            EngineError::Image(s) => {
                Self::new(ErrorCode::DecodeFail, "图像处理失败").with_detail(s)
            }
            EngineError::Io(s) => Self::internal(s),
        }
    }
}
