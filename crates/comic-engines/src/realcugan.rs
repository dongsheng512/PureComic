//! realcugan-ncnn-vulkan sidecar (SE/PRO/NOSE packs).

use crate::{
    verify_sha256, EngineAvailability, EngineError, EngineKind, EngineStatus, EnhanceBatchRequest,
    EnhanceBatchResult, GpuInfo, UpscaleEngine,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CuganModelPack {
    Se,
    Pro,
    Nose,
}

impl CuganModelPack {
    pub fn parse(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "pro" | "models-pro" => Self::Pro,
            "nose" | "models-nose" | "no-se" => Self::Nose,
            _ => Self::Se,
        }
    }

    pub fn dir_name(self) -> &'static str {
        match self {
            Self::Se => "models-se",
            Self::Pro => "models-pro",
            Self::Nose => "models-nose",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Se => "se",
            Self::Pro => "pro",
            Self::Nose => "nose",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RealCuganEngine {
    pub binary: PathBuf,
    pub models_root: PathBuf,
    pub page_timeout: Duration,
    /// checksums.sha256 pin 的期望值；接线后二进制被替换即拒绝执行
    pub expected_sha256: Option<String>,
}

impl RealCuganEngine {
    pub fn new(binary: PathBuf, models_root: PathBuf) -> Self {
        Self {
            binary,
            models_root,
            page_timeout: Duration::from_secs(180),
            expected_sha256: None,
        }
    }

    fn pack_dir(&self, pack: CuganModelPack) -> PathBuf {
        let named = self.models_root.join(pack.dir_name());
        if named.is_dir() {
            return named;
        }
        // models_root itself may already be models-se
        if self.models_root.file_name().and_then(|n| n.to_str()) == Some(pack.dir_name()) {
            return self.models_root.clone();
        }
        named
    }

    fn check_integrity(&self) -> Result<(), EngineError> {
        if !self.binary.is_file() {
            return Err(EngineError::BinaryIntegrity);
        }
        if let Some(ref sum) = self.expected_sha256 {
            verify_sha256(&self.binary, sum)?;
        }
        if !self.pack_dir(CuganModelPack::Se).is_dir()
            && !self.pack_dir(CuganModelPack::Pro).is_dir()
            && !self.pack_dir(CuganModelPack::Nose).is_dir()
        {
            return Err(EngineError::BinaryIntegrity);
        }
        Ok(())
    }

    pub fn available_packs(&self) -> Vec<CuganModelPack> {
        [
            CuganModelPack::Se,
            CuganModelPack::Pro,
            CuganModelPack::Nose,
        ]
        .into_iter()
        .filter(|p| self.pack_dir(*p).is_dir())
        .collect()
    }
}

#[async_trait]
impl UpscaleEngine for RealCuganEngine {
    fn id(&self) -> EngineKind {
        EngineKind::RealCugan
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
        let packs = self
            .available_packs()
            .iter()
            .map(|p| p.id())
            .collect::<Vec<_>>()
            .join(",");
        let av = self.is_available();
        let (available, detail) = match av {
            EngineAvailability::Ready => {
                (true, format!("realcugan-ncnn-vulkan 就绪 · 模型 {packs}"))
            }
            EngineAvailability::MissingBinary => {
                (false, format!("未找到二进制: {}", self.binary.display()))
            }
            EngineAvailability::ChecksumMismatch => (false, "二进制校验失败".into()),
            EngineAvailability::Unavailable(s) => (false, s),
        };
        EngineStatus {
            id: "realcugan".into(),
            available,
            detail,
            version: None,
            threads: None,
            mode: None,
            is_mock: false,
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

        let pack = CuganModelPack::parse(params.cugan_model.as_deref().unwrap_or("se"));
        let models = self.pack_dir(pack);
        if !models.is_dir() {
            return Err(EngineError::Process(format!(
                "缺少 Real-CUGAN 模型包 {}",
                pack.dir_name()
            )));
        }

        // Packs only ship up2x / up3x / up4x. Scale 1 would look for missing weights.
        let mut scale = params.scale.as_u8().clamp(2, 4);
        let mut noise = params.noise_level.clamp(-1, 3);
        if pack == CuganModelPack::Nose {
            scale = 2;
            noise = 0;
        } else if pack == CuganModelPack::Pro && noise > 0 && noise < 3 {
            noise = 3;
        }
        let scale = scale.to_string();
        let noise = noise.to_string();
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
            models.display().to_string(),
            "-c".into(),
            "3".into(),
        ];
        if params.tta {
            args.push("-x".into());
        }
        if let Some(fmt) = params.output_format.as_deref() {
            args.push("-f".into());
            args.push(fmt.to_string());
        }

        info!(binary = %self.binary.display(), pack = pack.id(), ?args, "spawn realcugan");

        let mut cmd = Command::new(&self.binary);
        cmd.args(&args)
            // stdout 只打进度且无人消费，pipe 会在管道缓冲满后阻塞子进程（大书死锁）
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        unsafe {
            cmd.pre_exec(|| {
                let _ = libc::setsid();
                Ok(())
            });
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| EngineError::Process(format!("无法启动 Real-CUGAN: {e}")))?;
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
        // 目录批基线：输出目录可能预存续跑产物，成功计数只认本次新增；
        // 页级失败数 = 输入页数 - 本次产出（引擎单页失败时退出码仍为 0）
        let out_baseline = if is_dir {
            count_files(&output).unwrap_or(0)
        } else {
            0
        };
        let expected_pages = if is_dir {
            count_files(&input).unwrap_or(0).max(1)
        } else {
            1
        };
        let timeout = if is_dir {
            // 按输入页数估算整批耗时（同 waifu2x），固定 64 页预算会误杀慢 GPU 大书
            let pages = expected_pages;
            self.page_timeout
                .saturating_mul((pages / 8).max(1))
                .saturating_mul(2)
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
                    // stderr 残留句柄可能让 join 挂起：限时取已累计内容，避免成功批被误判 Timeout
                    let err_text = match tokio::time::timeout(Duration::from_secs(3), stderr_task)
                        .await
                    {
                        Ok(Ok(text)) => text,
                        _ => String::new(),
                    };
                    if status.success() {
                        let pages_ok = if is_dir {
                            count_files(&output)
                                .unwrap_or(0)
                                .saturating_sub(out_baseline)
                                .min(expected_pages)
                        } else if output.is_file() {
                            1
                        } else {
                            0
                        };
                        let pages_failed = expected_pages.saturating_sub(pages_ok);
                        let mut message = if err_text.is_empty() {
                            None
                        } else {
                            Some(truncate(&err_text, 512))
                        };
                        if pages_failed > 0 {
                            let note = format!("引擎输出 {pages_ok}/{expected_pages} 页");
                            message = Some(match message {
                                Some(m) => format!("{m} | {note}"),
                                None => note,
                            });
                        }
                        Ok(EnhanceBatchResult {
                            pages_ok,
                            pages_failed,
                            message,
                        })
                    } else {
                        warn!(%status, %err_text, "realcugan failed");
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
    // 子进程已退出（可能已被 wait 回收）则不再发组信号：
    // pid 复用后负 pid 会命中无关进程组
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe {
            let _ = libc::kill(-(pid as i32), libc::SIGTERM);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        unsafe {
            let _ = libc::kill(-(pid as i32), libc::SIGKILL);
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

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        // 找到不超过 max 的 UTF-8 字符边界，避免在多字节字符中间切片 panic
        let mut end = max;
        while end > 0 && !s.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &s[..end])
    }
}
