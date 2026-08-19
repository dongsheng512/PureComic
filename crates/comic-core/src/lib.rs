//! comic-core — import, job manifest, scheduling, export.
//!
//! No Tauri dependency: shared by desktop and CLI.

pub mod archive;
pub mod config;
pub mod cover;
pub mod diagnostics;
pub mod ebook;
pub mod error;
pub mod estimate;
pub mod image_io;
pub mod job;
pub mod library;
pub mod natural_sort;
pub mod pipeline;
pub mod preview;
pub mod reader;
pub mod reader_enhance;
pub mod scheduler;
pub mod security;
pub mod unrar;

pub use config::AppConfig;
pub use error::{AppError, AppResult, ErrorCode};
pub use job::{
    CreateJobRequest, CreateJobResult, JobManifest, JobState, JobStatus, OutputOptions, PageStatus,
    ResumeHint, SourceKind,
};
pub use scheduler::Scheduler;
