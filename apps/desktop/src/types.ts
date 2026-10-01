export type JobState =
  | "pending"
  | "validating"
  | "extracting"
  | "running"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelling"
  | "cancelled";

export type JobStatus = {
  jobId: string;
  state: JobState;
  source: string;
  outputPath?: string;
  pagesDone: number;
  pagesTotal: number;
  stage?: string;
  etaSec?: number;
  error?: { code: string; message: string; detail?: string };
  message?: string;
};

export type ValidateResult = {
  kind: string;
  pageCount: number;
  hasComicInfo: boolean;
  warnings: string[];
  pageNames: string[];
};

export type DiskEstimate = {
  /** 整本作业峰值占用（工作盘 in+out，加上导出物） */
  estimateBytes: number;
  /** 预计最终导出物体积 */
  outputBytes: number;
  freeBytes: number;
  ok: boolean;
  pageCount: number;
  message?: string;
};

export type EngineStatus = {
  id: string;
  available: boolean;
  detail: string;
  version?: string;
  threads?: string | null;
  mode?: string | null;
  isMock?: boolean;
};

export type EngineInfo = {
  id: string;
  label: string;
  available: boolean;
  detail: string;
  scales: number[];
  models: { id: string; label: string }[];
};

export type GpuInfo = {
  id: number;
  name: string;
  is_cpu: boolean;
};

export type CreateJobRequest = {
  source: string;
  engine?: string;
  preset: string;
  output: {
    dir: string;
    container: string;
    imageFormat: string;
    jpegQuality?: number;
    webpQuality?: number;
    naming?: string;
  };
  enhance?: {
    scale?: number;
    noiseLevel?: number;
    tta?: boolean;
    cuganModel?: string;
  };
};

export type ResumeHint = {
  jobId: string;
  pagesDone: number;
  pagesTotal: number;
  nextPage: number;
  source: string;
  message: string;
};

export type CreateJobResult = {
  jobId: string;
  resumed?: boolean;
  pagesDone?: number;
  pagesTotal?: number;
  nextPage?: number;
  /** 归一化后的实际生效参数（Real-CUGAN 会改写 scale/noise） */
  actualScale?: number;
  actualNoise?: number;
  actualCuganModel?: string;
};

export type LibraryCollection = {
  id: string;
  title: string;
  entryIds: string[];
  coverEntryId?: string;
};

export type LibraryIndex = {
  entries: LibraryEntry[];
  collections: LibraryCollection[];
};

export type LibraryEntry = {
  id: string;
  path: string;
  kind: string;
  title: string;
  pageCount: number;
  coverPath?: string;
  lastReadPage: number;
  addedAt: string;
  lastOpenedAt?: string;
  jobId?: string;
  enhanceState: string;
  outputPath?: string;
  missing: boolean;
};

export type LibraryScanCandidate = {
  path: string;
  title: string;
  kind: string;
  alreadyInLibrary: boolean;
};

export type LibraryScanPreview = {
  root: string;
  /** true = 命中访问/候选上限被截断，结果可能不完整 */
  truncated: boolean;
  candidates: LibraryScanCandidate[];
};

export type LibraryScanResult = {
  added: number;
  updated?: number;
  existed: number;
  skipped: number;
  failed: number;
  titles: string[];
  message: string;
};

export type ReaderPageMeta = {
  index: number;
  name: string;
  status: string;
  kind: "original" | "enhanced" | "missing" | (string & {});
};

export type ReaderState = {
  jobId?: string;
  source: string;
  title: string;
  pageCount: number;
  jobState?: string;
  pagesDone: number;
  pages: ReaderPageMeta[];
};

export type ReaderPageFile = {
  index: number;
  name: string;
  kind: "original" | "enhanced" | "missing" | (string & {});
  path: string;
};

export type EnhanceCacheStats = {
  bytes: number;
  files: number;
  maxBytes: number;
  maxFiles: number;
};

export type EnhanceCacheClearResult = {
  removed: number;
  bytesFreed: number;
};

export type ReaderEnhanceOptions = {
  preset?: string;
  scale?: number;
  noiseLevel?: number;
  tta?: boolean;
  engine?: string;
  cuganModel?: string;
};

