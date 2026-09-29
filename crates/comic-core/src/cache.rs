//! 缓存总览与清理 —— 把散落在各模块的存储收成一份可展示、可清理的清单。
//!
//! 为什么需要这个模块：这些缓存本来各自为政（`reader.rs` / `ebook.rs` /
//! `reader_enhance.rs` / `library.rs` / `scheduler.rs` 各管各的），
//! **没有任何一处能看到全貌**。后果之一就是 `mobi-cache` 在完全没有任何上限的情况下
//! 长到 1.4 GB（占整个 `work_root` 的 82%）、却没有任何界面或命令能看见它。
//!
//! **新增缓存时必须在这里登记**，否则它依然会隐身。

use crate::config::AppConfig;
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CacheGroupId {
    /// MOBI/AZW3 整本展开缓存（`ebook.rs`）
    Mobi,
    /// 整本原始页解压缓存（`reader.rs`）
    Reader,
    /// 阅读器按需 AI 增强缓存（`reader_enhance.rs`）
    ReaderEnhance,
    /// 书库封面缩略图（`library.rs`）
    Covers,
    /// 任务工作目录（`scheduler.rs`）
    Jobs,
}

impl CacheGroupId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mobi => "mobi",
            Self::Reader => "reader",
            Self::ReaderEnhance => "readerEnhance",
            Self::Covers => "covers",
            Self::Jobs => "jobs",
        }
    }
}

/// 「纯缓存」删掉后下次使用会自动重建；
/// 「半数据」同时是某个功能的唯一数据源 —— 删掉**不会报错**，但会让那个功能的表现退化。
/// UI 必须把两者区分开，不能让用户以为两件事是一回事。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CacheGroupKind {
    Pure,
    /// 只清"可以安全清的那部分"（jobs 只清终态、covers 只清孤儿）
    Mixed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheGroupStats {
    pub id: CacheGroupId,
    pub kind: CacheGroupKind,
    /// 当前占用
    pub bytes: u64,
    pub files: u64,
    /// 目录数 / 条目数（书数、任务数、封面数）
    pub entries: u32,
    /// 清理这一组**实际能回收多少** —— 不等于 `bytes`：
    /// covers 只回收孤儿、jobs 只回收终态。UI 必须显示这个数，否则会承诺不存在的空间。
    pub reclaim_bytes: u64,
    pub reclaim_files: u64,
    pub cap_bytes: Option<u64>,
    pub cap_entries: Option<u32>,
    /// 有活跃的在途工作，此刻清理不安全
    pub busy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheOverview {
    pub groups: Vec<CacheGroupStats>,
    pub total_bytes: u64,
    pub reclaimable_bytes: u64,
    pub free_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheClearResult {
    pub removed: u32,
    pub bytes_freed: u64,
}

/// 「某个分组里的某一本书」的占用 —— "按漫画显示缓存"的一行。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEntry {
    /// 分组内这一行的标识（目录名 / 书的 id / 任务 id）。清理时原样传回。
    pub key: String,
    /// 归属到的书；`None` 表示磁盘上有这份缓存、但书库里找不到对应条目
    pub book_id: Option<String>,
    pub title: Option<String>,
    /// 源文件路径（能归属时）
    pub source: Option<String>,
    /// 源文件已经不在磁盘上了 —— 这份缓存已经没有书在读它
    pub source_missing: bool,
    /// 当前占用
    pub bytes: u64,
    pub files: u64,
    /// 清理这一行**实际能回收**多少。**不等于 `bytes`**：
    /// 封面要留下书库正在用的那张、任务要留下在途的。为 0 时按钮就该是灰的。
    pub reclaim_bytes: u64,
    /// 最近使用时间（unix 秒）
    pub last_used: Option<i64>,
}

/// 「这本书在**某一类**缓存里的占用」—— 整本清理时逐项走的就是这个列表。
///
/// 之所以要 `group` + `key` 一起带上：同名的键在不同类型里指向完全不同的目录
/// （封面用书 id、mobi/reader 用目录名、任务用 job id），只传 key 无法定位。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookCachePart {
    pub group: CacheGroupId,
    pub key: String,
    pub bytes: u64,
    pub files: u64,
    /// 这一项实际能回收多少（封面留下在用的、任务留下在途的）
    pub reclaim_bytes: u64,
    pub last_used: Option<i64>,
    /// 在途任务 —— 此刻清它会打断正在跑的工作
    pub busy: bool,
}

/// 「一本书占用的全部缓存」—— 缓存页**主视图**的一行。
///
/// 与 `CacheEntry`（某一类里的某本书）是转置关系：把 5 类摊开、再按书卷起来。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookCacheEntry {
    /// 这一行的稳定标识。已归属 = 书 id；未归属 = `{类型}:{该类里的键}`。
    ///
    /// 由服务端给出而不是让前端自己拼：前端再推一遍就会有两处"行标识"逻辑，
    /// 展开状态、清理中的行高亮都会跟着漂 —— 与"密钥只能有一处实现"同一个道理。
    pub key: String,
    /// 归属到的书；`None` = 磁盘上有这份缓存，但书库里找不到对应的书（"未归属"）
    pub book_id: Option<String>,
    pub title: Option<String>,
    pub source: Option<String>,
    pub source_missing: bool,
    /// 全部类型加起来
    pub bytes: u64,
    pub files: u64,
    /// 整本清理**实际能回收**多少 = 各类型 `reclaim_bytes` 之和。为 0 时按钮就该是灰的。
    pub reclaim_bytes: u64,
    /// 这本书有在途任务 —— 整本清理会打断它，此刻必须禁用
    pub busy: bool,
    pub last_used: Option<i64>,
    /// 展开时显示的按类型拆分；至少一项
    pub parts: Vec<BookCachePart>,
}

/// 「要清的那一项」的引用 —— 前端把它从 `BookCachePart` 里原样回传。
///
/// 之所以让调用方传清单而不是传书名：**未归属的行没有书 id**，
/// 按书 id 反查会漏掉它们，而"藏起来清不掉"正是这个模块要避免的事。
/// 安全性由服务端兜底（`safe_entry_key` + mobi 目录名形状 + 封面引用集 + 任务保护集）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachePartRef {
    pub group: CacheGroupId,
    pub key: String,
}

/// 归属索引的书库侧输入（运行态快照，来自 `LibraryStore`，不在磁盘上）。
#[derive(Debug, Clone)]
pub struct CacheBookRef {
    pub id: String,
    pub path: String,
    pub title: String,
    pub job_id: Option<String>,
    /// 源文件已不在磁盘上
    pub source_missing: bool,
}

