import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CreateJobRequest,
  CreateJobResult,
  DiskEstimate,
  ResumeHint,
  DoctorReport,
  EngineInfo,
  EngineStatus,
  GpuInfo,
  JobStatus,
  LibraryEntry,
  LibraryScanPreview,
  LibraryScanResult,
  PreviewResult,
  ReaderEnhanceOptions,
  EnhanceCacheClearResult,
  EnhanceCacheStats,
  ReaderPageFile,
  ReaderState,
  ValidateResult,
} from "./types";

/**
 * Tauri 2 maps Rust snake_case command args ↔ JS camelCase automatically.
 * Always pass camelCase keys from the frontend (jobId, pageIndex, outDir, …).
 */

/** 后端 AppError 的 IPC 形态（error.rs 派生 Serialize） */
export type AppIpcError = { code: string; message: string; detail?: string };

const CANCELLED_TEXT = "任务已取消";

/**
 * 归一化 invoke 错误。兼容三种形态：
 * 1. 后端序列化的 `{code,message,detail}` 对象（当前）
 * 2. 包装层把对象塞进 `{message: "<json 字符串>"}`（迁移期）
 * 3. 纯字符串
 */
export function asAppError(e: unknown): AppIpcError {
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    if (typeof o.code === "string" && typeof o.message === "string") {
      return {
        code: o.code,
        message: o.message,
        ...(typeof o.detail === "string" ? { detail: o.detail } : {}),
      };
    }
    if (typeof o.message === "string") {
      try {
        const p = JSON.parse(o.message) as Record<string, unknown>;
        if (p && typeof p.code === "string" && typeof p.message === "string") {
          return {
            code: p.code,
            message: p.message,
            ...(typeof p.detail === "string" ? { detail: p.detail } : {}),
          };
        }
      } catch {
        /* plain text message */
      }
      return { code: "UNKNOWN", message: o.message };
    }
  }
  return { code: "UNKNOWN", message: typeof e === "string" ? e : String(e) };
}

export function errorMessage(e: unknown): string {
  return asAppError(e).message;
}

export function isCancelledError(e: unknown): boolean {
  const err = asAppError(e);
  return err.code === "CANCELLED" || err.message.startsWith(CANCELLED_TEXT);
}

export async function createJob(req: CreateJobRequest): Promise<CreateJobResult> {
  return invoke("create_job", { req });
}

export async function probeResume(path: string): Promise<ResumeHint | null> {
  return invoke("probe_resume", { path });
}

export async function cancelJob(jobId: string): Promise<void> {
  return invoke("cancel_job", { jobId });
}

export async function getJob(jobId: string): Promise<JobStatus> {
  return invoke("get_job", { jobId });
}

export async function listJobs(): Promise<JobStatus[]> {
  return invoke("list_jobs");
}

export async function validateSource(path: string): Promise<ValidateResult> {
  return invoke("validate_source", { path });
}

export async function estimateDisk(path: string, scale: number): Promise<DiskEstimate> {
  return invoke("estimate_disk_usage", { path, scale });
}

export async function listGpus(): Promise<GpuInfo[]> {
  return invoke("list_gpus");
}

export async function getEngineStatus(): Promise<EngineStatus> {
  return invoke("get_engine_status");
}

export async function listEngines(): Promise<EngineInfo[]> {
  return invoke("list_engines");
}

export async function getReaderState(opts: {
  jobId?: string | null;
  source?: string | null;
}): Promise<ReaderState> {
  return invoke("get_reader_state", {
    jobId: opts.jobId ?? null,
    source: opts.source ?? null,
  });
}

export async function prepareReaderPage(opts: {
  jobId?: string | null;
  source?: string | null;
  pageIndex: number;
}): Promise<ReaderPageFile> {
  return invoke("prepare_reader_page", {
    jobId: opts.jobId ?? null,
    source: opts.source ?? null,
    pageIndex: opts.pageIndex,
  });
}

export async function prepareReaderPages(opts: {
  jobId?: string | null;
  source?: string | null;
  pageIndexes: number[];
  preferOriginal?: boolean;
}): Promise<ReaderPageFile[]> {
  if (opts.pageIndexes.length === 0) return [];
  return invoke("prepare_reader_pages", {
    jobId: opts.jobId ?? null,
    source: opts.source ?? null,
    pageIndexes: opts.pageIndexes,
    preferOriginal: opts.preferOriginal ?? false,
  });
}