export type PreviewResult = {
  pageIndex: number;
  pageName: string;
  beforeDataUrl: string;
  afterDataUrl: string;
  widthBefore: number;
  heightBefore: number;
  widthAfter: number;
  heightAfter: number;
  engine: string;
};

export type CacheGroupId = "mobi" | "reader" | "readerEnhance" | "covers" | "jobs";

/** `pure` = 删掉后下次使用自动重建；`mixed` = 只清"可以安全清的那部分" */
export type CacheGroupKind = "pure" | "mixed";

export type CacheGroupStats = {
  id: CacheGroupId;
  kind: CacheGroupKind;
  bytes: number;
  files: number;
  entries: number;
  /** 清理这一组**实际能回收多少** —— 不等于 bytes（封面只算孤儿、任务只算终态） */
  reclaimBytes: number;
  reclaimFiles: number;
  capBytes?: number;
  capEntries?: number;
  /** 有活跃的在途工作，此刻清理不安全 */
  busy: boolean;
};

export type CacheOverview = {
  groups: CacheGroupStats[];
  totalBytes: number;
  reclaimableBytes: number;
  freeBytes?: number;
};

export type CacheClearResult = {
  removed: number;
  bytesFreed: number;
};

/** 「某个分组里的某一本书」的占用 —— 缓存面板展开后的那一行。 */
export type CacheEntry = {
  /** 分组内这一行的标识（目录名 / 书的 id / 任务 id）。清理时原样传回。 */
  key: string;
  /** 归属到的书；null 表示磁盘上有这份缓存、但书库里找不到对应条目 */
  bookId?: string;
  title?: string;
  source?: string;
  /** 源文件已经不在磁盘上了 */
  sourceMissing: boolean;
  bytes: number;
  files: number;
  /** 这一行实际能回收多少。不等于 bytes（在用封面 / 在途任务要留下） */
  reclaimBytes: number;
  /** 最近使用时间（unix 秒） */
  lastUsed?: number;
};

/** 「这本书在某一类缓存里的占用」—— 整本清理时逐项走的就是这个列表。 */
export type BookCachePart = {
  group: CacheGroupId;
  /** 该类里的键（目录名 / 书 id / 任务 id）。清理时原样传回。 */
  key: string;
  bytes: number;
  files: number;
  /** 这一项实际能回收多少（封面留下在用的、任务留下在途的） */
  reclaimBytes: number;
  lastUsed?: number;
  /** 在途任务 —— 此刻清它会打断正在跑的工作 */
  busy: boolean;
};

/** 「一本漫画占用的全部缓存」—— 缓存面板**主视图**的一行。 */
export type BookCacheEntry = {
  /**
   * 这一行的稳定标识。已归属 = 书 id；未归属 = `{类型}:{该类里的键}`。
   * 由服务端给出 —— 前端自己再推一遍就会有两处"行标识"逻辑，展开状态会漂。
   */
  key: string;
  /** 归属到的书；null = 磁盘上有这份缓存、但书库里找不到对应的书（未归属） */
  bookId: string | null;
  title: string | null;
  source: string | null;
  sourceMissing: boolean;
  /** 全部类型加起来 */
  bytes: number;
  files: number;
  /** 整本清理实际能回收多少 = 各类型之和。为 0 时按钮就该是灰的。 */
  reclaimBytes: number;
  /** 这本书有在途任务 —— 整本清理会打断它，此刻必须禁用 */
  busy: boolean;
  lastUsed: number | null;
  /** 展开时显示的按类型拆分；至少一项 */
  parts: BookCachePart[];
};

/** 要清的那一项的引用 —— 前端把 `BookCachePart` 里的 group/key 原样回传。 */
export type CachePartRef = {
  group: CacheGroupId;
  key: string;
};

export type DoctorReport = {
  appVersion: string;
  engine: EngineStatus;
  gpus: GpuInfo[];
  workRoot: string;
  useMockEngine: boolean;
  os: string;
  arch: string;
  freeWorkBytes?: number;
  jobsOnDisk: number;
  timestamp: string;
  hostTarget: string;
  waifu2xBinary?: string;
  waifu2xModels?: string;
  waifu2xBundleFound: boolean;
  enhanceMode?: string;
  waifu2xJobs?: string;
  extractConcurrency?: number;
  unrarBinary?: string;
  unrarFound?: boolean;
};