/// 调用方（`Scheduler`）提供的运行态快照 —— 这些信息不在磁盘上。
#[derive(Debug, Clone, Default)]
pub struct CacheContext {
    /// 仍在活跃/在途的任务 id（= jobs 子目录名）。这些目录**不能**删。
    pub protected_jobs: HashSet<String>,
    /// 书库当前引用的封面文件名。只删不在其中的文件 ——
    /// `refresh_covers` 明确支持"已有能显示的封面就保留（含旧版 tag 路径）"，
    /// 所以**按引用关系判断，不按 tag 判断**，否则会删掉正在用的封面。
    pub referenced_covers: HashSet<String>,
}

/// 递归收集一个目录下的所有文件（路径, 字节数）。
fn walk_files(root: &Path, out: &mut Vec<(PathBuf, u64)>) {
    let Ok(rd) = std::fs::read_dir(root) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        match p.metadata() {
            Ok(m) if m.is_dir() => walk_files(&p, out),
            Ok(m) if m.is_file() => out.push((p, m.len())),
            _ => {}
        }
    }
}

fn sum_bytes(files: &[(PathBuf, u64)]) -> u64 {
    files.iter().map(|f| f.1).sum()
}

/// 一个"每本书一个子目录"型缓存的通用统计：返回（目录数, 文件数, 字节数）。
/// `keep` 用来筛目录名（例如只认 `mobi-*`，避开 `tmp-*` 构建残留）。
fn weigh_book_dirs(root: &Path, keep: &dyn Fn(&str) -> bool) -> (u32, u64, u64) {
    let mut dirs = 0u32;
    let mut files = 0u64;
    let mut bytes = 0u64;
    let Ok(rd) = std::fs::read_dir(root) else {
        return (0, 0, 0);
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !keep(&name) || !e.path().is_dir() {
            continue;
        }
        dirs += 1;
        let mut found = Vec::new();
        walk_files(&e.path(), &mut found);
        files = files.saturating_add(found.len() as u64);
        bytes = bytes.saturating_add(sum_bytes(&found));
    }
    (dirs, files, bytes)
}

fn group_mobi(cfg: &AppConfig) -> CacheGroupStats {
    // `tmp-*` 是构建中的临时目录，不是缓存内容 —— 统计和回收都不算它。
    let (dirs, files, bytes) = weigh_book_dirs(&cfg.mobi_cache_dir(), &|n| n.starts_with("mobi-"));
    CacheGroupStats {
        id: CacheGroupId::Mobi,
        kind: CacheGroupKind::Pure,
        bytes,
        files,
        entries: dirs,
        reclaim_bytes: bytes,
        reclaim_files: files,
        cap_bytes: Some(crate::ebook::MAX_MOBI_CACHE_BYTES),
        cap_entries: Some(crate::ebook::MAX_MOBI_CACHE_BOOKS as u32),
        busy: false,
    }
}

fn group_reader(cfg: &AppConfig) -> CacheGroupStats {
    let (dirs, files, bytes) = weigh_book_dirs(&cfg.reader_dir(), &|_| true);
    CacheGroupStats {
        id: CacheGroupId::Reader,
        kind: CacheGroupKind::Pure,
        bytes,
        files,
        entries: dirs,
        reclaim_bytes: bytes,
        reclaim_files: files,
        cap_bytes: Some(crate::reader::MAX_READER_CACHE_BYTES),
        cap_entries: Some(crate::reader::MAX_READER_CACHE_BOOKS as u32),
        busy: false,
    }
}

fn group_reader_enhance(cfg: &AppConfig) -> CacheGroupStats {
    let s = crate::reader_enhance::cache_stats(cfg);
    CacheGroupStats {
        id: CacheGroupId::ReaderEnhance,
        kind: CacheGroupKind::Pure,
        bytes: s.bytes,
        files: s.files as u64,
        entries: s.files,
        reclaim_bytes: s.bytes,
        reclaim_files: s.files as u64,
        cap_bytes: Some(s.max_bytes),
        cap_entries: Some(s.max_files),
        busy: false,
    }
}

fn group_covers(cfg: &AppConfig, referenced: &HashSet<String>) -> CacheGroupStats {
    let root = cfg.library_covers_dir();
    let mut all = Vec::new();
    walk_files(&root, &mut all);
    let orphans: Vec<&(PathBuf, u64)> = all
        .iter()
        .filter(|(p, _)| {
            p.file_name()
                .map(|n| !referenced.contains(&n.to_string_lossy().into_owned()))
                .unwrap_or(false)
        })
        .collect();
    CacheGroupStats {
        id: CacheGroupId::Covers,
        kind: CacheGroupKind::Mixed,
        bytes: sum_bytes(&all),
        files: all.len() as u64,
        entries: all.len() as u32,
        reclaim_bytes: orphans.iter().map(|f| f.1).sum(),
        reclaim_files: orphans.len() as u64,
        cap_bytes: None,
        cap_entries: None,
        busy: false,
    }
}

fn group_jobs(cfg: &AppConfig, protected: &HashSet<String>) -> CacheGroupStats {
    let root = cfg.jobs_dir();
    let mut all = 0u64;
    let mut all_files = 0u64;
    let mut dirs = 0u32;
    let mut reclaim = 0u64;
    let mut reclaim_files = 0u64;
    let Ok(rd) = std::fs::read_dir(&root) else {
        return CacheGroupStats {
            id: CacheGroupId::Jobs,
            kind: CacheGroupKind::Mixed,
            bytes: 0,
            files: 0,
            entries: 0,
            reclaim_bytes: 0,
            reclaim_files: 0,
            cap_bytes: None,
            cap_entries: None,
            busy: false,
        };
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !e.path().is_dir() {
            continue;
        }
        dirs += 1;
        let mut found = Vec::new();
        walk_files(&e.path(), &mut found);
        let b = sum_bytes(&found);
        all = all.saturating_add(b);
        all_files = all_files.saturating_add(found.len() as u64);
        if !protected.contains(&name) {
            reclaim = reclaim.saturating_add(b);
            reclaim_files = reclaim_files.saturating_add(found.len() as u64);
        }
    }
    CacheGroupStats {
        id: CacheGroupId::Jobs,
        kind: CacheGroupKind::Mixed,
        bytes: all,
        files: all_files,
        entries: dirs,
        reclaim_bytes: reclaim,
        reclaim_files,
        cap_bytes: None,
        cap_entries: None,
        // jobs 有活跃任务时**整组**禁用：语义上"清理任务目录"这件事此刻不安全，
        // 让用户先取消或等结束后再清。clear_finished_jobs 本身会跳过活跃任务，
        // 但把按钮点亮会让人以为能清干净。
        busy: !protected.is_empty(),
    }
}

