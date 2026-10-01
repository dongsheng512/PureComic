//! Job scheduler: create, list, cancel, background run.

use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
use crate::job::{CreateJobRequest, CreateJobResult, JobManifest, JobState, JobStatus, ResumeHint};
use crate::pipeline::{self, new_gpu_lock, GpuLock, ProgressCallback};
use comic_engines::{EngineHub, EngineInfo, EngineKind, MockEngine, UpscaleEngine};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

enum WorkerSlot {
    Pending,
    Running(tokio::task::JoinHandle<()>),
}

struct ClearActive(Arc<AtomicBool>);

impl Drop for ClearActive {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

struct LiveJob {
    manifest: Arc<RwLock<JobManifest>>,
    cancel: CancellationToken,
    /// 源路径快照：jobs 锁内做同源去重，避免嵌套读 manifest 锁
    source: PathBuf,
    /// worker 仍视为活动（含 handle 尚未挂上的预约窗口）
    active: Arc<AtomicBool>,
    /// remove_job 等待超时后置位：worker 后续 save() 全部跳过，防目录复活
    abandoned: Arc<AtomicBool>,
    /// worker 任务句柄：remove_job 等其挂上并退出，避免删除后目录被重建
    handle: Arc<StdMutex<WorkerSlot>>,
    handle_ready: Arc<tokio::sync::Notify>,
}

pub struct Scheduler {
    cfg: AppConfig,
    gpu: GpuLock,
    hub: EngineHub,
    override_engine: Option<Arc<dyn UpscaleEngine>>,
    jobs: Arc<RwLock<HashMap<String, LiveJob>>>,
    on_progress: Arc<RwLock<Option<ProgressCallback>>>,
    library: StdMutex<crate::library::LibraryStore>,
    reader_enhance_cancels: Arc<StdMutex<Vec<(u64, String, CancellationToken)>>>,
    reader_enhance_cancel_seq: AtomicU64,
    /// Serializes resume discovery with finished-job GC so a resumed id is not deleted mid-insert.
    gc: tokio::sync::Mutex<()>,
    /// Terminal disk jobs: reuse JobStatus while manifest mtime/len are unchanged.
    disk_status_cache: Arc<StdMutex<HashMap<String, CachedDiskStatus>>>,
    /// Last successful source validate. Estimate and job creation reuse it.
    source_validation: Arc<StdMutex<Option<CachedValidation>>>,
    /// One in-flight validate per scheduler, so estimate does not scan the book again.
    validate_gate: Arc<tokio::sync::Mutex<()>>,
}

struct CachedValidation {
    path: PathBuf,
    mtime_nanos: u128,
    len: u64,
    result: crate::archive::ValidateResult,
}

struct CachedDiskStatus {
    mtime_nanos: u128,
    len: u64,
    status: JobStatus,
}

fn source_stamp(path: &Path) -> Option<(u128, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    let nanos = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((nanos, meta.len()))
}

struct UnregisterReaderCancel {
    slots: Arc<StdMutex<Vec<(u64, String, CancellationToken)>>>,
    id: u64,
}

impl Drop for UnregisterReaderCancel {
    fn drop(&mut self) {
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        slots.retain(|(slot_id, _, _)| *slot_id != self.id);
    }
}

/// 在 blocking 线程里删缓存。需要时先独占读页，再拿 mobi 构建锁，锁盖住整个 `op`。
async fn blocking_cache_op<T, F>(gate_reads: bool, lock_mobi: bool, op: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let _reads = if gate_reads {
            Some(
                crate::reader::acquire_reader_clear_permit(Duration::from_secs(5))
                    .ok_or_else(|| AppError::invalid("正在读取，请稍后再清理缓存"))?,
            )
        } else {
            None
        };
        let _mobi = if lock_mobi {
            Some(crate::ebook::mobi_build_lock())
        } else {
            None
        };
        op()
    })
    .await
    .map_err(|e| AppError::internal(format!("缓存清理 join: {e}")))?
}

