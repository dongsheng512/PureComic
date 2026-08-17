import { useState } from "react";
import type { Messages } from "../i18n";
import type { LibraryEntry, ResumeHint, ValidateResult } from "../types";
import { baseName, kindLabel, sourceMeta } from "./enhanceViewModel";

type Props = {
  i18n: Messages;
  source: string | null;
  entry: LibraryEntry | null;
  validation: ValidateResult | null;
  loading: boolean;
  dragOver: boolean;
  resumeHint: ResumeHint | null;
  onPickFile: () => void;
  onPickFolder: () => void;
  onOpenReader: () => void;
};

/**
 * 源文件卡片：未导入时保留大面积拖放区；
 * 导入后替换为紧凑的封面 + 书名 + 校验信息卡。
 */
export function SourceDropCard({
  i18n,
  source,
  entry,
  validation,
  loading,
  dragOver,
  resumeHint,
  onPickFile,
  onPickFolder,
  onOpenReader,
}: Props) {
  const [showFullPath, setShowFullPath] = useState(false);
  const meta = sourceMeta({ source, entry, validation });

  return (
    <section
      className={`card p-5 flex flex-col ${
        dragOver
          ? "ring-2 ring-ink-950 border-ink-950 bg-ink-200/40 dark:ring-fg dark:border-fg"
          : ""
      } ${source ? "" : "flex-1"}`}
    >
      <div className="flex items-center justify-between mb-3">
        <p className="label">{i18n.sourceFile}</p>
        {source && (
          <div className="flex gap-1.5">
            <button type="button" className="btn-ghost !px-2.5 !py-1 text-xs" onClick={onPickFile}>
              {i18n.changeSource}
            </button>
            <button
              type="button"
              className="btn-ghost !px-2.5 !py-1 text-xs"
              onClick={onPickFolder}
              title={i18n.chooseFolder}
              aria-label={i18n.chooseFolder}
            >
              <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M3 5.5A1.5 1.5 0 0 1 4.5 4h3l1.5 1.5h6.5A1.5 1.5 0 0 1 17 7v7.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5v-9Z"
                />
              </svg>
            </button>
          </div>
        )}
      </div>

      {!source ? (
        <div
          onClick={onPickFile}
          className="w-full flex-1 min-h-[12rem] cursor-pointer rounded-xl border border-dashed border-ink-300 bg-ink-100 transition hover:border-ink-500 hover:bg-ink-200/50 dark:border-white/[0.08] dark:bg-surface-panel"
        >
          <div className="grid h-full place-items-center px-5 py-10 text-center">
            <div>
              <svg
                viewBox="0 0 24 24"
                className="mx-auto h-9 w-9 text-ink-400 dark:text-fg-muted"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M4 5.5C4 4.67 4.67 4 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5v-13Zm16 0v13A1.5 1.5 0 0 1 18.5 20H13V4h5.5c.83 0 1.5.67 1.5 1.5Z" />
              </svg>
              <p className="mt-3 text-sm text-ink-800 dark:text-fg">{i18n.dropCompact}</p>
              <p className="mt-1 text-xs text-ink-500 dark:text-fg-muted">{i18n.importHint}</p>
              <div className="mt-4 flex justify-center gap-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPickFile();
                  }}
                  className="btn-soft !h-8 !px-3.5 !text-xs"
                >
                  {i18n.chooseFile}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPickFolder();
                  }}
                  className="btn-ghost !h-8 !px-3.5 !text-xs"
                >
                  {i18n.chooseFolder}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : loading ? (
        <div className="flex-1 grid place-items-center py-10 text-sm text-ink-500 dark:text-fg-muted">
          <span className="inline-flex items-center gap-2">
            <svg viewBox="0 0 20 20" className="h-4 w-4 animate-spin" aria-hidden="true">
              <circle
                cx="10"
                cy="10"
                r="8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeOpacity="0.25"
              />
              <path
                d="M10 2a8 8 0 0 1 8 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            {i18n.analyzingComic}
          </span>
        </div>
      ) : (
        <div>
          <div className="flex gap-4">
            <div className="cover-frame h-[88px] w-[64px] shrink-0 rounded-lg">
              {meta.cover ? (
                <img
                  src={meta.cover}
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                />
              ) : (
                <div className="grid h-full w-full place-items-center text-ink-300 dark:text-fg-muted" aria-hidden="true">
                  <svg viewBox="0 0 24 24" className="h-7 w-7" fill="currentColor">
                    <path d="M4 5.5C4 4.67 4.67 4 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5v-13Zm16 0v13A1.5 1.5 0 0 1 18.5 20H13V4h5.5c.83 0 1.5.67 1.5 1.5Z" />
                  </svg>
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p
                className="text-[15px] font-semibold leading-snug text-ink-900 line-clamp-2 dark:text-fg"
                title={meta.title}
              >
                {meta.title}
              </p>
              <button
                type="button"
                onClick={() => setShowFullPath((v) => !v)}
                title={i18n.clickShowPath}
                className="mt-1 block max-w-full truncate text-left font-mono text-xs text-ink-500 hover:text-ink-800 dark:text-fg-muted dark:hover:text-fg"
              >
                {showFullPath ? source : baseName(source)}
              </button>
              <p className="mt-1.5 text-xs text-ink-600 dark:text-fg-muted">
                {[meta.kind ? kindLabel(meta.kind) : "", meta.pages != null ? `${meta.pages} ${i18n.pages}` : ""]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                {validation && (
                  <span className="rounded-lg bg-success/12 border border-success/30 px-2 py-0.5 text-success dark:text-emerald-100">
                    {i18n.validateOk}
                  </span>
                )}
                {validation?.hasComicInfo && (
                  <span className="rounded-lg border border-ink-200 bg-ink-100 px-2 py-0.5 text-ink-600 dark:border-white/[0.08] dark:bg-surface-raised dark:text-fg-muted">
                    ComicInfo
                  </span>
                )}
              </div>
            </div>
          </div>
          <button
            type="button"
            className="btn-ghost mt-4 w-full py-2 text-sm"
            disabled={!source}
            onClick={onOpenReader}
          >
            {i18n.openReaderBtn}
          </button>
          {resumeHint && (
            <p className="mt-3 rounded-lg bg-amber-500/15 border border-amber-400/40 px-2.5 py-1.5 text-xs font-medium text-amber-900 dark:text-amber-50">
              {i18n.resumeTitle}：{resumeHint.message}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
