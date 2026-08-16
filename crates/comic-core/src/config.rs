use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    /// Root for job workdirs and manifests
    pub work_root: PathBuf,
    /// Default JPEG quality for export
    pub default_jpeg_quality: u8,
    /// Max zip entries
    pub max_archive_entries: u32,
    /// Max single uncompressed page bytes
    pub max_page_bytes: u64,
    /// Max total uncompressed extract bytes
    pub max_extract_bytes: u64,
    /// Max compression ratio (uncompressed/compressed) per entry
    pub max_compression_ratio: f64,
    /// Per-page enhance timeout seconds
    pub page_timeout_secs: u64,
    /// Max side length before warn / tile floor
    pub max_image_side: u32,
    /// Batch enhance input cap: pages larger than this are downscaled (aspect
    /// preserved) before inference, bounding engine output buffers.
    pub engine_input_max_side: u32,
    /// Force mock engine. Default **false** (prefer real Waifu2x when bundled).
    /// Set true for CI / offline dev without GPU binary.
    pub use_mock_engine: bool,
    /// Path to waifu2x binary (optional)
    pub waifu2x_bin: Option<PathBuf>,
    /// Path to models-cunet directory
    pub models_dir: Option<PathBuf>,
    /// System UnRAR binary (CBR/RAR). None = search PATH.
    pub unrar_bin: Option<PathBuf>,
    /// Enhance strategy:
    /// - `directory` (default): one waifu2x process for whole folder (fastest on GPU)
    /// - `parallel`: N concurrent single-page processes (CPU / multi-GPU experiments)
    pub enhance_mode: String,
    /// Parallel page workers when `enhance_mode=parallel` (default: num_cpus/2, min 1, max 4)
    pub enhance_concurrency: usize,
    /// waifu2x `-j load:proc:save` thread string. Empty = auto from CPU count.
    pub waifu2x_jobs: String,
    /// Extract convert parallelism (rayon). 0 = num_cpus.
    pub extract_concurrency: usize,
    /// When false (packaged release), never silently swap in the mock engine.
    #[serde(default = "default_true")]
    pub allow_mock_fallback: bool,
    /// Test hook: pretend this many free bytes exist on the work volume.
    #[serde(skip)]
    pub forced_free_bytes: Option<u64>,
}

fn default_true() -> bool {
    true
}

impl Default for AppConfig {
    fn default() -> Self {
        let work_root = std::env::temp_dir().join("PureComic");
        let cpus = num_cpus::get().max(1);
        Self {
            work_root,
            default_jpeg_quality: 92,
            max_archive_entries: 10_000,
            max_page_bytes: 256 * 1024 * 1024,
            max_extract_bytes: 8 * 1024 * 1024 * 1024,
            // 线稿/大留白漫画页 deflate 后常见 50–200×；100 会误伤《卢浮宫守望者》等
            max_compression_ratio: 500.0,
            page_timeout_secs: 180,
            max_image_side: 16_384,
            engine_input_max_side: 4096,
            use_mock_engine: false,
            waifu2x_bin: None,
            models_dir: None,
            unrar_bin: None,
            enhance_mode: "directory".into(),
            enhance_concurrency: (cpus / 2).clamp(1, 4),
            waifu2x_jobs: String::new(), // auto
            extract_concurrency: cpus,
            allow_mock_fallback: true,
            forced_free_bytes: None,
        }
    }
}

impl AppConfig {
    pub fn jobs_dir(&self) -> PathBuf {
        self.work_root.join("jobs")
    }

    pub fn library_path(&self) -> PathBuf {
        self.work_root.join("library.json")
    }

    pub fn library_covers_dir(&self) -> PathBuf {
        self.work_root.join("library").join("covers")
    }

    /// On-demand reader AI enhance cache (bounded, LRU).
    pub fn reader_enhance_dir(&self) -> PathBuf {
        self.work_root.join("reader-enhance")
    }

    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(self.jobs_dir())?;
        std::fs::create_dir_all(self.library_covers_dir())?;
        std::fs::create_dir_all(self.reader_enhance_dir())
    }

    /// Apply env overrides:
    /// - `COMIC_USE_MOCK=1|true` → force mock
    /// - `COMIC_USE_MOCK=0|false` → force prefer real (default)
    /// - `COMIC_WAIFU2X_BIN` / `COMIC_MODELS_DIR` absolute paths
    /// - `COMIC_THIRD_PARTY` used by comic-engines path resolver
    pub fn apply_env(&mut self) {
        if let Ok(v) = std::env::var("COMIC_USE_MOCK") {
            let v = v.to_ascii_lowercase();
            self.use_mock_engine = matches!(v.as_str(), "1" | "true" | "yes" | "on");
        }
        if let Ok(p) = std::env::var("COMIC_WAIFU2X_BIN") {
            self.waifu2x_bin = Some(PathBuf::from(p));
        }
        if let Ok(p) = std::env::var("COMIC_MODELS_DIR") {
            self.models_dir = Some(PathBuf::from(p));
        }
        if let Ok(p) = std::env::var("COMIC_UNRAR_BIN") {
            self.unrar_bin = Some(PathBuf::from(p));
        }
        if let Ok(m) = std::env::var("COMIC_ENHANCE_MODE") {
            self.enhance_mode = m.to_ascii_lowercase();
        }
        if let Ok(n) = std::env::var("COMIC_ENHANCE_CONCURRENCY") {
            if let Ok(v) = n.parse::<usize>() {
                self.enhance_concurrency = v.max(1);
            }
        }
        if let Ok(j) = std::env::var("COMIC_WAIFU2X_JOBS") {
            self.waifu2x_jobs = j;
        }
        if let Ok(n) = std::env::var("COMIC_EXTRACT_CONCURRENCY") {
            if let Ok(v) = n.parse::<usize>() {
                self.extract_concurrency = v.max(1);
            }
        }
    }

    pub fn resolved_waifu2x_jobs(&self) -> String {
        if !self.waifu2x_jobs.is_empty() {
            return self.waifu2x_jobs.clone();
        }
        // load:proc:save — proc benefits most from multi-core; keep load/save moderate
        let cpus = num_cpus::get().max(1);
        let proc = cpus.clamp(2, 8);
        let load = (cpus / 2).clamp(1, 4);
        let save = (cpus / 2).clamp(1, 4);
        format!("{load}:{proc}:{save}")
    }

    pub fn use_directory_enhance(&self) -> bool {
        !matches!(
            self.enhance_mode.as_str(),
            "parallel" | "page" | "pages" | "single"
        )
    }

    /// Default config for CLI/desktop: **real Waifu2x** when present; mock only if forced or missing.
    pub fn from_env() -> Self {
        let mut cfg = Self::default();
        cfg.apply_env();
        cfg
    }
}