impl Scheduler {
    pub fn new(cfg: AppConfig) -> AppResult<Self> {
        cfg.ensure_dirs()?;
        let hub = EngineHub::from_config(
            cfg.waifu2x_bin.as_deref(),
            cfg.models_dir.as_deref(),
            cfg.use_mock_engine,
            cfg.allow_mock_fallback,
        );
        let library = StdMutex::new(crate::library::LibraryStore::open(&cfg)?);
        Ok(Self {
            cfg,
            gpu: new_gpu_lock(),
            hub,
            override_engine: None,
            jobs: Arc::new(RwLock::new(HashMap::new())),
            on_progress: Arc::new(RwLock::new(None)),
            library,
            reader_enhance_cancels: Arc::new(StdMutex::new(Vec::new())),
            reader_enhance_cancel_seq: AtomicU64::new(0),
            gc: tokio::sync::Mutex::new(()),
            disk_status_cache: Arc::new(StdMutex::new(HashMap::new())),
            source_validation: Arc::new(StdMutex::new(None)),
            validate_gate: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    /// 启动时把"会自己长个儿"的缓存夹回上限。
    ///
    /// 只在代码里补上上限是不够的：淘汰挂在"构建新缓存"那条路径上，
    /// 所以**存量**超限的部分要等用户下次打开同类型的新书才会被回收。
    /// 这里在启动时补跑一次，让历史上已经长出去的部分也收回来。
    ///
    /// 放独立线程：遍历上 GB 的目录树有真实磁盘 IO，不能拖慢启动。
    /// 失败只记日志 —— 缓存清不掉不该影响应用能用。
    pub fn spawn_cache_maintenance(&self) {
        let cfg = self.cfg.clone();
        let spawn = std::thread::Builder::new()
            .name("cache-maintenance".into())
            .spawn(move || {
                // 不拿读页写锁：拿到之后会把「刚翻完的那本」也删掉，下一页整本重建。
                // 正在读的目录由 pin 跳过。
                if let Err(e) = crate::ebook::evict_mobi_cache_blocking(&cfg, None) {
                    warn!(error = %e.message, "mobi cache eviction failed");
                }
            });
        if let Err(e) = spawn {
            warn!(error = %e, "failed to spawn cache maintenance thread");
        }
    }

    pub fn with_engine(cfg: AppConfig, engine: Arc<dyn UpscaleEngine>) -> AppResult<Self> {
        cfg.ensure_dirs()?;
        let hub = EngineHub::from_config(
            cfg.waifu2x_bin.as_deref(),
            cfg.models_dir.as_deref(),
            true,
            true,
        );
        let library = StdMutex::new(crate::library::LibraryStore::open(&cfg)?);
        Ok(Self {
            cfg,
            gpu: new_gpu_lock(),
            hub,
            override_engine: Some(engine),
            jobs: Arc::new(RwLock::new(HashMap::new())),
            on_progress: Arc::new(RwLock::new(None)),
            library,
            reader_enhance_cancels: Arc::new(StdMutex::new(Vec::new())),
            reader_enhance_cancel_seq: AtomicU64::new(0),
            gc: tokio::sync::Mutex::new(()),
            disk_status_cache: Arc::new(StdMutex::new(HashMap::new())),
            source_validation: Arc::new(StdMutex::new(None)),
            validate_gate: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    pub async fn set_progress_callback(&self, cb: ProgressCallback) {
        *self.on_progress.write().await = Some(cb);
    }

    pub fn config(&self) -> &AppConfig {
        &self.cfg
    }

    pub fn engine(&self) -> Arc<dyn UpscaleEngine> {
        self.pick_engine(self.hub.default_kind())
            .unwrap_or_else(|_| Arc::new(MockEngine::default()))
    }

    pub fn catalog(&self) -> Vec<EngineInfo> {
        self.hub.catalog()
    }

    fn pick_engine(&self, kind: EngineKind) -> AppResult<Arc<dyn UpscaleEngine>> {
        if let Some(e) = &self.override_engine {
            return Ok(e.clone());
        }
        self.hub
            .pick(kind)
            .map_err(|m| AppError::new(crate::error::ErrorCode::BinaryIntegrity, m))
    }

    pub async fn create_job(&self, req: CreateJobRequest) -> AppResult<CreateJobResult> {
        // 显式点名（非 auto、非空串——空串会被 parse_engine_kind 映射为默认引擎）
        // 的引擎缺失时不允许静默降级 mock
        let explicit_engine = req
            .engine
            .as_deref()
            .is_some_and(|e| !e.trim().is_empty() && !e.eq_ignore_ascii_case("auto"));
        let (source, mut options, output) = req.into_parts()?;
        // Real-CUGAN 参数归一化：实际生效值写进 manifest（引擎内部同规则仅兜底）
        let normalized = options.normalize_realcugan();
        self.ensure_engine_ready(options.engine, explicit_engine)?;
        let engine = self.pick_engine(options.engine)?;
        let est = self
            .estimate(
                &source.to_string_lossy(),
                crate::estimate::EstimateParams {
                    scale: options.scale.as_u8(),
                    engine: options.engine,
                    image_format: output.image_format,
                },
                Some(&output.dir),
            )
            .await?;
        if !est.ok {
            return Err(AppError::disk(
                est.message.unwrap_or_else(|| "磁盘空间不足".into()),
            ));
        }
        if !output.dir.exists() {
            std::fs::create_dir_all(&output.dir)?;
        }

        let want = source_key(&source);
        if let Some(live_id) = self.live_active_id_for_source(&want).await {
            return Err(AppError::invalid(format!(
                "该书已在队列中处理（任务 {live_id}）"
            )));
        }

        // 与 clear_finished_jobs 互斥：避免 resume 扫到的目录在 insert 前被 GC 删掉。
        let _gc = self.gc.lock().await;
        // 磁盘 resume 放在 jobs 写锁外，扫目录进 blocking，避免卡住 cancel/list。
        let jobs_dir = self.cfg.jobs_dir();
        let source_for_resume = source.clone();
        let resume =
            tokio::task::spawn_blocking(move || find_resume_in_dir(&jobs_dir, &source_for_resume))
                .await
                .map_err(|e| AppError::internal(format!("resume join: {e}")))?;
        let (job_id, manifest, resumed, done, total, next) = if let Some(hint) = resume {
            let dir = self.cfg.jobs_dir().join(&hint.job_id);
            let mut m = JobManifest::load(&dir)?;
            remap_done_from_disk(&mut m);
            m.options = options;
            m.output = output;
            m.state = JobState::Pending;
            m.error = None;
            m.last_message = Some(hint.message.clone());
            m.refresh_stats();
            let done = m.stats.pages_done;
            let total = m.stats.pages_total;
            let next = hint.next_page;
            info!(job = %hint.job_id, done, total, "resuming job");
            (hint.job_id, m, true, done, total, next)
        } else {
            let job_id = uuid::Uuid::new_v4().to_string();
            let workdir = self.cfg.jobs_dir().join(&job_id);
            let mut manifest = JobManifest::new(source.clone(), options, output, workdir);
            manifest.job_id = job_id.clone();
            manifest.workdir = self.cfg.jobs_dir().join(&job_id);
            if normalized {
                manifest.last_message = Some(format!(
                    "参数已按模型包归一化：{}× / n{}",
                    manifest.options.scale.as_u8(),
                    manifest.options.noise
                ));
            }
            (job_id, manifest, false, 0, 0, 1)
        };

        let cancel = CancellationToken::new();
        let manifest_arc = Arc::new(RwLock::new(manifest));
        let handle_slot = Arc::new(StdMutex::new(WorkerSlot::Pending));
        let handle_ready = Arc::new(tokio::sync::Notify::new());
        let active = Arc::new(AtomicBool::new(true));
        let abandoned = Arc::new(AtomicBool::new(false));
        {
            let mut m = manifest_arc.try_write().expect("fresh manifest lock");
            m.abandoned = abandoned.clone();
            // 真实引擎缺失回退 mock 时，任务消息里显式警告（不覆盖归一化提示）
            if engine.status().id == "mock" && !self.cfg.use_mock_engine {
                let note = "⚠️ 真实引擎不可用，使用模拟引擎（最近邻放大，非真实超分）";
                m.last_message = Some(match m.last_message.take() {
                    Some(existing) => format!("{existing}；{note}"),
                    None => note.into(),
                });
            }
        }

        let cfg = self.cfg.clone();
        let gpu = self.gpu.clone();
        let on_progress = self.on_progress.read().await.clone();

        // 写锁内只做「再检查 + 预约插入 + 挂上 handle」；不读磁盘、不嵌套 manifest。
        {
            let mut jobs = self.jobs.write().await;
            for (id, live) in jobs.iter() {
                if live.active.load(Ordering::Acquire) && source_key(&live.source) == want {
                    return Err(AppError::invalid(format!(
                        "该书已在队列中处理（任务 {id}）"
                    )));
                }
            }
            jobs.insert(
                job_id.clone(),
                LiveJob {
                    manifest: manifest_arc.clone(),
                    cancel: cancel.clone(),
                    source: source.clone(),
                    active: active.clone(),
                    abandoned: abandoned.clone(),
                    handle: handle_slot.clone(),
                    handle_ready: handle_ready.clone(),
                },
            );

            let job_id_spawn = job_id.clone();
            let manifest_run = manifest_arc.clone();
            let cancel_run = cancel.clone();
            let active_run = active.clone();
            let active_identity = active.clone();
            let jobs_map = self.jobs.clone();
            let handle = tokio::spawn(async move {
                let res = {
                    let _clear = ClearActive(active_run);
                    pipeline::run_job(
                        manifest_run.clone(),
                        engine,
                        cfg,
                        gpu,
                        cancel_run,
                        on_progress,
                    )
                    .await
                };
                if let Err(e) = res {
                    warn!(job = %job_id_spawn, error = %e, "job ended with error");
                } else {
                    info!(job = %job_id_spawn, "job finished ok");
                }
                let drop_from_map = {
                    let m = manifest_run.read().await;
                    !is_active_state(m.state) && m.save().is_ok()
                };
                if drop_from_map {
                    let mut map = jobs_map.write().await;
                    let same_slot = map
                        .get(&job_id_spawn)
                        .is_some_and(|live| Arc::ptr_eq(&live.active, &active_identity));
                    if same_slot {
                        map.remove(&job_id_spawn);
                    }
                }
            });
            *handle_slot.lock().unwrap_or_else(|e| e.into_inner()) = WorkerSlot::Running(handle);
            handle_ready.notify_waiters();
        }

        if let Err(e) = manifest_arc.read().await.save() {
            let _ = self.remove_job(&job_id).await;
            return Err(e);
        }

        {
            let p = manifest_arc.read().await.source.path.clone();
            if let Ok(mut lib) = self.library.lock() {
                let _ = lib.upsert_path(&p, &self.cfg);
                let _ = lib.attach_job(&p, &job_id, "running", None);
            }
        }

        let (actual_scale, actual_noise, actual_cugan_model) = {
            let m = manifest_arc.read().await;
            (
                m.options.scale.as_u8(),
                m.options.noise,
                m.options.cugan_model.clone(),
            )
        };
        Ok(CreateJobResult {
            job_id,
            resumed,
            pages_done: done,
            pages_total: total,
            next_page: next,
            actual_scale,
            actual_noise,
            actual_cugan_model,
        })
    }

    pub async fn probe_resume(&self, path: &str) -> AppResult<Option<ResumeHint>> {
        let source = PathBuf::from(path);
        if let Some(id) = self.live_job_for_source(&source).await {
            let jobs = self.jobs.read().await;
            if let Some(live) = jobs.get(&id) {
                let m = live.manifest.read().await;
                return Ok(Some(ResumeHint::from_counts(
                    id,
                    m.source.path.display().to_string(),
                    m.stats.pages_done,
                    m.stats.pages_total,
                )));
            }
        }
        let jobs_dir = self.cfg.jobs_dir();
        tokio::task::spawn_blocking(move || find_resume_in_dir(&jobs_dir, &source))
            .await
            .map_err(|e| AppError::internal(format!("probe_resume join: {e}")))
    }

    pub async fn cancel_job(&self, job_id: &str) -> AppResult<()> {
        validate_job_id(job_id)?;
        // 1) Live in-memory job: **cancel token FIRST** (never wait on write lock before this,
        //    or extract/enhance holding the lock will make cancel appear stuck).
        {
            let jobs = self.jobs.read().await;
            if let Some(live) = jobs.get(job_id) {
                live.cancel.cancel();
                info!(job = %job_id, "cancel token fired");
                // Best-effort state flip; use try_write so we never block cancel path.
                if let Ok(mut m) = live.manifest.try_write() {
                    if !matches!(
                        m.state,
                        JobState::Completed | JobState::Failed | JobState::Cancelled
                    ) {
                        m.state = JobState::Cancelling;
                        let _ = m.save();
                    }
                } else {
                    // Worker holds the lock; token is enough — state will flip when worker exits.
                    warn!(job = %job_id, "manifest busy; cancel token already set");
                }
                return Ok(());
            }
        }

        // 2) Disk-only / orphan job (app restarted, hot-reload, or worker already exited).
        //    Mark cancelled on disk so UI does not keep showing a zombie "running" task.
        let dir = self.cfg.jobs_dir().join(job_id);
        if !dir.is_dir() {
            return Err(AppError::not_found(format!(
                "任务不存在: {job_id}（内存与磁盘均无记录）"
            )));
        }
        let mut m = JobManifest::load(&dir)?;
        if matches!(
            m.state,
            JobState::Completed | JobState::Failed | JobState::Cancelled
        ) {
            return Ok(());
        }
        m.state = JobState::Cancelled;
        m.error = Some(AppError::cancelled().with_detail(
            "任务进程已不在内存中（应用可能已重启）。已标记为取消，无法再中止已退出的引擎。",
        ));
        m.stats.finished_at = Some(chrono::Utc::now());
        m.save()?;
        info!(job = %job_id, "orphan job marked cancelled on disk");
        Ok(())
    }

    pub async fn get_job(&self, job_id: &str) -> AppResult<JobStatus> {
        validate_job_id(job_id)?;
        let live = {
            let jobs = self.jobs.read().await;
            jobs.get(job_id).map(|l| l.manifest.clone())
        };
        if let Some(manifest) = live {
            let mut m = manifest.write().await;
            if crate::job::heal_if_output_ready(&mut m) {
                let _ = m.save();
            }
            return Ok(m.to_status());
        }
        let dir = self.cfg.jobs_dir().join(job_id);
        let cache = self.disk_status_cache.clone();
        tokio::task::spawn_blocking(move || load_disk_job_status(&dir, &cache))
            .await
            .map_err(|e| AppError::internal(format!("get_job join: {e}")))?
    }

    pub async fn list_jobs(&self) -> AppResult<Vec<JobStatus>> {
        let (lives, live_ids) = {
            let map = self.jobs.read().await;
            let lives: Vec<Arc<RwLock<JobManifest>>> =
                map.values().map(|l| l.manifest.clone()).collect();
            let ids: HashSet<String> = map.keys().cloned().collect();
            (lives, ids)
        };
        let mut out = Vec::new();
        for manifest in lives {
            let mut m = manifest.write().await;
            if crate::job::heal_if_output_ready(&mut m) {
                let _ = m.save();
            }
            out.push(m.to_status());
        }
        let jobs_dir = self.cfg.jobs_dir();
        let cache = self.disk_status_cache.clone();
        let disk = tokio::task::spawn_blocking(move || {
            load_orphan_job_statuses(&jobs_dir, &live_ids, &cache)
        })
        .await
        .map_err(|e| AppError::internal(format!("list_jobs join: {e}")))?;
        out.extend(disk);
        out.sort_by(|a, b| b.job_id.cmp(&a.job_id));
        Ok(out)
    }

    /// Remove one job directory (and drop from memory if present).
    /// Active live jobs are cancelled first and awaited before the directory is
    /// removed — otherwise the worker's final manifest save recreates the folder
    /// and the job "resurrects" in list_jobs.
    pub async fn remove_job(&self, job_id: &str) -> AppResult<()> {
        validate_job_id(job_id)?;
        let live = self.jobs.write().await.remove(job_id);
        if let Some(live) = live {
            live.cancel.cancel();
            live.active.store(false, Ordering::Release);
            match wait_for_worker_handle(&live, Duration::from_secs(15)).await {
                Some(handle) => {
                    if tokio::time::timeout(Duration::from_secs(15), handle)
                        .await
                        .is_err()
                    {
                        // 超时：worker 可能卡在 sidecar 上。置放弃标志，其后续
                        // manifest.save() 全部跳过，防止目录复活。
                        warn!(job = %job_id, "remove_job: worker 未在 15s 内退出，已置放弃标志");
                        live.abandoned.store(true, Ordering::Release);
                    }
                }
                None => {
                    warn!(job = %job_id, "remove_job: worker handle 未就绪");
                    live.abandoned.store(true, Ordering::Release);
                }
            }
        }
        let dir = self.cfg.jobs_dir().join(job_id);
        if dir.is_dir() {
            // 数 GB 目录删除放 blocking 线程，避免卡 tokio worker
            let dir2 = dir.clone();
            tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&dir2))
                .await
                .map_err(|e| AppError::internal(format!("删除任务目录 join: {e}")))?
                .map_err(|e| {
                    AppError::internal(format!("删除任务目录失败: {}: {e}", dir.display()))
                })?;
            info!(job = %job_id, "job directory removed");
        }
        if let Ok(mut cache) = self.disk_status_cache.lock() {
            cache.remove(job_id);
        }
        Ok(())
    }

    /// Delete finished jobs: completed / failed / cancelled (and disk orphans).
    /// Does **not** touch live active workers.
    /// Returns number of job folders removed.
    pub async fn clear_finished_jobs(&self) -> AppResult<u32> {
        let _gc = self.gc.lock().await;

        {
            let mut map = self.jobs.write().await;
            let mut drop_ids = Vec::new();
            for (id, live) in map.iter() {
                if live.active.load(Ordering::Acquire) {
                    continue;
                }
                let state = live.manifest.read().await.state;
                if !is_active_state(state) {
                    drop_ids.push(id.clone());
                }
            }
            for id in drop_ids {
                let still_live = match map.get(&id) {
                    Some(live) if live.active.load(Ordering::Acquire) => true,
                    Some(live) => is_active_state(live.manifest.read().await.state),
                    None => false,
                };
                if !still_live {
                    map.remove(&id);
                }
            }
        }

        let protect: HashSet<String> = {
            let map = self.jobs.read().await;
            let mut set = HashSet::new();
            for (id, live) in map.iter() {
                if live.active.load(Ordering::Acquire) {
                    set.insert(id.clone());
                    continue;
                }
                let state = live.manifest.read().await.state;
                if is_active_state(state) {
                    set.insert(id.clone());
                }
            }
            set
        };

        let jobs_dir = self.cfg.jobs_dir();
        let mut dirs: Vec<(String, PathBuf)> = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&jobs_dir) {
            for e in rd.flatten() {
                let id = e.file_name().to_string_lossy().to_string();
                let path = e.path();
                if protect.contains(&id) || !path.is_dir() {
                    continue;
                }
                dirs.push((id, path));
            }
        }
        let cache = self.disk_status_cache.clone();
        let removed = tokio::task::spawn_blocking(move || {
            let mut n = 0u32;
            for (id, path) in dirs {
                match std::fs::remove_dir_all(&path) {
                    Ok(()) => {
                        n += 1;
                        if let Ok(mut c) = cache.lock() {
                            c.remove(&id);
                        }
                        info!(job = %id, "cleared finished/orphan job");
                    }
                    Err(err) => {
                        warn!(job = %id, error = %err, "failed to remove job dir");
                    }
                }
            }
            n
        })
        .await
        .map_err(|e| AppError::internal(format!("清理任务目录 join: {e}")))?;
        Ok(removed)
    }

    pub async fn validate_source_path(
        &self,
        path: &str,
    ) -> AppResult<crate::archive::ValidateResult> {
        let pathb = PathBuf::from(path);
        let _gate = self.validate_gate.lock().await;
        if let Some(hit) = self.cached_validation(&pathb) {
            return Ok(hit);
        }
        let cfg = self.cfg.clone();
        let path_for_task = pathb.clone();
        let result = tokio::task::spawn_blocking(move || {
            crate::archive::validate_source(&path_for_task, &cfg)
        })
        .await
        .map_err(|e| AppError::internal(format!("校验源 join: {e}")))??;
        self.store_validation(&pathb, &result);
        Ok(result)
    }

    fn cached_validation(&self, path: &Path) -> Option<crate::archive::ValidateResult> {
        let (mtime_nanos, len) = source_stamp(path)?;
        let guard = self
            .source_validation
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let cached = guard.as_ref()?;
        if cached.path == path && cached.mtime_nanos == mtime_nanos && cached.len == len {
            Some(cached.result.clone())
        } else {
            None
        }
    }

    fn store_validation(&self, path: &Path, result: &crate::archive::ValidateResult) {
        let Some((mtime_nanos, len)) = source_stamp(path) else {
            return;
        };
        let mut guard = self
            .source_validation
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *guard = Some(CachedValidation {
            path: path.to_path_buf(),
            mtime_nanos,
            len,
            result: result.clone(),
        });
    }

    pub async fn estimate(
        &self,
        path: &str,
        params: crate::estimate::EstimateParams,
        output_dir: Option<&Path>,
    ) -> AppResult<crate::estimate::DiskEstimate> {
        let validated = self.validate_source_path(path).await?;
        let cfg = self.cfg.clone();
        let source = PathBuf::from(path);
        let output = output_dir.map(Path::to_path_buf);
        tokio::task::spawn_blocking(move || {
            crate::estimate::estimate_validated(
                &source,
                params,
                &cfg,
                output.as_deref(),
                &validated,
            )
        })
        .await
        .map_err(|e| AppError::internal(format!("磁盘估算 join: {e}")))
    }

    pub async fn preview_page(
        &self,
        source: &str,
        page_index: u32,
        options: Option<crate::preview::EnhanceOptionsDto>,
    ) -> AppResult<crate::preview::PreviewResult> {
        let kind = crate::job::parse_engine_kind(
            options
                .as_ref()
                .and_then(|o| o.engine.as_deref())
                .unwrap_or("realcugan-coreml"),
        )?;
        let engine = self.pick_engine(kind)?;
        crate::preview::preview_page(
            PathBuf::from(source).as_path(),
            page_index,
            options,
            engine,
            self.gpu.clone(),
            &self.cfg,
        )
        .await
    }

    pub async fn doctor(&self) -> AppResult<crate::diagnostics::DoctorReport> {
        crate::diagnostics::collect_doctor(&self.cfg, self.engine()).await
    }

    pub async fn export_diagnostics(&self, out_dir: Option<PathBuf>) -> AppResult<PathBuf> {
        crate::diagnostics::export_diagnostics_zip(&self.cfg, self.engine(), out_dir.as_deref())
            .await
    }

    pub async fn get_reader_state(
        &self,
        job_id: Option<&str>,
        source: Option<&str>,
    ) -> AppResult<crate::reader::ReaderState> {
        if let Some(id) = job_id.filter(|s| !s.is_empty()) {
            let m = self.load_manifest_clone(id).await?;
            let mut state = crate::reader::state_from_manifest(&m);
            if state.pages.is_empty() {
                if let Ok(from_src) = crate::reader::state_from_source(&m.source.path, &self.cfg) {
                    state.page_count = from_src.page_count;
                    state.pages = from_src.pages;
                }
            }
            return Ok(state);
        }
        let source = source
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::invalid("需要 jobId 或 source"))?;
        if let Some(id) = self.find_job_id_for_source(source).await {
            let m = self.load_manifest_clone(&id).await?;
            let mut state = crate::reader::state_from_manifest(&m);
            if state.pages.is_empty() {
                if let Ok(from_src) = crate::reader::state_from_source(&m.source.path, &self.cfg) {
                    state.page_count = from_src.page_count;
                    state.pages = from_src.pages;
                }
            }
            return Ok(state);
        }
        crate::reader::state_from_source(PathBuf::from(source).as_path(), &self.cfg)
    }

    pub async fn enhance_reader_pages(
        &self,
        source: Option<&str>,
        job_id: Option<&str>,
        page_indexes: &[u32],
        options: Option<crate::preview::EnhanceOptionsDto>,
    ) -> AppResult<Vec<crate::reader::ReaderPageFile>> {
        let src = self.resolve_reader_source(job_id, source).await?;
        let requested_engine = options.as_ref().and_then(|o| o.engine.as_deref());
        let kind = crate::job::parse_engine_kind(requested_engine.unwrap_or("realcugan-coreml"))?;
        // 阅读器引擎来自用户持久化偏好，视为显式点名
        self.ensure_engine_ready(kind, requested_engine.is_some())?;
        let engine = self.pick_engine(kind)?;
        let cancel = CancellationToken::new();
        let id = self
            .reader_enhance_cancel_seq
            .fetch_add(1, Ordering::Relaxed);
        let cache_key = crate::reader::source_cache_key(src.as_path());
        {
            let mut slots = self
                .reader_enhance_cancels
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            slots.push((id, cache_key, cancel.clone()));
        }
        let _unreg = UnregisterReaderCancel {
            slots: self.reader_enhance_cancels.clone(),
            id,
        };
        crate::reader_enhance::enhance_pages(
            src.as_path(),
            page_indexes,
            options,
            engine,
            self.gpu.clone(),
            &self.cfg,
            cancel,
        )
        .await
    }

    pub fn cancel_reader_enhance(&self) {
        let mut slots = self
            .reader_enhance_cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for (_, _, token) in slots.drain(..) {
            token.cancel();
        }
    }

    /// 只取消这一本书的在途增强。槽位留给任务自己的 Drop 摘掉，
    /// 避免把别的书的取消令牌一起排空。
    fn cancel_reader_enhance_keys(&self, keys: &[String]) {
        let want: HashSet<&str> = keys.iter().map(String::as_str).collect();
        let slots = self
            .reader_enhance_cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for (_, key, token) in slots.iter() {
            if want.contains(key.as_str()) {
                token.cancel();
            }
        }
    }

    /// 先挡住新的增强，再取消已在跑的，然后等计数归零。
    /// 守卫要一直拿到删除结束：提前丢掉的话，新任务会在删除过程中写回目录。
    async fn pause_reader_enhance(
        &self,
        keys: Option<&[String]>,
    ) -> AppResult<crate::reader_enhance::EnhanceClearGuard> {
        let guard = match keys {
            Some(keys) => crate::reader_enhance::begin_clear_keys(keys),
            None => crate::reader_enhance::begin_clear_all(),
        };
        match keys {
            Some(keys) => self.cancel_reader_enhance_keys(keys),
            None => self.cancel_reader_enhance(),
        }
        if !crate::reader_enhance::wait_paused(&guard, Duration::from_secs(10)).await {
            return Err(AppError::invalid("阅读增强仍在进行，请稍后再清理"));
        }
        Ok(guard)
    }

    pub fn lookup_reader_enhance_pages(
        &self,
        source: Option<&str>,
        _job_id: Option<&str>,
        page_indexes: &[u32],
        options: Option<crate::preview::EnhanceOptionsDto>,
    ) -> AppResult<Vec<crate::reader::ReaderPageFile>> {
        let src = if let Some(s) = source.filter(|s| !s.is_empty()) {
            PathBuf::from(s)
        } else {
            return Err(AppError::invalid("需要 source"));
        };
        crate::reader_enhance::lookup_pages(src.as_path(), page_indexes, options, &self.cfg)
    }

    pub fn reader_enhance_cache_stats(&self) -> crate::reader_enhance::EnhanceCacheStats {
        crate::reader_enhance::cache_stats(&self.cfg)
    }

    pub async fn clear_reader_enhance_cache(
        &self,
    ) -> AppResult<crate::reader_enhance::EnhanceCacheClearResult> {
        let _guard = self.pause_reader_enhance(None).await?;
        let cfg = self.cfg.clone();
        tokio::task::spawn_blocking(move || crate::reader_enhance::clear_cache(&cfg))
            .await
            .map_err(|e| AppError::internal(format!("清理增强缓存 join: {e}")))?
    }

    /// 缓存清单的**运行态快照** —— 磁盘上看不到、只有调度器知道的那部分：
    /// 哪些任务还活着（不能删目录）、书库正在引用哪些封面（不能删文件）。
    async fn cache_context(&self) -> crate::cache::CacheContext {
        let protected_jobs: HashSet<String> = {
            let map = self.jobs.read().await;
            let mut set = HashSet::new();
            for (id, live) in map.iter() {
                if live.active.load(Ordering::Acquire) {
                    set.insert(id.clone());
                    continue;
                }
                // 与 clear_finished_jobs 的保护集保持**完全一致**，
                // 否则页面上承诺"可回收 X"而实际清不掉，或反过来删了在跑的。
                if is_active_state(live.manifest.read().await.state) {
                    set.insert(id.clone());
                }
            }
            set
        };
        let referenced_covers = match self.library.lock() {
            Ok(g) => g.referenced_cover_names(),
            Err(_) => HashSet::new(),
        };
        crate::cache::CacheContext {
            protected_jobs,
            referenced_covers,
        }
    }

    /// 缓存总览。全树递归遍历很贵，必须放 blocking 线程。
    pub async fn cache_overview(&self) -> AppResult<crate::cache::CacheOverview> {
        let ctx = self.cache_context().await;
        let cfg = self.cfg.clone();
        tokio::task::spawn_blocking(move || crate::cache::collect_overview(&cfg, &ctx))
            .await
            .map_err(|e| AppError::internal(format!("缓存统计 join: {e}")))
    }

    /// 清理一个缓存组。每个组的"在途保护"不一样，这里逐个分派。
    pub async fn clear_cache_group(
        &self,
        id: crate::cache::CacheGroupId,
    ) -> AppResult<crate::cache::CacheClearResult> {
        use crate::cache::CacheGroupId as G;

        // jobs 必须走 clear_finished_jobs：它有 gc 锁、活跃保护、以及
        // "置 abandoned 标志防目录复活"这一整套。绝不在这里自己 remove_dir_all。
        if id == G::Jobs {
            let jobs_dir = self.cfg.jobs_dir();
            let before = dir_total_bytes(&jobs_dir);
            let removed = self.clear_finished_jobs().await?;
            let after = dir_total_bytes(&jobs_dir);
            return Ok(crate::cache::CacheClearResult {
                removed,
                bytes_freed: before.saturating_sub(after),
            });
        }

        let _enhance = if id == G::ReaderEnhance {
            Some(self.pause_reader_enhance(None).await?)
        } else {
            None
        };
        let ctx = self.cache_context().await;
        let cfg = self.cfg.clone();
        let gate_reads = id == G::Reader || id == G::Mobi;
        let lock_mobi = id == G::Mobi;
        blocking_cache_op(gate_reads, lock_mobi, move || {
            crate::cache::clear_group(&cfg, id, &ctx)
        })
        .await
    }

    /// 书库侧快照，供缓存页把磁盘目录归属回书名。
    ///
    /// 这里只取 id / path / title / job_id —— 哈希**重算**留给
    /// `cache.rs::BookIndex`，好让它与生产函数（`source_cache_key`、
    /// `mobi_cache_key_prefix`）共用同一份实现，避免出现第二套密钥算法。
    fn cache_book_refs(&self) -> Vec<crate::cache::CacheBookRef> {
        let Ok(lib) = self.library.lock() else {
            // 锁中毒时给空表：缓存页会退化成"全是未知目录"，但至少还能清，
            // 比整个命令失败强。
            return Vec::new();
        };
        lib.entries()
            .iter()
            .map(|e| crate::cache::CacheBookRef {
                id: e.id.clone(),
                path: e.path.clone(),
                title: e.title.clone(),
                job_id: e.job_id.clone(),
                source_missing: !std::path::Path::new(&e.path).exists(),
            })
            .collect()
    }

    /// 按漫画列出一个分组的占用明细。全树递归遍历，必须放 blocking 线程。
    pub async fn cache_group_entries(
        &self,
        id: crate::cache::CacheGroupId,
    ) -> AppResult<Vec<crate::cache::CacheEntry>> {
        let ctx = self.cache_context().await;
        let books = self.cache_book_refs();
        let cfg = self.cfg.clone();
        tokio::task::spawn_blocking(move || {
            crate::cache::collect_group_entries(&cfg, id, &ctx, &books)
        })
        .await
        .map_err(|e| AppError::internal(format!("缓存明细 join: {e}")))
    }

    /// 清掉**单本**缓存。
    ///
    /// 在途保护的时序与整组清理**完全一致**：单本不等于可以少一层保护 ——
    /// 正在写的那一页一样会写进一个已删除的目录，结果就是阅读器报错。
    pub async fn clear_cache_entry(
        &self,
        id: crate::cache::CacheGroupId,
        key: String,
    ) -> AppResult<crate::cache::CacheClearResult> {
        use crate::cache::CacheGroupId as G;

        if id == G::Jobs {
            // 在途任务**不从缓存页删**：那实质是"取消任务"，和"清缓存"是两件事，
            // 应该在队列面板里做（那里有明确的取消语义）。这里只清已结束的。
            if self.cache_context().await.protected_jobs.contains(&key) {
                return Err(AppError::invalid("任务正在进行中，请先在队列里取消"));
            }
            let dir = self.cfg.jobs_dir().join(&key);
            let before = dir_total_bytes(&dir);
            // 仍走 remove_job：它带 uuid 格式校验 + 防目录复活
            self.remove_job(&key).await?;
            let after = dir_total_bytes(&dir);
            return Ok(crate::cache::CacheClearResult {
                removed: u32::from(before != after || !dir.exists()),
                bytes_freed: before.saturating_sub(after),
            });
        }
        let _enhance = if id == G::ReaderEnhance {
            Some(
                self.pause_reader_enhance(Some(std::slice::from_ref(&key)))
                    .await?,
            )
        } else {
            None
        };
        let ctx = self.cache_context().await;
        let cfg = self.cfg.clone();
        let gate_reads = id == G::Reader || id == G::Mobi;
        let lock_mobi = id == G::Mobi;
        blocking_cache_op(gate_reads, lock_mobi, move || {
            crate::cache::clear_entry(&cfg, id, &key, &ctx)
        })
        .await
    }

    /// 缓存页**主视图**：一行 = 一本漫画占用的全部缓存（跨 5 类）。
    /// 全树递归遍历，必须放 blocking 线程。
    pub async fn cache_book_entries(&self) -> AppResult<Vec<crate::cache::BookCacheEntry>> {
        let ctx = self.cache_context().await;
        let books = self.cache_book_refs();
        let cfg = self.cfg.clone();
        tokio::task::spawn_blocking(move || crate::cache::collect_book_entries(&cfg, &ctx, &books))
            .await
            .map_err(|e| AppError::internal(format!("按书缓存明细 join: {e}")))
    }

    /// 清掉**一本书的全部类型缓存**。
    ///
    /// 与 `clear_cache_entry` 的关系：**不是**简单循环 —— 在途保护只做一遍。
    /// 一本漫画可能同时有 reader-enhance 和 reader 两类缓存，逐个做一遍
    /// 取消+等待会把 10s + 5s 的等待累加成 N 倍。先归并出要碰的组，再统一等一次。
    ///
    /// 安全语义与单清完全一致：封面仍只清孤儿、在途任务仍拒绝。
    pub async fn clear_book_cache(
        &self,
        parts: Vec<crate::cache::CachePartRef>,
    ) -> AppResult<crate::cache::CacheClearResult> {
        use crate::cache::CacheGroupId as G;

        let mut groups: Vec<G> = parts.iter().map(|p| p.group).collect();
        groups.sort_by_key(|g| g.as_str());
        groups.dedup();

        // 在途任务先拦下来：那实质是"取消任务"，该在队列面板里做。
        // 拦在**动任何磁盘内容之前** —— 否则会出现"清了半本、然后报错"。
        if groups.contains(&G::Jobs) {
            let ctx = self.cache_context().await;
            if parts
                .iter()
                .any(|p| p.group == G::Jobs && ctx.protected_jobs.contains(&p.key))
            {
                return Err(AppError::invalid("任务正在进行中，请先在队列里取消"));
            }
        }

        let enhance_keys: Vec<String> = parts
            .iter()
            .filter(|p| p.group == G::ReaderEnhance)
            .map(|p| p.key.clone())
            .collect();
        let _enhance = if enhance_keys.is_empty() {
            None
        } else {
            Some(self.pause_reader_enhance(Some(&enhance_keys)).await?)
        };

        let ctx = self.cache_context().await;
        let cfg = self.cfg.clone();
        let disk: Vec<(G, String)> = parts
            .iter()
            .filter(|p| p.group != G::Jobs)
            .map(|p| (p.group, p.key.clone()))
            .collect();

        let gate_reads = groups.contains(&G::Reader) || groups.contains(&G::Mobi);
        let lock_mobi = groups.contains(&G::Mobi);
        // 磁盘上的四类：一趟清掉。读页写锁和 mobi 构建锁盖住整个删除，
        // 避免等完之后又有新的读页写进正在删的目录。
        let mut total = blocking_cache_op(gate_reads, lock_mobi, move || {
            let mut acc = crate::cache::CacheClearResult {
                removed: 0,
                bytes_freed: 0,
            };
            for (group, key) in disk {
                let r = crate::cache::clear_entry(&cfg, group, &key, &ctx)?;
                acc.removed += r.removed;
                acc.bytes_freed = acc.bytes_freed.saturating_add(r.bytes_freed);
            }
            Ok(acc)
        })
        .await?;

        // 任务目录单独走 remove_job：它带 uuid 格式校验 + 防目录复活
        for p in parts.iter().filter(|p| p.group == G::Jobs) {
            let dir = self.cfg.jobs_dir().join(&p.key);
            let before = dir_total_bytes(&dir);
            self.remove_job(&p.key).await?;
            let after = dir_total_bytes(&dir);
            total.removed += u32::from(before != after || !dir.exists());
            total.bytes_freed = total
                .bytes_freed
                .saturating_add(before.saturating_sub(after));
        }
        Ok(total)
    }

    async fn resolve_reader_source(
        &self,
        job_id: Option<&str>,
        source: Option<&str>,
    ) -> AppResult<PathBuf> {
        if let Some(s) = source.filter(|s| !s.is_empty()) {
            return Ok(PathBuf::from(s));
        }
        if let Some(id) = job_id.filter(|s| !s.is_empty()) {
            let m = self.load_manifest_clone(id).await?;
            return Ok(m.source.path);
        }
        Err(AppError::invalid("需要 jobId 或 source"))
    }

    pub async fn prepare_reader_page(
        &self,
        job_id: Option<&str>,
        source: Option<&str>,
        page_index: u32,
    ) -> AppResult<crate::reader::ReaderPageFile> {
        let mut pages = self
            .prepare_reader_pages(job_id, source, &[page_index], false)
            .await?;
        pages
            .pop()
            .ok_or_else(|| AppError::internal("未返回页文件"))
    }

    pub async fn prepare_reader_pages(
        &self,
        job_id: Option<&str>,
        source: Option<&str>,
        page_indexes: &[u32],
        prefer_original: bool,
    ) -> AppResult<Vec<crate::reader::ReaderPageFile>> {
        // 在读页期间挂"在途"标记：清空整本缓存时会等它归零，
        // 免得把正在写盘的那一页写进已被删除的目录。
        let _inflight = crate::reader::ReaderInflightGuard::enter().await;
        let cfg = self.cfg.clone();
        let indexes = page_indexes.to_vec();
        if prefer_original {
            let src = self.resolve_reader_source(job_id, source).await?;
            return tokio::task::spawn_blocking(move || {
                crate::reader::resolve_original_pages(src.as_path(), &indexes, &cfg)
            })
            .await
            .map_err(|e| AppError::internal(format!("reader join: {e}")))?;
        }
        if let Some(id) = job_id.filter(|s| !s.is_empty()) {
            let m = self.load_manifest_clone(id).await?;
            return tokio::task::spawn_blocking(move || {
                crate::reader::resolve_pages(Some(&m), None, &indexes, &cfg)
            })
            .await
            .map_err(|e| AppError::internal(format!("reader join: {e}")))?;
        }
        let source = source
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::invalid("需要 jobId 或 source"))?;
        if let Some(id) = self.find_live_job_id_for_source(source).await {
            let m = self.load_manifest_clone(&id).await?;
            return tokio::task::spawn_blocking(move || {
                crate::reader::resolve_pages(Some(&m), None, &indexes, &cfg)
            })
            .await
            .map_err(|e| AppError::internal(format!("reader join: {e}")))?;
        }
        let src = PathBuf::from(source);
        tokio::task::spawn_blocking(move || {
            crate::reader::resolve_pages(None, Some(src.as_path()), &indexes, &cfg)
        })
        .await
        .map_err(|e| AppError::internal(format!("reader join: {e}")))?
    }

    async fn load_manifest_clone(&self, job_id: &str) -> AppResult<JobManifest> {
        validate_job_id(job_id)?;
        if let Some(live) = self.jobs.read().await.get(job_id) {
            return Ok(live.manifest.read().await.clone());
        }
        JobManifest::load(&self.cfg.jobs_dir().join(job_id))
    }

    async fn find_live_job_id_for_source(&self, source: &str) -> Option<String> {
        let src = PathBuf::from(source);
        let map = self.jobs.read().await;
        for (id, live) in map.iter() {
            let m = live.manifest.read().await;
            if m.source.path == src {
                return Some(id.clone());
            }
        }
        None
    }

    async fn find_job_id_for_source(&self, source: &str) -> Option<String> {
        if let Some(id) = self.find_live_job_id_for_source(source).await {
            return Some(id);
        }
        let jobs = self.list_jobs().await.ok()?;
        let src = PathBuf::from(source);
        jobs.into_iter()
            .find(|j| Path::new(&j.source) == src.as_path() || j.source == source)
            .map(|j| j.job_id)
    }

    pub fn list_library(&self) -> AppResult<crate::library::LibraryIndex> {
        let mut lib = self
            .library
            .lock()
            .map_err(|_| AppError::internal("书库锁失败"))?;
        lib.refresh_covers(&self.cfg);
        Ok(lib.list_index())
    }

    pub fn create_library_collection(
        &self,
        title: &str,
        entry_ids: &[String],
    ) -> AppResult<crate::library::LibraryCollection> {
        let mut lib = self
            .library
            .lock()
            .map_err(|_| AppError::internal("书库锁失败"))?;
        lib.create_collection(title, entry_ids)
    }

    pub fn add_library_collection_entries(&self, id: &str, entry_ids: &[String]) -> AppResult<()> {
        let mut lib = self
            .library
            .lock()
            .map_err(|_| AppError::internal("书库锁失败"))?;
        lib.add_to_collection(id, entry_ids)
    }

    pub fn remove_library_collection_entry(&self, id: &str, entry_id: &str) -> AppResult<()> {
        let mut lib = self
            .library
            .lock()
            .map_err(|_| AppError::internal("书库锁失败"))?;
        lib.remove_from_collection(id, entry_id)
    }

    pub fn move_library_collection_entry(
        &self,
        id: &str,
        entry_id: &str,
        delta: i32,
    ) -> AppResult<()> {
        let mut lib = self
            .library
            .lock()
            .map_err(|_| AppError::internal("书库锁失败"))?;
        lib.move_in_collection(id, entry_id, delta)
    }

    pub fn rename_library_collection(&self, id: &str, title: &str) -> AppResult<()> {
        let mut lib = self
            .library
            .lock()
            .map_err(|_| AppError::internal("书库锁失败"))?;
        lib.rename_collection(id, title)
    }

    pub fn dissolve_library_collection(&self, id: &str) -> AppResult<()> {
        let mut lib = self
            .library
            .lock()
            .map_err(|_| AppError::internal("书库锁失败"))?;
        lib.dissolve_collection(id)
    }

    pub fn add_library_path(&self, path: &str) -> AppResult<crate::library::LibraryEntry> {
        let mut lib = self
            .library
            .lock()
            .map_err(|_| AppError::internal("书库锁失败"))?;
        lib.upsert_path(PathBuf::from(path).as_path(), &self.cfg)
    }

    pub fn remove_library_entry(&self, id: &str) -> AppResult<()> {
        let mut lib = self
            .library
            .lock()
            .map_err(|_| AppError::internal("书库锁失败"))?;
        if lib.remove(id)? {
            Ok(())
        } else {
            Err(AppError::not_found("书库中没有这条记录"))
        }
    }

    pub fn preview_library_scan(
        &self,
        root: &str,
    ) -> AppResult<crate::library::LibraryScanPreview> {
        let lib = self
            .library
            .lock()
            .map_err(|_| AppError::internal("书库锁失败"))?;
        lib.preview_scan(PathBuf::from(root).as_path())
    }

    pub fn import_library_paths(
        &self,
        paths: &[String],
    ) -> AppResult<crate::library::LibraryScanResult> {
        let mut lib = self
            .library
            .lock()
            .map_err(|_| AppError::internal("书库锁失败"))?;
        let bufs: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
        lib.import_paths(&bufs, &self.cfg)
    }

    pub fn touch_library(&self, path: &str, page: Option<u32>) -> AppResult<()> {
        let mut lib = self
            .library
            .lock()
            .map_err(|_| AppError::internal("书库锁失败"))?;
        lib.touch(PathBuf::from(path).as_path(), page)
    }

    pub fn gpu_lock(&self) -> GpuLock {
        self.gpu.clone()
    }

    pub fn ensure_engine_ready(&self, kind: EngineKind, explicit: bool) -> AppResult<()> {
        if self.cfg.use_mock_engine && self.override_engine.is_none() {
            return Ok(());
        }
        let e = self.pick_engine(kind)?;
        // 静默回退到 mock（最近邻放大）会让用户拿到「假超分」。显式点名的引擎
        // 直接拒绝；仅 auto/未指定可在开发与 CLI 环境回退（desktop release 已
        // 关 allow_mock_fallback）。
        if e.status().id == "mock" && !self.cfg.use_mock_engine {
            if explicit {
                return Err(AppError::new(
                    crate::error::ErrorCode::BinaryIntegrity,
                    format!(
                        "请求的引擎不可用，已阻止降级为模拟引擎（最近邻放大）: {kind:?}。\
                         请安装对应引擎后重试"
                    ),
                ));
            }
            warn!("请求的引擎 {kind:?} 不可用，回退到模拟引擎（最近邻放大，非真实超分）");
        }
        match e.is_available() {
            comic_engines::EngineAvailability::Ready => Ok(()),
            comic_engines::EngineAvailability::MissingBinary => Err(AppError::new(
                crate::error::ErrorCode::BinaryIntegrity,
                match kind {
                    EngineKind::RealCugan => "未找到 Real-CUGAN，请运行 scripts/fetch-realcugan.sh",
                    EngineKind::Waifu2xCoreMl => {
                        "未找到 Waifu2x Core ML 模型，请运行 scripts/fetch-waifu2x-coreml.sh"
                    }
                    EngineKind::RealEsrganCoreMl => {
                        "未找到 Real-ESRGAN Core ML 模型，请运行 scripts/fetch-realesrgan-coreml.sh"
                    }
                    EngineKind::RealCuganCoreMl => {
                        "未找到 Real-CUGAN Core ML 模型，请运行 scripts/fetch-realcugan-coreml.sh"
                    }
                    EngineKind::AnimeVideoCoreMl => {
                        "未找到 AnimeVideo Core ML 模型，请运行 scripts/fetch-animevideo-coreml.sh"
                    }
                    _ => "未找到 Waifu2x 引擎，请重新安装应用或运行 scripts/fetch-waifu2x.sh",
                },
            )),
            comic_engines::EngineAvailability::ChecksumMismatch => Err(AppError::new(
                crate::error::ErrorCode::BinaryIntegrity,
                "引擎损坏或校验失败，请重新下载对应 sidecar",
            )),
            comic_engines::EngineAvailability::Unavailable(s) => Err(AppError::new(
                crate::error::ErrorCode::BinaryIntegrity,
                format!("引擎不可用: {s}"),
            )),
        }
    }

    async fn live_job_for_source(&self, source: &std::path::Path) -> Option<String> {
        let want = source_key(source);
        self.live_active_id_for_source(&want).await
    }

    async fn live_active_id_for_source(&self, want: &str) -> Option<String> {
        let map = self.jobs.read().await;
        for (id, live) in map.iter() {
            if live.active.load(Ordering::Acquire) && source_key(&live.source) == want {
                return Some(id.clone());
            }
        }
        None
    }
}

fn source_key(p: &std::path::Path) -> String {
    std::fs::canonicalize(p)
        .unwrap_or_else(|_| p.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn find_resume_in_dir(jobs_dir: &Path, source: &Path) -> Option<ResumeHint> {
    let want = source_key(source);
    let mut best: Option<ResumeHint> = None;
    let rd = std::fs::read_dir(jobs_dir).ok()?;
    for e in rd.flatten() {
        let Ok(mut m) = JobManifest::load(&e.path()) else {
            continue;
        };
        if source_key(&m.source.path) != want {
            continue;
        }
        if matches!(m.state, JobState::Completed) {
            continue;
        }
        remap_done_from_disk(&mut m);
        let done = m.stats.pages_done;
        let total = m.stats.pages_total.max(m.pages.len() as u32);
        if total == 0 && done == 0 && m.pages.is_empty() && !m.in_dir().is_dir() {
            continue;
        }
        if done >= total && total > 0 {
            continue;
        }
        best = Some(ResumeHint::from_counts(
            m.job_id.clone(),
            m.source.path.display().to_string(),
            done,
            total,
        ));
    }
    best
}

fn manifest_stat(dir: &Path) -> Option<(u128, u64)> {
    let meta = JobManifest::manifest_path(dir).metadata().ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((mtime, meta.len()))
}

fn remember_disk_status(
    cache: &StdMutex<HashMap<String, CachedDiskStatus>>,
    id: &str,
    mtime_nanos: u128,
    len: u64,
    status: &JobStatus,
) {
    if is_active_state(status.state) {
        return;
    }
    if let Ok(mut g) = cache.lock() {
        g.insert(
            id.to_string(),
            CachedDiskStatus {
                mtime_nanos,
                len,
                status: status.clone(),
            },
        );
    }
}

fn load_disk_job_status(
    dir: &Path,
    cache: &StdMutex<HashMap<String, CachedDiskStatus>>,
) -> AppResult<JobStatus> {
    // ⚠️ 缓存键必须与 `remember_disk_status` 的写入键**同一个**取值来源。
    // 这里读的是目录名，写入侧原先用的是 manifest 里的 `status.job_id` ——
    // 两者一旦不一致（目录被改名、manifest 由别处复制而来），缓存就永远不命中；
    // 更糟的是两个目录若声明了同一个 job_id，第二个目录会读到第一个的状态。
    let id = dir
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if id.is_empty() {
        // 拿不到稳定键就不走缓存，避免所有异常目录挤在同一个 "" 键上互相污染。
        let mut m = JobManifest::load(dir)?;
        if crate::job::heal_if_output_ready(&mut m) || heal_orphan_active_job(&mut m) {
            let _ = m.save();
        }
        return Ok(m.to_status());
    }
    if let Some((mtime, len)) = manifest_stat(dir) {
        if let Ok(g) = cache.lock() {
            if let Some(hit) = g.get(&id) {
                if hit.mtime_nanos == mtime && hit.len == len {
                    return Ok(hit.status.clone());
                }
            }
        }
    }
    let mut m = JobManifest::load(dir)?;
    if crate::job::heal_if_output_ready(&mut m) || heal_orphan_active_job(&mut m) {
        let _ = m.save();
    }
    let status = m.to_status();
    if let Some((mtime, len)) = manifest_stat(dir) {
        remember_disk_status(cache, &id, mtime, len, &status);
    }
    Ok(status)
}

fn load_orphan_job_statuses(
    jobs_dir: &Path,
    live_ids: &HashSet<String>,
    cache: &StdMutex<HashMap<String, CachedDiskStatus>>,
) -> Vec<JobStatus> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(jobs_dir) else {
        return out;
    };
    for e in rd.flatten() {
        let id = e.file_name().to_string_lossy().to_string();
        let path = e.path();
        if live_ids.contains(&id) || !path.is_dir() {
            continue;
        }
        if let Ok(status) = load_disk_job_status(&path, cache) {
            out.push(status);
        }
    }
    out
}

fn remap_done_from_disk(m: &mut JobManifest) {
    if m.pages.is_empty() {
        crate::pipeline::recover_pages_from_indir(m);
    }
    for page in &mut m.pages {
        if page.out_path.as_ref().map(|p| p.is_file()).unwrap_or(false) {
            page.status = crate::job::PageStatus::Done;
        }
    }
    m.refresh_stats();
}

/// job_id 一律由 `Uuid::new_v4().to_string()` 生成；入口先校验格式，
/// 拒绝 `../x`、绝对路径等会经 `jobs_dir().join()` 穿越到任意目录的输入。
fn validate_job_id(job_id: &str) -> AppResult<()> {
    if uuid::Uuid::parse_str(job_id).is_ok() {
        Ok(())
    } else {
        Err(AppError::path_traversal(format!(
            "非法任务 ID（应为 UUID）: {job_id}"
        )))
    }
}

async fn wait_for_worker_handle(
    live: &LiveJob,
    timeout: Duration,
) -> Option<tokio::task::JoinHandle<()>> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        {
            let mut slot = live.handle.lock().unwrap_or_else(|e| e.into_inner());
            if let WorkerSlot::Running(h) = std::mem::replace(&mut *slot, WorkerSlot::Pending) {
                return Some(h);
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::select! {
            _ = live.handle_ready.notified() => {}
            _ = tokio::time::sleep(Duration::from_millis(20)) => {}
        }
    }
}

/// 递归统计一个目录的总字节数（不存在的目录返回 0）。
/// 用于清理前后对比得出"实际回收了多少" —— 比让每个清理路径自己记账可靠。
fn dir_total_bytes(root: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            let p = e.path();
            match p.metadata() {
                Ok(m) if m.is_dir() => stack.push(p),
                Ok(m) if m.is_file() => total = total.saturating_add(m.len()),
                _ => {}
            }
        }
    }
    total
}

