import { stateLabel, type Messages } from "../i18n";
import type { DiskEstimate, JobStatus, ValidateResult } from "../types";
import {
  formatBytes,
  startBlockReason,
  type Container,
  type ImgFmt,
} from "./enhanceViewModel";

type Props = {
  i18n: Messages;
  estimate: DiskEstimate | null;
  outputDir: string | null;
  container: Container;
  imageFormat: ImgFmt;
  source: string | null;
  sourceLoading: boolean;
  validation: ValidateResult | null;
  estimateLoading: boolean;
  engineReady: boolean;
  canStart: boolean;
  busy: boolean;
  /** 任务创建成功的轻反馈（约 3 秒） */
  taskCreated?: boolean;
  /** 当前源文件对应的进行中任务：切换底部栏为进度模式 */
  activeJob: JobStatus | null;
  onStart: () => void;
  onOpenReader: () => void;
  onOpenQueue: () => void;
  onCancelJob: (id: string) => void;
};

function containerLabel(i18n: Messages, c: Container): string {
  if (c === "cbz") return i18n.containerCbz;
  if (c === "zip") return i18n.containerZip;
  return i18n.containerFolder;
}

function imageFormatLabel(i18n: Messages, f: ImgFmt): string {
  if (f === "jpeg") return i18n.formatJpeg;
  if (f === "png") return i18n.formatPng;
  if (f === "webp") return i18n.formatWebp;
  return i18n.formatSame;
}

/** 底部固定操作栏：资源预估 + 不可用原因 + 提交；任务进行时切换为进度条 */
export function EnhanceSummaryBar({
  i18n,
  estimate,
  outputDir,
  container,
  imageFormat,
  source,
  sourceLoading,
  validation,
  estimateLoading,
  engineReady,
  canStart,
  busy,
  taskCreated = false,
  activeJob,
  onStart,
  onOpenReader,
  onOpenQueue,
  onCancelJob,
}: Props) {
  const blockReason = startBlockReason({
    i18n,
    source,
    sourceLoading,
    validation,
    estimateLoading,
    outputDir,
    estimate,
    busy,
    engineReady,
  });
  const job = activeJob;
  // 防御 IPC 偶发漏改名的 snake_case 字段
  const rawJob = job as (JobStatus & { pages_done?: number; pages_total?: number }) | null;
  const pagesDone = job?.pagesDone ?? rawJob?.pages_done ?? 0;
  const pagesTotal = job?.pagesTotal ?? rawJob?.pages_total ?? 0;
  const pct = pagesTotal > 0 ? Math.round((pagesDone / pagesTotal) * 100) : 0;

  const taskCreatedChip = taskCreated ? (
    <span className="rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success dark:text-emerald-100">
      {i18n.taskCreated}
    </span>
  ) : null;

  return (
    <footer className="card shrink-0 flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
      {job ? (
        <>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
              </span>
              <p className="text-sm font-medium text-ink-900 dark:text-fg">
                {i18n.enhancingLabel} · {pagesDone} / {pagesTotal} {i18n.pages}
              </p>
              {taskCreatedChip}
              <span className="rounded-md border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-ink-700 dark:text-fg">
                {stateLabel(String(job.state ?? "").toLowerCase())}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ink-200 dark:bg-surface-high">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
          <button type="button" className="btn-ghost !py-2" onClick={onOpenQueue}>
            {i18n.showQueue}
          </button>
          {job.jobId && (
            <button
              type="button"
              className="btn !py-2 border border-rose-400/40 bg-rose-500/10 text-rose-700 hover:bg-rose-500/20 dark:text-rose-200"
              onClick={() => job.jobId && onCancelJob(job.jobId)}
            >
              {i18n.cancel}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-500 dark:text-fg-muted">
            <span>
              {i18n.estUsage}{" "}
              <b
                className={`font-semibold tabular-nums ${
                  estimate && !estimate.ok
                    ? "text-rose-700 dark:text-rose-300"
                    : "text-ink-800 dark:text-fg"
                }`}
              >
                {estimate ? formatBytes(estimate.estimateBytes) : "—"}
              </b>
            </span>
            <span>
              {i18n.freeSpaceLabel}{" "}
              <b className="font-semibold tabular-nums text-ink-800 dark:text-fg">
                {estimate ? formatBytes(estimate.freeBytes) : "—"}
              </b>
            </span>
            {outputDir && (
              <span>
                {i18n.outputLabel}{" "}
                <b className="font-semibold text-ink-800 dark:text-fg">
                  {containerLabel(i18n, container)} · {imageFormatLabel(i18n, imageFormat)}
                </b>
              </span>
            )}
          </div>
          {blockReason && (
            <p className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
              <svg
                viewBox="0 0 20 20"
                className="h-3.5 w-3.5 shrink-0"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M10 3.2 18.3 17H1.7L10 3.2Z" />
                <path d="M10 8v3.6" strokeLinecap="round" />
                <circle cx="10" cy="14.4" r="0.25" fill="currentColor" stroke="none" />
              </svg>
              {blockReason}
            </p>
          )}
          {taskCreatedChip}
          <button
            type="button"
            className="btn-ghost !py-2"
            disabled={!source}
            onClick={onOpenReader}
          >
            {i18n.previewOriginal}
          </button>
          <button
            type="button"
            className="btn-accent !py-2 !px-6 text-base"
            disabled={!canStart}
            onClick={onStart}
          >
            {busy ? "…" : i18n.start}
          </button>
        </>
      )}
    </footer>
  );
}
