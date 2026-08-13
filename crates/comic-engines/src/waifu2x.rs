//! waifu2x-ncnn-vulkan sidecar wrapper.
//! Prefer directory batch (`-i dir -o dir`); pipeline may use single-file for progress.

use crate::{
    verify_sha256, EnhanceBatchRequest, EnhanceBatchResult, EngineAvailability, EngineError,
    EngineKind, EngineStatus, GpuInfo, UpscaleEngine,
};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

const STDERR_CAP: usize = 256 * 1024;

#[derive(Debug, Clone)]
pub struct Waifu2xEngine {
    pub binary: PathBuf,
    pub models_dir: PathBuf,
    pub expected_sha256: Option<String>,
    pub page_timeout: Duration,
}

impl Waifu2xEngine {
    pub fn new(binary: PathBuf, models_dir: PathBuf) -> Self {
        Self {
            binary,
            models_dir,
            expected_sha256: None,
            page_timeout: Duration::from_secs(180),
        }
    }

    fn check_integrity(&self) -> Result<(), EngineError> {
        if !self.binary.is_file() {
            return Err(EngineError::BinaryIntegrity);
        }
        if let Some(ref sum) = self.expected_sha256 {
            verify_sha256(&self.binary, sum)?;
        }
        if !self.models_dir.is_dir() {
            return Err(EngineError::BinaryIntegrity);
        }
        Ok(())
    }
}

#[async_trait]
impl UpscaleEngine for Waifu2xEngine {
    fn id(&self) -> EngineKind {
        EngineKind::Waifu2x
    }

    fn is_available(&self) -> EngineAvailability {
        match self.check_integrity() {
            Ok(()) => EngineAvailability::Ready,
            Err(EngineError::BinaryIntegrity) => {
                if self.binary.is_file() {
                    EngineAvailability::ChecksumMismatch
                } else {
                    EngineAvailability::MissingBinary
                }
            }
            Err(e) => EngineAvailability::Unavailable(e.to_string()),
        }
    }

    fn status(&self) -> EngineStatus {
        let av = self.is_available();
        let (available, detail) = match av {
            EngineAvailability::Ready => (true, "waifu2x-ncnn-vulkan 就绪".into()),
            EngineAvailability::MissingBinary => (
                false,
                format!("未找到二进制: {}", self.binary.display()),
            ),
            EngineAvailability::ChecksumMismatch => {
                (false, "二进制 SHA-256 校验失败".into())
            }
            EngineAvailability::Unavailable(s) => (false, s),
        };
        EngineStatus {
            id: "waifu2x".into(),
            available,
            detail,
            version: None,
        }
    }

    async fn list_gpus(&self) -> Result<Vec<GpuInfo>, EngineError> {
        Ok(vec![
            GpuInfo {
                id: -1,
                name: "CPU (-g -1)".into(),
                is_cpu: true,
            },
            GpuInfo {
                id: 0,
                name: "GPU 0 (auto/Vulkan)".into(),
                is_cpu: false,
            },
        ])
    }

    async fn enhance_batch(
        &self,
        req: EnhanceBatchRequest,
        cancel: CancellationToken,
    ) -> Result<EnhanceBatchResult, EngineError> {
        self.check_integrity()?;
        let (input, output, params, is_dir) = match req {
            EnhanceBatchRequest::Directory {
                input_dir,
                output_dir,
                params,
            } => {
                tokio::fs::create_dir_all(&output_dir).await?;
                (input_dir, output_dir, params, true)
            }
            EnhanceBatchRequest::SingleFile {
                input,
                output,
                params,
            } => {
                if let Some(p) = output.parent() {
                    tokio::fs::create_dir_all(p).await?;
                }
                (input, output, params, false)
            }
        };

        let scale = params.scale.as_u8().to_string();
        let noise = params.noise_level.to_string();
        let tile = params
            .tile_size
            .map(|t| t.to_string())
            .unwrap_or_else(|| "0".into());
        let gpu = params
            .gpu_id
            .map(|g| g.to_string())
            .unwrap_or_else(|| "0".into());

        let jobs = params.jobs.clone().unwrap_or_else(|| {
            let cpus = num_cpus::get().max(1);
            let proc = cpus.clamp(2, 8);
            let load = (cpus / 2).clamp(1, 4);
            let save = (cpus / 2).clamp(1, 4);
            format!("{load}:{proc}:{save}")
        });

        let mut args = vec![
            "-i".into(),
            input.display().to_string(),
            "-o".into(),
            output.display().to_string(),
            "-n".into(),
            noise,
            "-s".into(),
            scale,
            "-t".into(),
            tile,
            "-g".into(),
            gpu,
            "-j".into(),
            jobs,
            "-m".into(),
            self.models_dir.display().to_string(),
        ];
        if params.tta {
            args.push("-x".into());
        }
        if let Some(fmt) = params.output_format.as_deref() {
            args.push("-f".into());
            args.push(fmt.to_string());
        }

        info!(binary = %self.binary.display(), ?args, "spawn waifu2x");

        let mut cmd = Command::new(&self.binary);
        cmd.args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        // Put child in its own process group so cancel can kill the whole tree (Unix).
        #[cfg(unix)]
        unsafe {
            cmd.pre_exec(|| {
                // setsid() creates new session/process group with child as leader
                if libc::setsid() == -1 {
                    // non-fatal: still run under parent group
                }
                Ok(())
            });
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| EngineError::Process(format!("无法启动引擎: {e}")))?;

        let child_id = child.id();
        let stderr = child.stderr.take();
        let stderr_task = tokio::spawn(async move {
            let mut acc = String::new();
            if let Some(err) = stderr {
                let mut lines = BufReader::new(err).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if acc.len() < STDERR_CAP {
                        acc.push_str(&line);
                        acc.push('\n');
                    }
                }
            }
            acc
        });
        let stderr_abort = stderr_task.abort_handle();