fn is_active_state(state: JobState) -> bool {
    matches!(
        state,
        JobState::Pending
            | JobState::Validating
            | JobState::Extracting
            | JobState::Running
            | JobState::Finalizing
            | JobState::Cancelling
    )
}

/// Jobs left "running" on disk after process exit have no worker — mark failed/cancelled.
fn heal_orphan_active_job(m: &mut JobManifest) -> bool {
    if !is_active_state(m.state) {
        return false;
    }
    // Avoid racing create_job: manifest is saved to disk before the LiveJob map insert
    // is visible to concurrent list_jobs. Give a short grace period.
    let age = chrono::Utc::now().signed_duration_since(m.created_at);
    if age.num_seconds() < 5 {
        return false;
    }
    m.state = JobState::Failed;
    m.error = Some(AppError::new(
        crate::error::ErrorCode::Internal,
        "任务在应用退出或热重载后中断（无活动进程）",
    ));
    m.stats.finished_at = Some(chrono::Utc::now());
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::{EnhanceDto, OutputOptionsDto};
    use comic_engines::Waifu2xEngine;
    use image::{ImageBuffer, Rgb};
    use std::time::Duration;

    #[test]
    fn job_id_rejects_traversal_and_non_uuid() {
        assert!(validate_job_id("0e0d1a97-6c3b-4f60-9f0e-2f15372f5aa1").is_ok());
        for bad in ["../..", "/tmp/x", "a/b", "", "not-a-uuid", "..", "."] {
            let err = validate_job_id(bad).unwrap_err();
            assert_eq!(
                err.code,
                crate::error::ErrorCode::PathTraversal,
                "case {bad:?}"
            );
        }
    }

    #[tokio::test]
    async fn cancel_job_rejects_traversal_id() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = AppConfig {
            work_root: tmp.path().join("work"),
            use_mock_engine: true,
            ..Default::default()
        };
        cfg.ensure_dirs().unwrap();
        let sched = Scheduler::new(cfg).unwrap();
        let err = sched.cancel_job("../../../../Users").await.unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::PathTraversal);
        // 穿越目标目录必须原样存在（未被触碰）
        assert!(tmp.path().exists());
    }

    #[tokio::test]
    async fn end_to_end_folder_mock() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("pages");
        std::fs::create_dir_all(&src).unwrap();
        for i in 0..3 {
            let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
                ImageBuffer::from_pixel(16, 16, Rgb([i as u8 * 40, 10, 20]));
            image::DynamicImage::ImageRgb8(img)
                .save(src.join(format!("{i}.png")))
                .unwrap();
        }
        let out = tmp.path().join("out");
        std::fs::create_dir_all(&out).unwrap();

        let cfg = AppConfig {
            work_root: tmp.path().join("work"),
            use_mock_engine: true,
            ..Default::default()
        };
        cfg.ensure_dirs().unwrap();

        let sched = Scheduler::new(cfg).unwrap();
        let created = sched
            .create_job(CreateJobRequest {
                source: src.display().to_string(),
                engine: Some("waifu2x".into()),
                preset: "fast".into(),
                output: OutputOptionsDto {
                    dir: out.display().to_string(),
                    container: "cbz".into(),
                    image_format: "jpeg".into(),
                    jpeg_quality: Some(90),
                    webp_quality: None,
                    naming: Some("{stem}_x{scale}".into()),
                    output_max_side: None,
                },
                enhance: EnhanceDto {
                    scale: Some(2),
                    ..Default::default()
                },
            })
            .await
            .unwrap();
        let id = created.job_id;

        // wait for completion
        let mut status = None;
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let s = sched.get_job(&id).await.unwrap();
            if matches!(
                s.state,
                JobState::Completed | JobState::Failed | JobState::Cancelled
            ) {
                status = Some(s);
                break;
            }
        }
        let s = status.expect("job should finish");
        assert_eq!(s.state, JobState::Completed, "err={:?}", s.error);
        assert_eq!(s.pages_done, 3);
        assert!(s.output_path.is_some());
    }

    #[tokio::test]
    async fn cancel_orphan_disk_job() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = AppConfig {
            work_root: tmp.path().join("work"),
            use_mock_engine: true,
            ..Default::default()
        };
        cfg.ensure_dirs().unwrap();

        let job_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let workdir = cfg.jobs_dir().join(job_id);
        let mut m = JobManifest::new(
            tmp.path().join("x.cbz"),
            crate::job::EnhanceOptions::default(),
            crate::job::OutputOptions {
                dir: tmp.path().join("out"),
                ..Default::default()
            },
            workdir,
        );
        m.job_id = job_id.into();
        m.state = JobState::Running;
        m.save().unwrap();

        let sched = Scheduler::new(cfg).unwrap();
        // not in memory map — should still succeed
        sched.cancel_job(job_id).await.unwrap();
        let s = sched.get_job(job_id).await.unwrap();
        assert_eq!(s.state, JobState::Cancelled);
    }

    fn tiny_png(dir: &std::path::Path, name: &str) {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_pixel(8, 8, Rgb([3, 4, 5]));
        image::DynamicImage::ImageRgb8(img)
            .save(dir.join(name))
            .unwrap();
    }

    fn sample_req(src: &std::path::Path, out: &std::path::Path) -> CreateJobRequest {
        CreateJobRequest {
            source: src.display().to_string(),
            engine: Some("waifu2x".into()),
            preset: "fast".into(),
            output: OutputOptionsDto {
                dir: out.display().to_string(),
                container: "folder".into(),
                image_format: "png".into(),
                jpeg_quality: Some(90),
                webp_quality: None,
                naming: Some("{stem}_x{scale}".into()),
                output_max_side: None,
            },
            enhance: EnhanceDto {
                scale: Some(1),
                ..Default::default()
            },
        }
    }

    #[tokio::test]
    async fn probe_resume_announces_next_page() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("book");
        std::fs::create_dir_all(&src).unwrap();
        for i in 0..5 {
            tiny_png(&src, &format!("{i}.png"));
        }
        let cfg = AppConfig {
            work_root: tmp.path().join("work"),
            use_mock_engine: true,
            ..Default::default()
        };
        cfg.ensure_dirs().unwrap();

        let job_id = "resume-job-1";
        let workdir = cfg.jobs_dir().join(job_id);
        let mut m = JobManifest::new(
            src.clone(),
            crate::job::EnhanceOptions::default(),
            crate::job::OutputOptions {
                dir: tmp.path().join("out"),
                container: crate::job::OutputContainer::Folder,
                image_format: crate::job::ImageFormat::Png,
                ..Default::default()
            },
            workdir.clone(),
        );
        m.job_id = job_id.into();
        m.state = JobState::Cancelled;
        std::fs::create_dir_all(m.in_dir()).unwrap();
        std::fs::create_dir_all(m.out_dir()).unwrap();
        for i in 0..5 {
            tiny_png(&m.in_dir(), &format!("{i:05}.png"));
        }
        tiny_png(&m.out_dir(), "00000.png");
        tiny_png(&m.out_dir(), "00001.png");
        m.save().unwrap();

        let sched = Scheduler::new(cfg).unwrap();
        let hint = sched
            .probe_resume(&src.display().to_string())
            .await
            .unwrap()
            .expect("should find resume");
        assert_eq!(hint.pages_done, 2);
        assert_eq!(hint.pages_total, 5);
        assert_eq!(hint.next_page, 3);
        assert!(hint.message.contains("第 3 页"), "{}", hint.message);
    }

    #[tokio::test]
    async fn create_job_rejects_damaged_engine() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("book");
        std::fs::create_dir_all(&src).unwrap();
        tiny_png(&src, "0.png");
        let out = tmp.path().join("out");
        std::fs::create_dir_all(&out).unwrap();

        let cfg = AppConfig {
            work_root: tmp.path().join("work"),
            use_mock_engine: false,
            allow_mock_fallback: false,
            ..Default::default()
        };
        cfg.ensure_dirs().unwrap();
        let models = tmp.path().join("models");
        std::fs::create_dir_all(&models).unwrap();
        let engine = Arc::new(Waifu2xEngine::new(
            tmp.path().join("missing-waifu2x"),
            models,
        ));
        let sched = Scheduler::with_engine(cfg, engine).unwrap();
        let err = sched.create_job(sample_req(&src, &out)).await.unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::BinaryIntegrity);
        assert!(
            err.message.contains("引擎") || err.message.contains("Waifu2x"),
            "{}",
            err.message
        );
    }

    #[tokio::test]
    async fn cancel_large_mock_book_stops() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("book");
        std::fs::create_dir_all(&src).unwrap();
        for i in 0..120 {
            tiny_png(&src, &format!("{i:03}.png"));
        }
        let out = tmp.path().join("out");
        std::fs::create_dir_all(&out).unwrap();

        let cfg = AppConfig {
            work_root: tmp.path().join("work"),
            use_mock_engine: true,
            ..Default::default()
        };
        cfg.ensure_dirs().unwrap();

        let engine = Arc::new(MockEngine { delay_ms: 30 });
        let sched = Scheduler::with_engine(cfg, engine).unwrap();
        let created = sched.create_job(sample_req(&src, &out)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(120)).await;
        sched.cancel_job(&created.job_id).await.unwrap();

        let mut last = None;
        for _ in 0..80 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let s = sched.get_job(&created.job_id).await.unwrap();
            if matches!(
                s.state,
                JobState::Cancelled | JobState::Failed | JobState::Completed
            ) {
                last = Some(s);
                break;
            }
        }
        let s = last.expect("large job should stop after cancel");
        assert_ne!(s.state, JobState::Running);
        assert!(
            matches!(s.state, JobState::Cancelled | JobState::Completed),
            "state={:?} err={:?}",
            s.state,
            s.error
        );
    }

    /// C11 回归：并发 create_job 同源时，写锁内「检查+插入」保证只有一个通过去重
    #[tokio::test]
    async fn concurrent_create_job_same_source_deduped() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("book");
        std::fs::create_dir_all(&src).unwrap();
        for i in 0..8 {
            tiny_png(&src, &format!("{i}.png"));
        }
        let out = tmp.path().join("out");
        std::fs::create_dir_all(&out).unwrap();

        let cfg = AppConfig {
            work_root: tmp.path().join("work"),
            use_mock_engine: true,
            ..Default::default()
        };
        cfg.ensure_dirs().unwrap();

        // 足够的每页延迟，保证两个请求都落在任务进行中的窗口内
        let sched =
            Arc::new(Scheduler::with_engine(cfg, Arc::new(MockEngine { delay_ms: 50 })).unwrap());
        let a = sched.clone();
        let b = sched.clone();
        let src2 = src.clone();
        let out2 = out.clone();
        let (ra, rb) = tokio::join!(
            async move { a.create_job(sample_req(&src, &out)).await },
            async move { b.create_job(sample_req(&src2, &out2)).await },
        );
        let ok_count = [&ra, &rb].iter().filter(|r| r.is_ok()).count();
        let dup_count = [&ra, &rb]
            .iter()
            .filter(|r| {
                r.as_ref()
                    .err()
                    .is_some_and(|e| e.message.contains("已在队列中"))
            })
            .count();
        assert_eq!(ok_count, 1, "只有一个请求应成功: {ra:?} {rb:?}");
        assert_eq!(dup_count, 1, "另一个应报已在队列中: {ra:?} {rb:?}");
        // 清理：取消残留任务，等待 worker 退出。
        // 竞态里谁先注册并不固定，成功方可能是任意一个 future——
        // 早先这里写死 ra.unwrap()，b 先赢时会 panic（去重本身是对的）。
        let id = ra.or(rb).unwrap().job_id;
        let _ = sched.cancel_job(&id).await;
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if matches!(
                sched.get_job(&id).await.unwrap().state,
                JobState::Cancelled | JobState::Completed | JobState::Failed
            ) {
                break;
            }
        }
    }

    async fn insert_live(
        sched: &Scheduler,
        job_id: String,
        source: PathBuf,
        manifest: JobManifest,
        running: bool,
    ) {
        let mut map = sched.jobs.write().await;
        map.insert(
            job_id,
            LiveJob {
                manifest: Arc::new(RwLock::new(manifest)),
                cancel: CancellationToken::new(),
                source,
                active: Arc::new(AtomicBool::new(running)),
                abandoned: Arc::new(AtomicBool::new(false)),
                handle: Arc::new(StdMutex::new(WorkerSlot::Pending)),
                handle_ready: Arc::new(tokio::sync::Notify::new()),
            },
        );
    }

    #[tokio::test]
    async fn clear_finished_jobs_keeps_running_live_job() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = AppConfig {
            work_root: tmp.path().join("work"),
            use_mock_engine: true,
            ..Default::default()
        };
        cfg.ensure_dirs().unwrap();
        let job_id = "0e0d1a97-6c3b-4f60-9f0e-2f15372f5aa1".to_string();
        let workdir = cfg.jobs_dir().join(&job_id);
        std::fs::create_dir_all(&workdir).unwrap();
        let mut m = JobManifest::new(
            tmp.path().join("book"),
            crate::job::EnhanceOptions::default(),
            crate::job::OutputOptions {
                dir: tmp.path().join("out"),
                ..Default::default()
            },
            workdir,
        );
        m.job_id = job_id.clone();
        m.state = JobState::Running;
        m.save().unwrap();
        let sched = Scheduler::new(cfg).unwrap();
        insert_live(&sched, job_id.clone(), tmp.path().join("book"), m, true).await;
        let _ = sched.clear_finished_jobs().await.unwrap();
        assert!(
            sched.jobs.read().await.contains_key(&job_id),
            "running live job must survive clear_finished_jobs"
        );
        assert!(sched.config().jobs_dir().join(&job_id).is_dir());
    }

    #[tokio::test]
    async fn finished_job_dropped_from_memory_still_listed() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("pages");
        std::fs::create_dir_all(&src).unwrap();
        for i in 0..2 {
            tiny_png(&src, &format!("{i}.png"));
        }
        let out = tmp.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        let cfg = AppConfig {
            work_root: tmp.path().join("work"),
            use_mock_engine: true,
            ..Default::default()
        };
        cfg.ensure_dirs().unwrap();
        let sched = Scheduler::new(cfg).unwrap();
        let created = sched.create_job(sample_req(&src, &out)).await.unwrap();
        let id = created.job_id;
        let mut done = None;
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let s = sched.get_job(&id).await.unwrap();
            if matches!(s.state, JobState::Completed | JobState::Failed) {
                done = Some(s);
                break;
            }
        }
        let s = done.expect("job should finish");
        assert_eq!(s.state, JobState::Completed);
        for _ in 0..40 {
            if !sched.jobs.read().await.contains_key(&id) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            !sched.jobs.read().await.contains_key(&id),
            "terminal job should leave the in-memory map"
        );
        let listed = sched.list_jobs().await.unwrap();
        assert!(
            listed
                .iter()
                .any(|j| j.job_id == id && j.state == JobState::Completed),
            "list_jobs should still load the finished job from disk"
        );
    }

    #[tokio::test]
    async fn reader_enhance_unregisters_cancel_slot() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("book");
        std::fs::create_dir_all(&src).unwrap();
        tiny_png(&src, "0.png");
        let cfg = AppConfig {
            work_root: tmp.path().join("work"),
            use_mock_engine: true,
            ..Default::default()
        };
        cfg.ensure_dirs().unwrap();
        let sched =
            Scheduler::with_engine(cfg, Arc::new(comic_engines::MockEngine::default())).unwrap();
        let path = src.display().to_string();
        for _ in 0..8 {
            let _ = sched
                .enhance_reader_pages(Some(&path), None, &[0], None)
                .await;
        }
        let n = sched
            .reader_enhance_cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len();
        assert_eq!(n, 0, "cancel slots must unregister after each batch");
    }
}