/// 统计全部缓存组。全树递归遍历，**必须**放在 blocking 线程里调用。
pub fn collect_overview(cfg: &AppConfig, ctx: &CacheContext) -> CacheOverview {
    let groups = vec![
        group_mobi(cfg),
        group_reader(cfg),
        group_reader_enhance(cfg),
        group_covers(cfg, &ctx.referenced_covers),
        group_jobs(cfg, &ctx.protected_jobs),
    ];
    let total_bytes = groups.iter().map(|g| g.bytes).sum();
    let reclaimable_bytes = groups.iter().map(|g| g.reclaim_bytes).sum();
    let free_bytes = fs2::available_space(&cfg.work_root)
        .ok()
        .or_else(|| fs2::available_space(std::env::temp_dir()).ok());
    CacheOverview {
        groups,
        total_bytes,
        reclaimable_bytes,
        free_bytes,
    }
}

fn remove_paths(paths: &[PathBuf]) -> CacheClearResult {
    let mut removed = 0u32;
    let mut bytes_freed = 0u64;
    for p in paths {
        // 目录和文件走不同 syscall，但两者都可能是"这一组的一项"
        let (ok, size) = match p.metadata() {
            Ok(m) if m.is_dir() => {
                let mut found = Vec::new();
                walk_files(p, &mut found);
                (std::fs::remove_dir_all(p).is_ok(), sum_bytes(&found))
            }
            Ok(m) => (std::fs::remove_file(p).is_ok(), m.len()),
            Err(_) => (false, 0),
        };
        if ok {
            removed += 1;
            bytes_freed = bytes_freed.saturating_add(size);
        }
    }
    CacheClearResult {
        removed,
        bytes_freed,
    }
}

/// 清掉一个目录下的全部直接子项（目录 + 文件）。
fn child_paths(root: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    rd.flatten().map(|e| e.path()).collect()
}

/// 清理一个缓存组。**`Jobs` 不在这里处理** —— 它必须走 `Scheduler::clear_finished_jobs`
/// 才能拿到"先取消在途、等 worker 退出、防目录复活"这一整套保护。
pub fn clear_group(
    cfg: &AppConfig,
    id: CacheGroupId,
    ctx: &CacheContext,
) -> AppResult<CacheClearResult> {
    let result = match id {
        CacheGroupId::Mobi => {
            let root = cfg.mobi_cache_dir();
            let paths: Vec<PathBuf> = child_paths(&root)
                .into_iter()
                .filter(|p| {
                    p.is_dir()
                        && p.file_name()
                            .map(|n| n.to_string_lossy().starts_with("mobi-"))
                            .unwrap_or(false)
                })
                .collect();
            remove_paths(&paths)
        }
        CacheGroupId::Reader => {
            let paths = child_paths(&cfg.reader_dir());
            remove_paths(&paths)
        }
        CacheGroupId::ReaderEnhance => {
            // 保留目录本体（下游代码假定它存在，且 ensure_dirs 会建）
            let root = cfg.reader_enhance_dir();
            let r = remove_paths(&child_paths(&root));
            let _ = std::fs::create_dir_all(&root);
            r
        }
        CacheGroupId::Covers => {
            let root = cfg.library_covers_dir();
            let paths: Vec<PathBuf> = child_paths(&root)
                .into_iter()
                .filter(|p| {
                    p.file_name()
                        .map(|n| !ctx.referenced_covers.contains(&n.to_string_lossy().into_owned()))
                        .unwrap_or(false)
                })
                .collect();
            remove_paths(&paths)
        }
        CacheGroupId::Jobs => {
            return Err(crate::error::AppError::invalid(
                "任务目录必须经 Scheduler 清理",
            ))
        }
    };
    Ok(result)
}

// ---------------------------------------------------------------------------
// 按漫画归属
// ---------------------------------------------------------------------------

/// 每个分组共同的一层：明细行的体积与总览行的体积必须来自同一次遍历口径。
fn unix_secs(t: std::time::SystemTime) -> Option<i64> {
    t.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

/// 「缓存键 → 书」的索引。
///
/// ⚠️ **所有分组都从 `path` 重算密钥，绝不能用 `CacheBookRef::id` 走捷径。**
/// `id` 是历史上写入书库的值（`upsert_path` 现在用 `source_cache_key` 生成它），
/// 但实测它与现在重算的 `source_cache_key(path)` 只有 **2/29** 相等；
/// 13 个真实 mobi 目录前缀里也有 **2 个不在任何 `id` 的前 12 位里**。
/// 用 id 去匹配会**静默漏书** —— 界面上表现为某个目录没有书名，不报错、不崩溃，
/// 而且看起来"就是这样的"。所以宁可多算一次哈希。
#[derive(Default)]
pub struct BookIndex {
    books: Vec<CacheBookRef>,
    by_mobi_prefix: HashMap<String, usize>,
    by_cache_key: HashMap<String, usize>,
    by_id: HashMap<String, usize>,
    by_job: HashMap<String, usize>,
}

impl BookIndex {
    pub fn build(books: Vec<CacheBookRef>) -> Self {
        let mut ix = Self {
            books,
            ..Default::default()
        };
        for i in 0..ix.books.len() {
            let path = PathBuf::from(&ix.books[i].path);
            let mobi = crate::ebook::mobi_cache_key_prefix(&path);
            let key = crate::reader::source_cache_key(&path);
            let id = ix.books[i].id.clone();
            let job = ix.books[i].job_id.clone();
            // 同一个 mobi 前缀理论上只会有一本书（前缀即路径哈希）；
            // 真有碰撞也保留先来的那个，不覆盖。
            ix.by_mobi_prefix.entry(mobi).or_insert(i);
            ix.by_cache_key.entry(key).or_insert(i);
            ix.by_id.entry(id).or_insert(i);
            if let Some(j) = job {
                ix.by_job.entry(j).or_insert(i);
            }
        }
        ix
    }

    fn book(&self, i: usize) -> &CacheBookRef {
        &self.books[i]
    }

    fn mobi(&self, dir_name: &str) -> Option<&CacheBookRef> {
        crate::ebook::mobi_cache_dir_prefix(dir_name)
            .and_then(|p| self.by_mobi_prefix.get(p))
            .map(|i| self.book(*i))
    }

    fn keyed(&self, key: &str) -> Option<&CacheBookRef> {
        self.by_cache_key.get(key).map(|i| self.book(*i))
    }

    fn id(&self, id: &str) -> Option<&CacheBookRef> {
        self.by_id.get(id).map(|i| self.book(*i))
    }

    fn job(&self, job_id: &str) -> Option<&CacheBookRef> {
        self.by_job.get(job_id).map(|i| self.book(*i))
    }
}

fn entry_from(
    key: String,
    bytes: u64,
    files: u64,
    last_used: Option<i64>,
    book: Option<&CacheBookRef>,
) -> CacheEntry {
    CacheEntry {
        key,
        book_id: book.map(|b| b.id.clone()),
        title: book.map(|b| b.title.clone()),
        source: book.map(|b| b.path.clone()),
        source_missing: book.map(|b| b.source_missing).unwrap_or(false),
        bytes,
        files,
        // 默认全额可回收；封面与任务在各自的收集函数里下调
        reclaim_bytes: bytes,
        last_used,
    }
}

/// mobi / reader / reader-enhance 共同的形状：一级子目录就是"一本书"。
///
/// 成员过滤必须与总览行的 `weigh_book_dirs` 过滤**逐字一致**，
/// 否则明细之和会与上面那一行的数字对不上（页面会显得在骗人）。
fn collect_book_dir_entries(root: &Path, id: CacheGroupId, index: &BookIndex) -> Vec<CacheEntry> {
    let Ok(rd) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        let key = e.file_name().to_string_lossy().into_owned();
        let member = match id {
            // `tmp-*` 是构建中的临时目录，`group_mobi` 也不算它
            CacheGroupId::Mobi => key.starts_with("mobi-"),
            // `.batch` / `.scratch` 是推理中间态，`cache_stats` 也不算它们
            CacheGroupId::ReaderEnhance => !key.starts_with('.'),
            _ => true,
        };
        if !member {
            continue;
        }
        let (mtime, bytes, files) = crate::reader::book_dir_weight_full(&e.path());
        // 先归属、再交出 key：`key` 传进 `entry_from` 会被移动
        let book = match id {
            CacheGroupId::Mobi => index.mobi(&key),
            _ => index.keyed(&key),
        };
        out.push(entry_from(key, bytes, files, unix_secs(mtime), book));
    }
    out
}

