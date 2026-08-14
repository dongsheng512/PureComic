//! Job scheduler: create, list, cancel, background run.

use crate::config::AppConfig;
use crate::error::{AppError, AppResult};
use crate::job::{CreateJobRequest, CreateJobResult, JobManifest, JobState, JobStatus, ResumeHint};
use crate::pipeline::{self, new_gpu_lock, GpuLock, ProgressCallback};
use comic_engines::{EngineHub, EngineInfo, EngineKind, MockEngine, UpscaleEngine};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

struct LiveJob {
    manifest: Arc<RwLock<JobManifest>>,
    cancel: CancellationToken,
}

pub struct Scheduler {
    cfg: AppConfig,
    gpu: GpuLock,
    hub: EngineHub,
    override_engine: Option<Arc<dyn UpscaleEngine>>,
    jobs: Arc<RwLock<HashMap<String, LiveJob>>>,
    on_progress: Arc<RwLock<Option<ProgressCallback>>>,
    library: StdMutex<crate::library::LibraryStore>,
    reader_enhance_cancels: StdMutex<Vec<CancellationToken>>,
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
            reader_enhance_cancels: StdMutex::new(Vec::new()),
        })
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
            reader_enhance_cancels: StdMutex::new(Vec::new()),
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
        let (source, options, output) = req.into_parts()?;
        self.ensure_engine_ready(options.engine)?;
        let engine = self.pick_engine(options.engine)?;
        crate::estimate::assert_disk_ok(&source, options.scale.as_u8(), &self.cfg)?;
        if !output.dir.exists() {
            std::fs::create_dir_all(&output.dir)?;
        }

        if let Some(live_id) = self.live_job_for_source(&source).await {
            return Err(AppError::invalid(format!(
                "该书已在队列中处理（任务 {live_id}）"
            )));
        }

        let resume = self.find_resume_on_disk(&source);
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
            let mut manifest = JobManifest::new(source, options, output, workdir);
            manifest.job_id = job_id.clone();
            manifest.workdir = self.cfg.jobs_dir().join(&job_id);
            (job_id, manifest, false, 0, 0, 1)
        };

        let cancel = CancellationToken::new();
        let manifest_arc = Arc::new(RwLock::new(manifest));
        let live = LiveJob {
            manifest: manifest_arc.clone(),
            cancel: cancel.clone(),
        };

        self.jobs.write().await.insert(job_id.clone(), live);
        {
            let m = manifest_arc.read().await;
            m.save()?;
        }

        let cfg = self.cfg.clone();
        let gpu = self.gpu.clone();
        let on_progress = self.on_progress.read().await.clone();
        let job_id_spawn = job_id.clone();

        {
            let p = manifest_arc.read().await.source.path.clone();
            if let Ok(mut lib) = self.library.lock() {
                let _ = lib.upsert_path(&p, &self.cfg);
                let _ = lib.attach_job(&p, &job_id, "running", None);
            }
        }

        tokio::spawn(async move {
            let res = pipeline::run_job(manifest_arc, engine, cfg, gpu, cancel, on_progress).await;
            if let Err(e) = res {
                warn!(job = %job_id_spawn, error = %e, "job ended with error");
            } else {
                info!(job = %job_id_spawn, "job finished ok");
            }
        });

        Ok(CreateJobResult {
            job_id,
            resumed,
            pages_done: done,
            pages_total: total,
            next_page: next,
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
        Ok(self.find_resume_on_disk(&source))
    }

    pub async fn cancel_job(&self, job_id: &str) -> AppResult<()> {
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
        if let Some(live) = self.jobs.read().await.get(job_id) {
            let mut m = live.manifest.write().await;
            if crate::job::heal_if_output_ready(&mut m) {
                let _ = m.save();
            }
            return Ok(m.to_status());
        }
        let dir = self.cfg.jobs_dir().join(job_id);
        let mut m = JobManifest::load(&dir)?;
        if crate::job::heal_if_output_ready(&mut m) || heal_orphan_active_job(&mut m) {
            let _ = m.save();
        }
        Ok(m.to_status())
    }

    pub async fn list_jobs(&self) -> AppResult<Vec<JobStatus>> {
        let mut out = Vec::new();
        let map = self.jobs.read().await;
        for live in map.values() {
            // Heal live jobs stuck in 打包中/取消中 after output already written
            let mut m = live.manifest.write().await;
            if crate::job::heal_if_output_ready(&mut m) {
                let _ = m.save();
            }
            out.push(m.to_status());
        }
        if let Ok(rd) = std::fs::read_dir(self.cfg.jobs_dir()) {
            for e in rd.flatten() {
                let id = e.file_name().to_string_lossy().to_string();
                if map.contains_key(&id) {
                    continue;
                }
                if let Ok(mut m) = JobManifest::load(&e.path()) {
                    if crate::job::heal_if_output_ready(&mut m) || heal_orphan_active_job(&mut m) {
                        let _ = m.save();
                    }
                    out.push(m.to_status());
                }
            }
        }
        out.sort_by(|a, b| b.job_id.cmp(&a.job_id));
        Ok(out)
    }

    /// Remove one job directory (and drop from memory if present).
    /// Active live jobs are cancelled first.
    pub async fn remove_job(&self, job_id: &str) -> AppResult<()> {
        // cancel live worker if any
        {
            let jobs = self.jobs.read().await;
            if let Some(live) = jobs.get(job_id) {
                live.cancel.cancel();
            }
        }
        self.jobs.write().await.remove(job_id);
        let dir = self.cfg.jobs_dir().join(job_id);
        if dir.is_dir() {
            std::fs::remove_dir_all(&dir).map_err(|e| {
                AppError::internal(format!("删除任务目录失败: {}: {e}", dir.display()))
            })?;
            info!(job = %job_id, "job directory removed");
        }
        Ok(())
    }

    /// Delete finished jobs: completed / failed / cancelled (and disk orphans).
    /// Does **not** touch live active workers.
    /// Returns number of job folders removed.
    pub async fn clear_finished_jobs(&self) -> AppResult<u32> {
        let live_ids: std::collections::HashSet<String> = {
            let map = self.jobs.read().await;
            let mut set = std::collections::HashSet::new();
            for (id, live) in map.iter() {
                let state = live.manifest.read().await.state;
                // keep active live jobs
                if is_active_state(state) {
                    set.insert(id.clone());
                }
            }
            set
        };

        // Drop terminal live entries from memory
        {
            let mut map = self.jobs.write().await;
            let terminal: Vec<String> = {
                let mut ids = Vec::new();
                for (id, live) in map.iter() {
                    let state = live.manifest.read().await.state;
                    if !is_active_state(state) {
                        ids.push(id.clone());
                    }
                }
                ids
            };
            for id in terminal {
                map.remove(&id);
            }
        }

        let mut removed = 0u32;
        let jobs_dir = self.cfg.jobs_dir();
        if let Ok(rd) = std::fs::read_dir(&jobs_dir) {
            for e in rd.flatten() {
                let id = e.file_name().to_string_lossy().to_string();
                if live_ids.contains(&id) {
                    continue; // still running
                }
                let path = e.path();
                if !path.is_dir() {
                    continue;
                }
                // Any job not actively live in memory is safe to purge (finished + orphans).
                match std::fs::remove_dir_all(&path) {
                    Ok(()) => {
                        removed += 1;
                        info!(job = %id, "cleared finished/orphan job");
                    }
                    Err(err) => {
                        warn!(job = %id, error = %err, "failed to remove job dir");
                    }
                }
            }
        }
        Ok(removed)
    }

    pub async fn validate_source_path(
        &self,
        path: &str,
    ) -> AppResult<crate::archive::ValidateResult> {
        crate::archive::validate_source(PathBuf::from(path).as_path(), &self.cfg)
    }

    pub async fn estimate(
        &self,
        path: &str,
        scale: u8,
    ) -> AppResult<crate::estimate::DiskEstimate> {
        crate::estimate::estimate_disk_usage(PathBuf::from(path).as_path(), scale, &self.cfg)
    }

    pub async fn preview_page(
        &self,
        source: &str,
        page_index: u32,
        options: Option<crate::preview::EnhanceOptionsDto>,
    ) -> AppResult<crate::preview::PreviewResult> {
        let kind = match options
            .as_ref()
            .and_then(|o| o.engine.as_deref())
            .unwrap_or("realcugan")
        {
            "waifu2x" | "auto" => EngineKind::Waifu2x,
            "waifu2x-coreml" | "coreml" => EngineKind::Waifu2xCoreMl,
            "realesrgan-coreml" | "esrgan-coreml" | "esrgan-anime" => EngineKind::RealEsrganCoreMl,
            _ => EngineKind::RealCugan,
        };
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
        // 阅读器只跑 Core ML：Vulkan waifu2x / Real-CUGAN 留给整本增强。
        let kind = match options
            .as_ref()
            .and_then(|o| o.engine.as_deref())
            .unwrap_or("waifu2x-coreml")
        {
            "realesrgan-coreml" | "esrgan-coreml" | "esrgan-anime" => EngineKind::RealEsrganCoreMl,
            _ => EngineKind::Waifu2xCoreMl,
        };
        self.ensure_engine_ready(kind)?;
        let engine = self.pick_engine(kind)?;
        let cancel = CancellationToken::new();
        {
            let mut slots = self
                .reader_enhance_cancels
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            slots.retain(|t| !t.is_cancelled());
            slots.push(cancel.clone());
        }
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
        for t in slots.drain(..) {
            t.cancel();
        }
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

    pub fn clear_reader_enhance_cache(
        &self,
    ) -> AppResult<crate::reader_enhance::EnhanceCacheClearResult> {
        crate::reader_enhance::clear_cache(&self.cfg)
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

    pub fn list_library(&self) -> AppResult<Vec<crate::library::LibraryEntry>> {
        let mut lib = self
            .library
            .lock()
            .map_err(|_| AppError::internal("书库锁失败"))?;
        lib.refresh_covers(&self.cfg);
        Ok(lib.list())
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

    pub fn ensure_engine_ready(&self, kind: EngineKind) -> AppResult<()> {
        if self.cfg.use_mock_engine && self.override_engine.is_none() {
            return Ok(());
        }
        let e = self.pick_engine(kind)?;
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
        let map = self.jobs.read().await;
        for (id, live) in map.iter() {
            let m = live.manifest.read().await;
            if is_active_state(m.state) && source_key(&m.source.path) == want {
                return Some(id.clone());
            }
        }
        None
    }

    fn find_resume_on_disk(&self, source: &std::path::Path) -> Option<ResumeHint> {
        let want = source_key(source);
        let mut best: Option<ResumeHint> = None;
        let rd = std::fs::read_dir(self.cfg.jobs_dir()).ok()?;
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
            if total == 0 && done == 0 && m.pages.is_empty() {
                // extracted nothing yet — still resumable if workdir exists
                if !m.in_dir().is_dir() {
                    continue;
                }
            }
            if done >= total && total > 0 {
                continue;
            }
            let hint = ResumeHint::from_counts(
                m.job_id.clone(),
                m.source.path.display().to_string(),
                done,
                total,
            );
            best = Some(hint);
        }
        best
    }
}

fn source_key(p: &std::path::Path) -> String {
    std::fs::canonicalize(p)
        .unwrap_or_else(|_| p.to_path_buf())
        .to_string_lossy()
        .to_string()
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

        let mut cfg = AppConfig::default();
        cfg.work_root = tmp.path().join("work");
        cfg.use_mock_engine = true;
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
        let mut cfg = AppConfig::default();
        cfg.work_root = tmp.path().join("work");
        cfg.use_mock_engine = true;
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
        let mut cfg = AppConfig::default();
        cfg.work_root = tmp.path().join("work");
        cfg.use_mock_engine = true;
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

        let mut cfg = AppConfig::default();
        cfg.work_root = tmp.path().join("work");
        cfg.use_mock_engine = false;
        cfg.allow_mock_fallback = false;
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

        let mut cfg = AppConfig::default();
        cfg.work_root = tmp.path().join("work");
        cfg.use_mock_engine = true;
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
}