function enhanceOptsPayload(options?: ReaderEnhanceOptions) {
  if (!options) return null;
  return {
    preset: options.preset,
    scale: options.scale,
    noiseLevel: options.noiseLevel,
    tta: options.tta,
    engine: options.engine,
    cuganModel: options.cuganModel,
  };
}

export async function enhanceReaderPages(opts: {
  source?: string | null;
  jobId?: string | null;
  pageIndexes: number[];
  options?: ReaderEnhanceOptions;
}): Promise<ReaderPageFile[]> {
  if (opts.pageIndexes.length === 0) return [];
  return invoke("enhance_reader_pages", {
    source: opts.source ?? null,
    jobId: opts.jobId ?? null,
    pageIndexes: opts.pageIndexes,
    options: enhanceOptsPayload(opts.options),
  });
}

export async function lookupReaderEnhancePages(opts: {
  source?: string | null;
  jobId?: string | null;
  pageIndexes: number[];
  options?: ReaderEnhanceOptions;
}): Promise<ReaderPageFile[]> {
  if (opts.pageIndexes.length === 0) return [];
  return invoke("lookup_reader_enhance_pages", {
    source: opts.source ?? null,
    jobId: opts.jobId ?? null,
    pageIndexes: opts.pageIndexes,
    options: enhanceOptsPayload(opts.options),
  });
}

export async function readerEnhanceCacheStats(): Promise<EnhanceCacheStats> {
  return invoke("reader_enhance_cache_stats");
}

export async function clearReaderEnhanceCache(): Promise<EnhanceCacheClearResult> {
  return invoke("clear_reader_enhance_cache");
}

export async function cancelReaderEnhance(): Promise<void> {
  return invoke("cancel_reader_enhance");
}

export async function listLibrary(): Promise<LibraryEntry[]> {
  return invoke("list_library");
}

export async function addLibraryPath(path: string): Promise<LibraryEntry> {
  return invoke("add_library_path", { path });
}

/** 领取启动时外部打开的路径（一次性） */
export async function takePendingOpenPaths(): Promise<string[]> {
  return invoke("take_pending_open_paths");
}

/** 校验外部打开路径是否允许临时阅读 */
export async function validateExternalOpenPath(path: string): Promise<string> {
  return invoke("validate_external_open_path", { path });
}

export async function removeLibraryEntry(id: string): Promise<void> {
  return invoke("remove_library_entry", { id });
}

export async function previewLibraryScan(root: string): Promise<LibraryScanPreview> {
  return invoke("preview_library_scan", { root });
}

export async function importLibraryPaths(paths: string[]): Promise<LibraryScanResult> {
  return invoke("import_library_paths", { paths });
}

export async function touchLibrary(path: string, page?: number): Promise<void> {
  return invoke("touch_library", { path, page: page ?? null });
}

export async function previewPage(
  source: string,
  pageIndex: number,
  options?: {
    preset?: string;
    scale?: number;
    noiseLevel?: number;
    tta?: boolean;
    engine?: string;
    cuganModel?: string;
  },
): Promise<PreviewResult> {
  return invoke("preview_page", {
    source,
    pageIndex,
    options: options
      ? {
          preset: options.preset,
          scale: options.scale,
          noiseLevel: options.noiseLevel,
          tta: options.tta,
          engine: options.engine,
          cuganModel: options.cuganModel,
        }
      : null,
  });
}

export async function doctor(): Promise<DoctorReport> {
  return invoke("doctor");
}

export async function exportDiagnostics(outDir?: string): Promise<{ zipPath: string }> {
  return invoke("export_diagnostics", { outDir: outDir ?? null });
}

export async function openOutputFolder(jobId: string): Promise<void> {
  return invoke("open_output_folder", { jobId });
}

export async function clearFinishedJobs(): Promise<{ removed: number }> {
  return invoke("clear_finished_jobs");
}

export async function removeJob(jobId: string): Promise<void> {
  return invoke("remove_job", { jobId });
}

export async function onJobProgress(
  cb: (payload: {
    jobId: string;
    stage: string;
    pagesDone: number;
    pagesTotal: number;
  }) => void,
): Promise<UnlistenFn> {
  return listen("job://progress", (e) => {
    cb(
      e.payload as {
        jobId: string;
        stage: string;
        pagesDone: number;
        pagesTotal: number;
      },
    );
  });
}
