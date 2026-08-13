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
  estimateBytes: number;
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
  candidates: LibraryScanCandidate[];
};

export type LibraryScanResult = {
  added: number;
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
  kind: "original" | "enhanced" | "missing" | string;
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
  kind: "original" | "enhanced" | "missing" | string;
  path: string;
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