        let timeout = if is_dir {
            self.page_timeout
                .saturating_mul(64)
                .max(Duration::from_secs(600))
        } else {
            self.page_timeout
        };

        let wait_result = tokio::time::timeout(timeout, async {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    kill_child_tree(&mut child, child_id).await;
                    stderr_abort.abort();
                    Err(EngineError::Cancelled)
                }
                status = child.wait() => {
                    let status = status.map_err(|e| EngineError::Process(e.to_string()))?;
                    let err_text = stderr_task.await.unwrap_or_default();
                    if status.success() {
                        let pages_ok = if is_dir {
                            count_files(&output).unwrap_or(0)
                        } else if output.is_file() {
                            1
                        } else {
                            0
                        };
                        Ok(EnhanceBatchResult {
                            pages_ok,
                            pages_failed: 0,
                            message: if err_text.is_empty() {
                                None
                            } else {
                                Some(truncate(&err_text, 512))
                            },
                        })
                    } else {
                        warn!(%status, %err_text, "waifu2x failed");
                        if err_text.to_ascii_lowercase().contains("out of memory")
                            || err_text.contains("OOM")
                        {
                            return Err(EngineError::OutOfMemory);
                        }
                        Err(EngineError::Process(format!(
                            "exit {status}: {}",
                            truncate(&err_text, 1024)
                        )))
                    }
                }
            }
        })
        .await;

        match wait_result {
            Ok(r) => r,
            Err(_) => {
                kill_child_tree(&mut child, child_id).await;
                stderr_abort.abort();
                Err(EngineError::Timeout(timeout))
            }
        }
    }
}

async fn kill_child_tree(child: &mut tokio::process::Child, pid: Option<u32>) {
    // Try graceful then hard kill
    #[cfg(unix)]
    if let Some(pid) = pid {
        // Negative PID = process group (requires setsid in pre_exec)
        unsafe {
            let _ = libc::kill(-(pid as i32), libc::SIGTERM);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        unsafe {
            let _ = libc::kill(-(pid as i32), libc::SIGKILL);
        }
        // also kill the process itself
        unsafe {
            let _ = libc::kill(pid as i32, libc::SIGKILL);
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

fn count_files(dir: &Path) -> std::io::Result<u32> {
    let mut n = 0u32;
    if dir.is_dir() {
        for e in std::fs::read_dir(dir)? {
            let e = e?;
            if e.path().is_file() {
                n += 1;
            }
        }
    }
    Ok(n)
}

#[cfg(all(test, unix))]
mod kill_tests {
    use super::*;
    use std::process::Stdio;

    #[tokio::test]
    async fn cancel_kills_process_group() {
        let mut cmd = tokio::process::Command::new("sleep");
        cmd.arg("30")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        unsafe {
            cmd.pre_exec(|| {
                let _ = libc::setsid();
                Ok(())
            });
        }
        let mut child = cmd.spawn().expect("spawn sleep");
        let pid = child.id().expect("pid");
        assert!(
            std::path::Path::new(&format!("/proc/{pid}")).exists()
                || libc_kill_ok(pid as i32, 0),
            "sleep should be running"
        );
        kill_child_tree(&mut child, Some(pid)).await;
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(
            !libc_kill_ok(pid as i32, 0),
            "sleep pid {pid} should be gone after cancel"
        );
    }

    fn libc_kill_ok(pid: i32, sig: i32) -> bool {
        unsafe { libc::kill(pid, sig) == 0 }
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}