/// 封面缓存按书 id 归组：文件名形如 `{书id}.{tag}.jpg`。
///
/// 一行 = 一本书的**全部**封面文件；`reclaim_bytes` 只算不在引用集里的那些，
/// 因为正在用的那张删了会让书库立刻失去封面（还会被 `refresh_covers` 抽回来，
/// 等于白删）。所以这一行 `bytes > reclaim_bytes` 是常态，不是 bug。
fn collect_cover_entries(
    cfg: &AppConfig,
    ctx: &CacheContext,
    index: &BookIndex,
) -> Vec<CacheEntry> {
    let root = cfg.library_covers_dir();
    let mut all = Vec::new();
    walk_files(&root, &mut all);

    // 归组：文件名第一个 '.' 之前是书 id
    let mut grouped: HashMap<String, (u64, u64, u64, i64)> = HashMap::new();
    for (path, len) in &all {
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        let id = name.split('.').next().unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let referenced = ctx.referenced_covers.contains(&name);
        let mtime = path
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(unix_secs)
            .unwrap_or(0);
        let slot = grouped.entry(id).or_insert((0, 0, 0, 0));
        slot.0 = slot.0.saturating_add(*len);
        slot.1 = slot.1.saturating_add(1);
        if !referenced {
            slot.2 = slot.2.saturating_add(*len);
        }
        slot.3 = slot.3.max(mtime);
    }

    grouped
        .into_iter()
        .map(|(id, (bytes, files, reclaim, mtime))| {
            let mut e = entry_from(
                id.clone(),
                bytes,
                files,
                (mtime > 0).then_some(mtime),
                index.id(&id),
            );
            e.reclaim_bytes = reclaim;
            e
        })
        .collect()
}

/// 任务分组：一级子目录名就是 job id。
fn collect_job_entries(
    cfg: &AppConfig,
    ctx: &CacheContext,
    index: &BookIndex,
) -> Vec<CacheEntry> {
    let root = cfg.jobs_dir();
    let Ok(rd) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in rd.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        let job_id = e.file_name().to_string_lossy().into_owned();
        let (mtime, bytes, files) = crate::reader::book_dir_weight_full(&e.path());
        let mut entry = entry_from(
            job_id.clone(),
            bytes,
            files,
            unix_secs(mtime),
            index.job(&job_id),
        );
        if ctx.protected_jobs.contains(&job_id) {
            // 在途任务整行不可清 —— 清掉正在跑的任务目录会让 worker 写盘失败
            entry.reclaim_bytes = 0;
        }
        out.push(entry);
    }
    out
}

/// 五种存储的唯一分派点。**两个视图都必须经这里取数** ——
/// 按类型和按漫画各写一遍遍历，迟早会算出两个不同的数字，而用户无法判断哪个是真的。
fn collect_one_group(
    cfg: &AppConfig,
    id: CacheGroupId,
    ctx: &CacheContext,
    index: &BookIndex,
) -> Vec<CacheEntry> {
    match id {
        CacheGroupId::Mobi => collect_book_dir_entries(&cfg.mobi_cache_dir(), id, index),
        CacheGroupId::Reader => collect_book_dir_entries(&cfg.reader_dir(), id, index),
        CacheGroupId::ReaderEnhance => {
            collect_book_dir_entries(&cfg.reader_enhance_dir(), id, index)
        }
        CacheGroupId::Covers => collect_cover_entries(cfg, ctx, index),
        CacheGroupId::Jobs => collect_job_entries(cfg, ctx, index),
    }
}

/// 缓存页主视图的固定顺序（也是 `collect_overview` 的顺序）。
pub const CACHE_GROUP_ORDER: [CacheGroupId; 5] = [
    CacheGroupId::Mobi,
    CacheGroupId::Reader,
    CacheGroupId::ReaderEnhance,
    CacheGroupId::Covers,
    CacheGroupId::Jobs,
];

/// 列出一个分组里**按漫画**的占用明细。体积大的排前面。
///
/// 全树递归遍历，**必须**放在 blocking 线程里调用（与 `collect_overview` 同理）。
pub fn collect_group_entries(
    cfg: &AppConfig,
    id: CacheGroupId,
    ctx: &CacheContext,
    books: &[CacheBookRef],
) -> Vec<CacheEntry> {
    let index = BookIndex::build(books.to_vec());
    let mut out = collect_one_group(cfg, id, ctx, &index);
    // 占地方的在前面；同样大小时按 key 稳定排序（否则每次刷新顺序都在跳）
    out.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.key.cmp(&b.key)));
    out
}

/// 把五类缓存**转置**成"按书"的主视图：一行 = 一本漫画占用的全部缓存。
///
/// 复用 `collect_one_group`（与按类型视图同一份实现），所以两个视图的数字
/// **结构上必然一致**，不依赖人工对齐两处过滤条件。
///
/// 排序：已归属的书在前（体积降序，同体积按键升序以求稳定）；
/// 未归属的项殿后 —— 它们不是漫画，混进书单里只会让人以为多了几本奇怪的书。
/// 且每一项**独立成行**：它们之间没有共同的书 id，捏成一行用户就不知道清的是什么了。
pub fn collect_book_entries(
    cfg: &AppConfig,
    ctx: &CacheContext,
    books: &[CacheBookRef],
) -> Vec<BookCacheEntry> {
    let index = BookIndex::build(books.to_vec());

    let mut rows: Vec<BookCacheEntry> = Vec::new();
    // 已归属的书 → 行下标。未归属的项不进这张表（各自独立成行）
    let mut slot: HashMap<String, usize> = HashMap::new();

    for group in CACHE_GROUP_ORDER {
        for e in collect_one_group(cfg, group, ctx, &index) {
            // `collect_job_entries` 对在途任务已把 reclaim 调成 0；这里如实标注原因。
            // 必须在 `e.key` 被移进 `part` 之前算好，否则是一次"移动后再借用"。
            let busy = group == CacheGroupId::Jobs && ctx.protected_jobs.contains(&e.key);
            // 未归属的行没有书 id，用"类型 + 键"当标识
            let unknown_key = format!("{}:{}", group.as_str(), e.key);
            let part = BookCachePart {
                group,
                key: e.key,
                bytes: e.bytes,
                files: e.files,
                reclaim_bytes: e.reclaim_bytes,
                last_used: e.last_used,
                busy,
            };
            // 先取出需要的字段，`e.key` 已经移进 `part`
            let (book_id, title, source, source_missing) =
                (e.book_id, e.title, e.source, e.source_missing);

            let Some(book_id) = book_id else {
                rows.push(BookCacheEntry {
                    key: unknown_key,
                    book_id: None,
                    title: None,
                    source,
                    source_missing,
                    bytes: part.bytes,
                    files: part.files,
                    reclaim_bytes: part.reclaim_bytes,
                    busy: part.busy,
                    last_used: part.last_used,
                    parts: vec![part],
                });
                continue;
            };

            match slot.get(&book_id) {
                Some(&i) => {
                    let row = &mut rows[i];
                    row.bytes = row.bytes.saturating_add(part.bytes);
                    row.files = row.files.saturating_add(part.files);
                    row.reclaim_bytes = row.reclaim_bytes.saturating_add(part.reclaim_bytes);
                    row.busy |= part.busy;
                    row.last_used = match (row.last_used, part.last_used) {
                        (Some(a), Some(b)) => Some(a.max(b)),
                        (a, b) => a.or(b),
                    };
                    row.parts.push(part);
                }
                None => {
                    slot.insert(book_id.clone(), rows.len());
                    rows.push(BookCacheEntry {
                        key: book_id.clone(),
                        book_id: Some(book_id),
                        title,
                        source,
                        source_missing,
                        bytes: part.bytes,
                        files: part.files,
                        reclaim_bytes: part.reclaim_bytes,
                        busy: part.busy,
                        last_used: part.last_used,
                        parts: vec![part],
                    });
                }
            }
        }
    }

    rows.sort_by(|a, b| {
        a.book_id
            .is_none()
            .cmp(&b.book_id.is_none())
            .then_with(|| b.bytes.cmp(&a.bytes))
            .then_with(|| a.key.cmp(&b.key))
    });
    rows
}

/// 目录名可以直接拼进路径的三个分组才需要这个校验；
/// 封面是按 `read_dir` 遍历出来的文件名匹配，不经路径拼接。
fn safe_entry_key(key: &str) -> bool {
    !key.is_empty()
        && key != "."
        && key != ".."
        && !key.contains('/')
        && !key.contains('\\')
        && !key.contains('\0')
}

/// 清掉某一个分组里的**单本**缓存。语义与 `clear_group` 保持一致，
/// 只是作用范围收窄到一行：在用的封面仍保留、在途的任务仍拒绝。
pub fn clear_entry(
    cfg: &AppConfig,
    id: CacheGroupId,
    key: &str,
    ctx: &CacheContext,
) -> AppResult<CacheClearResult> {
    if id == CacheGroupId::Jobs {
        // 与整组清理同理：必须经 Scheduler（uuid 校验 + 活跃保护 + 防目录复活）
        return Err(crate::error::AppError::invalid(
            "任务目录必须经 Scheduler 清理",
        ));
    }
    if !safe_entry_key(key) {
        return Err(crate::error::AppError::invalid("非法的缓存条目名"));
    }

    let result = match id {
        CacheGroupId::Mobi => {
            // 只认自己生成的形状，避免把构建残留 `tmp-*` 或手放的文件当成缓存删掉
            if crate::ebook::mobi_cache_dir_prefix(key).is_none() {
                return Err(crate::error::AppError::invalid("不是 mobi 缓存目录"));
            }
            remove_paths(&[cfg.mobi_cache_dir().join(key)])
        }
        CacheGroupId::Reader => remove_paths(&[cfg.reader_dir().join(key)]),
        // 单清一本时目录本体往往还有别的书在用，不需要重建根目录
        CacheGroupId::ReaderEnhance => remove_paths(&[cfg.reader_enhance_dir().join(key)]),
        CacheGroupId::Covers => {
            let root = cfg.library_covers_dir();
            let paths: Vec<PathBuf> = child_paths(&root)
                .into_iter()
                .filter(|p| {
                    p.file_name()
                        .map(|n| {
                            let n = n.to_string_lossy().into_owned();
                            n.split('.').next() == Some(key)
                                && !ctx.referenced_covers.contains(&n)
                        })
                        .unwrap_or(false)
                })
                .collect();
            remove_paths(&paths)
        }
        CacheGroupId::Jobs => unreachable!("已在上面提前返回"),
    };
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cfg_at(root: &Path) -> AppConfig {
        AppConfig {
            work_root: root.to_path_buf(),
            ..Default::default()
        }
    }

    fn write_file(p: &Path, bytes: usize) {
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(p, vec![0u8; bytes]).unwrap();
    }

    #[test]
    fn overview_counts_each_group_and_ignores_mobi_tmp() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = cfg_at(tmp.path());

        write_file(&cfg.mobi_cache_dir().join("mobi-abc-1-2").join("00000.img"), 300);
        write_file(&cfg.mobi_cache_dir().join("mobi-def-1-2").join("00000.img"), 100);
        // 构建残留不得计入
        write_file(&cfg.mobi_cache_dir().join("tmp-123-abc").join("00000.img"), 999);
        write_file(&cfg.reader_dir().join("book01").join("0000.ab.jpg"), 50);
        write_file(&cfg.library_covers_dir().join("a.v7.jpg"), 10);
        std::fs::create_dir_all(cfg.jobs_dir()).unwrap();

        let ctx = CacheContext::default();
        let o = collect_overview(&cfg, &ctx);
        let find = |id: CacheGroupId| o.groups.iter().find(|g| g.id == id).unwrap().clone();

        let mobi = find(CacheGroupId::Mobi);
        assert_eq!(mobi.bytes, 400, "tmp-* 不得计入 mobi 缓存体积");
        assert_eq!(mobi.entries, 2);
        assert_eq!(mobi.kind, CacheGroupKind::Pure);

        let reader = find(CacheGroupId::Reader);
        assert_eq!(reader.bytes, 50);
        assert_eq!(reader.entries, 1);

        // covers：只有 a.v7.jpg 一个文件，但它没被任何书库条目引用 → 整组都是可回收的
        let covers = find(CacheGroupId::Covers);
        assert_eq!(covers.files, 1);
        assert_eq!(covers.reclaim_bytes, 10);
        assert_eq!(covers.kind, CacheGroupKind::Mixed);

        assert_eq!(o.total_bytes, 400 + 50 + 10);
        assert_eq!(o.reclaimable_bytes, 400 + 50 + 10);
    }

    #[test]
    fn covers_only_reclaim_unreferenced_files() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = cfg_at(tmp.path());
        write_file(&cfg.library_covers_dir().join("keep.v7.jpg"), 400);
        write_file(&cfg.library_covers_dir().join("keep.v2.jpg"), 30);
        write_file(&cfg.library_covers_dir().join("dead.v3.jpg"), 70);

        let mut referenced = HashSet::new();
        referenced.insert("keep.v7.jpg".to_string());

        let ctx = CacheContext {
            referenced_covers: referenced,
            ..Default::default()
        };
        let covers = collect_overview(&cfg, &ctx)
            .groups
            .into_iter()
            .find(|g| g.id == CacheGroupId::Covers)
            .unwrap();

        assert_eq!(covers.bytes, 500, "总量含所有文件");
        assert_eq!(covers.reclaim_bytes, 100, "只回收未被引用的两个");

        let r = clear_group(&cfg, CacheGroupId::Covers, &ctx).unwrap();
        assert_eq!(r.removed, 2);
        assert_eq!(r.bytes_freed, 100);
        assert!(cfg.library_covers_dir().join("keep.v7.jpg").is_file());
        assert!(
            !cfg.library_covers_dir().join("keep.v2.jpg").exists(),
            "被引用的旧 tag 封面也必须保留 —— refresh_covers 支持旧路径"
        );
    }

    #[test]
    fn jobs_reclaim_excludes_protected_and_marks_busy() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = cfg_at(tmp.path());
        write_file(&cfg.jobs_dir().join("running").join("in/0001.png"), 200);
        write_file(&cfg.jobs_dir().join("done").join("out/0001.png"), 80);

        let mut protected = HashSet::new();
        protected.insert("running".to_string());
        let ctx = CacheContext {
            protected_jobs: protected,
            ..Default::default()
        };
        let jobs = collect_overview(&cfg, &ctx)
            .groups
            .into_iter()
            .find(|g| g.id == CacheGroupId::Jobs)
            .unwrap();

        assert_eq!(jobs.bytes, 280, "总量含活跃任务");
        assert_eq!(jobs.reclaim_bytes, 80, "只回收非活跃的");
        assert!(jobs.busy, "有活跃任务时整组禁用");

        // 空闲时应可清理
        let idle = collect_overview(&cfg, &CacheContext::default())
            .groups
            .into_iter()
            .find(|g| g.id == CacheGroupId::Jobs)
            .unwrap();
        assert!(!idle.busy);
        assert_eq!(idle.reclaim_bytes, 280);
    }

    #[test]
    fn clear_mobi_keeps_tmp_and_reader_enhance_keeps_root() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = cfg_at(tmp.path());
        write_file(&cfg.mobi_cache_dir().join("mobi-abc-1-2").join("00000.img"), 300);
        write_file(&cfg.mobi_cache_dir().join("tmp-x").join("00000.img"), 20);
        let r = clear_group(&cfg, CacheGroupId::Mobi, &CacheContext::default()).unwrap();
        assert_eq!(r.bytes_freed, 300);
        assert!(
            cfg.mobi_cache_dir().join("tmp-x").is_dir(),
            "构建中的 tmp 不能被缓存清理扫掉"
        );

        write_file(&cfg.reader_enhance_dir().join("k/page.jpg"), 40);
        let r = clear_group(&cfg, CacheGroupId::ReaderEnhance, &CacheContext::default()).unwrap();
        assert_eq!(r.bytes_freed, 40);
        assert!(
            cfg.reader_enhance_dir().is_dir(),
            "增强缓存目录本体要保留（ensure_dirs 会建，下游假定存在）"
        );
    }

    #[test]
    fn jobs_cannot_be_cleared_through_the_disk_path() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = cfg_at(tmp.path());
        assert!(clear_group(&cfg, CacheGroupId::Jobs, &CacheContext::default()).is_err());
    }

    // ---------------------------------------------------------------- 按漫画归属

    fn book(id: &str, path: &str, title: &str) -> CacheBookRef {
        CacheBookRef {
            id: id.into(),
            path: path.into(),
            title: title.into(),
            job_id: None,
            source_missing: false,
        }
    }

    /// 用生产函数生成合法的 mobi 目录名，避免测试自己拼格式
    fn mobi_dir_name(path: &str, len: u64, mtime: u64) -> String {
        let prefix = crate::ebook::mobi_cache_key_prefix(Path::new(path));
        format!("mobi-{prefix}-{len}-{mtime}")
    }

    #[test]
    fn mobi_entries_are_attributed_by_recomputed_path_hash_not_by_id() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = cfg_at(tmp.path());

        // 故意让 id 与路径哈希毫无关系 —— 真实书库里 `id` 是历史值，
        // 实测 13 个真目录里有 2 个的前缀**不在任何 id 前 12 位里**。
        // 如果实现改去用 id 匹配，这条断言就会挂。
        let b = book("ffffffffffffffff", "/Books/海街diary 卷01.mobi", "海街diary 卷01");
        let name = mobi_dir_name(&b.path, 1234, 5678);
        write_file(&cfg.mobi_cache_dir().join(&name).join("00000.img"), 700);
        // 形状合法但书库里找不到对应书的目录
        write_file(
            &cfg.mobi_cache_dir().join("mobi-aaaaaaaabbbb-1-2").join("00000.img"),
            30,
        );

        let entries =
            collect_group_entries(&cfg, CacheGroupId::Mobi, &CacheContext::default(), &[b]);

        assert_eq!(entries.len(), 2);
        // 体积大的排前面
        assert_eq!(entries[0].key, name);
        assert_eq!(entries[0].title.as_deref(), Some("海街diary 卷01"));
        assert_eq!(entries[0].book_id.as_deref(), Some("ffffffffffffffff"));
        assert_eq!(entries[0].bytes, 700);
        assert_eq!(entries[0].files, 1);
        // 归属不到的必须**如实列出**：藏起来的话用户就永远清不掉它
        assert!(entries[1].title.is_none(), "未知目录不能被隐藏");
        assert!(entries[1].book_id.is_none());
        assert_eq!(entries[1].bytes, 30);
    }

    #[test]
    fn entry_sums_match_the_overview_for_book_dir_groups() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = cfg_at(tmp.path());
        let b = book("id1", "/Books/a.mobi", "a");
        write_file(&cfg.mobi_cache_dir().join(&mobi_dir_name(&b.path, 1, 2)).join("p"), 400);
        write_file(&cfg.mobi_cache_dir().join("mobi-1234567890ab-1-2").join("p"), 100);
        // 构建残留：总览不算，明细也不该算
        write_file(&cfg.mobi_cache_dir().join("tmp-zzz").join("p"), 999);

        let overview = collect_overview(&cfg, &CacheContext::default());
        let mobi = overview
            .groups
            .iter()
            .find(|g| g.id == CacheGroupId::Mobi)
            .unwrap()
            .clone();
        let entries =
            collect_group_entries(&cfg, CacheGroupId::Mobi, &CacheContext::default(), &[b]);

        let sum: u64 = entries.iter().map(|e| e.bytes).sum();
        assert_eq!(sum, mobi.bytes, "明细之和必须等于总览行的体积，否则页面在骗人");
        assert_eq!(entries.len() as u32, mobi.entries);
    }

    #[test]
    fn clear_entry_removes_only_the_target_book() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = cfg_at(tmp.path());
        let target = mobi_dir_name("/Books/target.mobi", 9, 9);
        let keep = mobi_dir_name("/Books/keep.mobi", 9, 9);
        write_file(&cfg.mobi_cache_dir().join(&target).join("p"), 700);
        write_file(&cfg.mobi_cache_dir().join(&keep).join("p"), 200);
        write_file(&cfg.mobi_cache_dir().join("tmp-build").join("p"), 50);

        let r = clear_entry(&cfg, CacheGroupId::Mobi, &target, &CacheContext::default()).unwrap();

        assert_eq!(r.removed, 1);
        assert_eq!(r.bytes_freed, 700);
        assert!(!cfg.mobi_cache_dir().join(&target).exists());
        assert!(cfg.mobi_cache_dir().join(&keep).is_dir(), "不能连坐别的书");
        assert!(cfg.mobi_cache_dir().join("tmp-build").is_dir(), "构建残留不受影响");
    }

    #[test]
    fn clear_entry_refuses_traversal_and_foreign_shapes() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = cfg_at(tmp.path());
        write_file(&cfg.mobi_cache_dir().join("tmp-x").join("p"), 5);

        // 目录穿越：绝不能经 key 拼出 work_root 之外的路径
        assert!(clear_entry(&cfg, CacheGroupId::Mobi, "../evil", &CacheContext::default()).is_err());
        assert!(clear_entry(&cfg, CacheGroupId::Reader, "..", &CacheContext::default()).is_err());
        assert!(clear_entry(&cfg, CacheGroupId::Reader, "a/b", &CacheContext::default()).is_err());
        assert!(clear_entry(&cfg, CacheGroupId::Reader, "", &CacheContext::default()).is_err());

        // 形状不是我们生成的（构建残留）不能从缓存页删
        assert!(clear_entry(&cfg, CacheGroupId::Mobi, "tmp-x", &CacheContext::default()).is_err());
        assert!(cfg.mobi_cache_dir().join("tmp-x").is_dir());

        // 任务目录必须经 Scheduler
        assert!(clear_entry(&cfg, CacheGroupId::Jobs, "job-1", &CacheContext::default()).is_err());
    }

    #[test]
    fn cover_entries_exclude_the_in_use_cover_from_reclaim() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = cfg_at(tmp.path());
        write_file(&cfg.library_covers_dir().join("book1.v7.jpg"), 100);
        write_file(&cfg.library_covers_dir().join("book1.v2.jpg"), 40);
        write_file(&cfg.library_covers_dir().join("gone.v3.jpg"), 25);

        let mut referenced = HashSet::new();
        referenced.insert("book1.v7.jpg".to_string());
        let ctx = CacheContext {
            referenced_covers: referenced,
            ..Default::default()
        };

        let entries = collect_group_entries(
            &cfg,
            CacheGroupId::Covers,
            &ctx,
            &[book("book1", "/Books/b1.mobi", "某书")],
        );

        let b1 = entries.iter().find(|e| e.key == "book1").unwrap();
        assert_eq!(b1.title.as_deref(), Some("某书"));
        assert_eq!(b1.bytes, 140, "名义体积含在用的那张");
        assert_eq!(b1.reclaim_bytes, 40, "只有旧 tag 那张能回收 —— 在用封面删了会白删");

        let orphan = entries.iter().find(|e| e.key == "gone").unwrap();
        assert_eq!(orphan.reclaim_bytes, 25);
        assert!(orphan.title.is_none());

        // 明细口径必须与总览一致
        let covers = collect_overview(&cfg, &ctx)
            .groups
            .into_iter()
            .find(|g| g.id == CacheGroupId::Covers)
            .unwrap();
        assert_eq!(entries.iter().map(|e| e.bytes).sum::<u64>(), covers.bytes);
        assert_eq!(
            entries.iter().map(|e| e.reclaim_bytes).sum::<u64>(),
            covers.reclaim_bytes
        );

        // 单清 book1 只删它的旧 tag 那张
        let r = clear_entry(&cfg, CacheGroupId::Covers, "book1", &ctx).unwrap();
        assert_eq!(r.bytes_freed, 40);
        assert!(cfg.library_covers_dir().join("book1.v7.jpg").is_file());
        assert!(!cfg.library_covers_dir().join("book1.v2.jpg").exists());
        assert!(
            cfg.library_covers_dir().join("gone.v3.jpg").is_file(),
            "不能连坐别的书"
        );
    }

    #[test]
    fn job_entries_mark_active_jobs_as_not_reclaimable() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = cfg_at(tmp.path());
        write_file(&cfg.jobs_dir().join("job-a").join("out/0001.png"), 60);
        write_file(&cfg.jobs_dir().join("job-b").join("out/0001.png"), 90);

        let mut b = book("bk", "/Books/b.mobi", "某书");
        b.job_id = Some("job-b".to_string());
        let mut protected = HashSet::new();
        protected.insert("job-a".to_string());
        let ctx = CacheContext {
            protected_jobs: protected,
            ..Default::default()
        };

        let entries = collect_group_entries(&cfg, CacheGroupId::Jobs, &ctx, &[b]);
        let a = entries.iter().find(|e| e.key == "job-a").unwrap();
        let b2 = entries.iter().find(|e| e.key == "job-b").unwrap();
        assert_eq!(a.reclaim_bytes, 0, "在途任务不能清");
        assert_eq!(a.bytes, 60);
        assert_eq!(b2.reclaim_bytes, 90);
        assert_eq!(b2.title.as_deref(), Some("某书"), "按 job_id 归属回书名");
    }

    #[test]
    fn book_view_is_the_transpose_of_the_type_view() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = cfg_at(tmp.path());

        // 同一本书在 mobi / reader / covers 三类里都有缓存 —— 必须卷成一行
        let b = book("id1", "/Books/a.mobi", "a");
        write_file(
            &cfg.mobi_cache_dir().join(&mobi_dir_name(&b.path, 1, 2)).join("p"),
            400,
        );
        let rkey = crate::reader::source_cache_key(Path::new(&b.path));
        write_file(&cfg.reader_dir().join(&rkey).join("p"), 200);
        write_file(&cfg.library_covers_dir().join("id1.v7.jpg"), 50);
        write_file(&cfg.library_covers_dir().join("id1.v2.jpg"), 10); // 旧 tag 孤儿

        let c = book("id2", "/Books/c.mobi", "c");
        write_file(
            &cfg.mobi_cache_dir().join(&mobi_dir_name(&c.path, 3, 4)).join("p"),
            300,
        );

        // 归属不到书、但**必须如实列出**的一项
        write_file(
            &cfg.mobi_cache_dir().join("mobi-1234567890ab-1-2").join("p"),
            70,
        );

        let mut referenced = HashSet::new();
        referenced.insert("id1.v7.jpg".to_string());
        let ctx = CacheContext {
            referenced_covers: referenced,
            ..Default::default()
        };
        let books = vec![b, c];
        let rows = collect_book_entries(&cfg, &ctx, &books);

        // 已归属的两本在前（体积降序），未归属的殿后
        assert_eq!(rows.len(), 3);
        let r0 = &rows[0];
        assert_eq!(r0.key, "id1", "已归属的行标识就是书 id");
        assert_eq!(r0.book_id.as_deref(), Some("id1"));
        assert_eq!(r0.title.as_deref(), Some("a"));
        assert_eq!(r0.bytes, 400 + 200 + 60, "三类必须卷成一行");
        assert_eq!(r0.files, 4);
        assert_eq!(r0.reclaim_bytes, 400 + 200 + 10, "在用封面不计入可回收");
        assert_eq!(r0.parts.len(), 3);
        assert!(!r0.busy);

        assert_eq!(rows[1].book_id.as_deref(), Some("id2"));
        assert_eq!(rows[1].bytes, 300);
        assert_eq!(rows[1].reclaim_bytes, 300);

        let unknown = &rows[2];
        assert!(unknown.book_id.is_none(), "未归属必须排出，不能藏");
        assert!(unknown.title.is_none());
        assert_eq!(unknown.key, "mobi:mobi-1234567890ab-1-2", "未归属的行标识由服务端给出");
        assert_eq!(unknown.bytes, 70);
        assert_eq!(unknown.parts.len(), 1, "未归属项之间没有共同的书 id，必须各自成行");
        assert_eq!(unknown.parts[0].group, CacheGroupId::Mobi);
        assert_eq!(unknown.parts[0].key, "mobi-1234567890ab-1-2");

        // 转置恒等式：按书的合计必须等于按类型的合计。
        // 两个视图若各写一遍遍历，这里迟早会对不上，而用户没法判断哪个是真的。
        let per_type_bytes: u64 = CACHE_GROUP_ORDER
            .iter()
            .map(|g| {
                collect_group_entries(&cfg, *g, &ctx, &books)
                    .iter()
                    .map(|e| e.bytes)
                    .sum::<u64>()
            })
            .sum();
        let per_type_reclaim: u64 = CACHE_GROUP_ORDER
            .iter()
            .map(|g| {
                collect_group_entries(&cfg, *g, &ctx, &books)
                    .iter()
                    .map(|e| e.reclaim_bytes)
                    .sum::<u64>()
            })
            .sum();
        assert_eq!(
            rows.iter().map(|r| r.bytes).sum::<u64>(),
            per_type_bytes,
            "按书合计必须等于按类型合计"
        );
        assert_eq!(
            rows.iter().map(|r| r.reclaim_bytes).sum::<u64>(),
            per_type_reclaim
        );
    }

    #[test]
    fn book_row_is_busy_when_its_job_is_in_flight() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = cfg_at(tmp.path());

        let mk = || {
            let mut b = book("id1", "/Books/a.mobi", "a");
            b.job_id = Some("job-live".to_string());
            b
        };
        write_file(&cfg.jobs_dir().join("job-live").join("out/p"), 500);
        write_file(
            &cfg.mobi_cache_dir().join(&mobi_dir_name("/Books/a.mobi", 1, 2)).join("p"),
            100,
        );

        let mut protected = HashSet::new();
        protected.insert("job-live".to_string());
        let busy = collect_book_entries(
            &cfg,
            &CacheContext {
                protected_jobs: protected,
                ..Default::default()
            },
            &[mk()],
        );
        assert_eq!(busy.len(), 1);
        assert_eq!(busy[0].bytes, 600, "在途任务的占用仍要如实显示，不能瞒着用户");
        assert!(busy[0].busy, "在途任务必须让整本清理禁用");
        assert_eq!(
            busy[0].reclaim_bytes, 100,
            "只把在途那一项排除，这本书其余缓存仍可回收"
        );
        let job_part = busy[0]
            .parts
            .iter()
            .find(|p| p.group == CacheGroupId::Jobs)
            .unwrap();
        assert!(job_part.busy);
        assert_eq!(job_part.reclaim_bytes, 0);

        // 任务结束后同一本书整本可回收
        let idle = collect_book_entries(&cfg, &CacheContext::default(), &[mk()]);
        assert!(!idle[0].busy);
        assert_eq!(idle[0].reclaim_bytes, 600);
    }
}
