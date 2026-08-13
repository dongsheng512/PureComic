import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getReaderState, prepareReaderPages } from "../api";
import { stateLabel, type Messages } from "../i18n";
import type { JobStatus, ReaderPageFile, ReaderState } from "../types";
import { loadReaderPref, saveReaderPref, type FitMode, type ReadDirection, type SpreadMode } from "./prefs";

const BAR_KEY = "comic.reader.barHidden";

type Props = {
  jobs: JobStatus[];
  source: string | null;
  requestedJobId: string | null;
  i18n: Messages;
  onError: (msg: string | null) => void;
  onPickedSource?: (path: string) => void;
  onImmersiveChange?: (immersive: boolean) => void;
};

type LoadedPage = ReaderPageFile & { url: string };

function fileUrl(path: string, kind: string): string {
  const base = convertFileSrc(path);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}k=${encodeURIComponent(kind)}`;
}

function alignIndex(index: number, spread: SpreadMode, total: number): number {
  if (total <= 0) return 0;
  let i = Math.min(Math.max(0, index), total - 1);
  if (spread === "double") i -= i % 2;
  return i;
}

function stepIndex(index: number, dir: 1 | -1, spread: SpreadMode, total: number): number {
  const step = spread === "double" ? 2 : 1;
  return alignIndex(index + dir * step, spread, total);
}

function kindLabel(kind: string, i18n: Messages): string {
  if (kind === "enhanced") return i18n.readerEnhanced;
  if (kind === "original") return i18n.readerOriginal;
  return i18n.readerMissing;
}

function readBarHidden(): boolean {
  try {
    return localStorage.getItem(BAR_KEY) === "1";
  } catch {
    return false;
  }
}

export function ReaderView({
  jobs,
  source,
  requestedJobId,
  i18n,
  onError,
  onPickedSource,
  onImmersiveChange,
}: Props) {
  const [jobId, setJobId] = useState<string | null>(requestedJobId);
  const [state, setState] = useState<ReaderState | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [spread, setSpread] = useState<SpreadMode>("single");
  const [direction, setDirection] = useState<ReadDirection>("ltr");
  const [fit, setFit] = useState<FitMode>("screen");
  const [loaded, setLoaded] = useState<Record<number, LoadedPage>>({});
  const [busy, setBusy] = useState(false);
  const [barHidden, setBarHidden] = useState(readBarHidden);
  const [fullscreen, setFullscreen] = useState(false);
  const [progressHud, setProgressHud] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const progressTimer = useRef<number | null>(null);
  const sourceRef = useRef<string>("");
  const skipSaveRef = useRef(true);
  const lastCountRef = useRef(0);

  const immersive = barHidden || fullscreen;

  useEffect(() => {
    setJobId(requestedJobId);
  }, [requestedJobId]);

  useEffect(() => {
    try {
      localStorage.setItem(BAR_KEY, barHidden ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [barHidden]);

  useEffect(() => {
    onImmersiveChange?.(immersive);
    return () => onImmersiveChange?.(false);
  }, [immersive, onImmersiveChange]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    win
      .isFullscreen()
      .then(setFullscreen)
      .catch(() => undefined);
    win
      .onResized(async () => {
        try {
          setFullscreen(await win.isFullscreen());
        } catch {
          /* ignore */
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      unlisten?.();
      void win.setFullscreen(false).catch(() => undefined);
    };
  }, []);

  const setBar = useCallback((hidden: boolean) => {
    setBarHidden(hidden);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      setFullscreen(next);
      if (next) setBarHidden(true);
    } catch {
      setFullscreen((v) => !v);
    }
  }, []);

  const refreshState = useCallback(async (jid: string | null, src: string | null) => {
    if (!jid && !src) {
      setState(null);
      return;
    }
    try {
      const next = await getReaderState({ jobId: jid, source: src });
      setState(next);
      onError(null);
      return next;
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [onError]);

  useEffect(() => {
    if (jobId) {
      void refreshState(jobId, null);
      return;
    }
    if (requestedJobId) {
      void refreshState(requestedJobId, null);
      return;
    }
    if (source) {
      void refreshState(null, source);
      return;
    }
    const running = jobs.find((j) =>
      ["running", "extracting", "finalizing", "validating", "pending"].includes(j.state),
    );
    if (running) void refreshState(running.jobId, null);
    else if (jobs[0]) void refreshState(jobs[0].jobId, null);
    // jobs is a snapshot for first auto-pick only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, requestedJobId, source, refreshState]);

  useEffect(() => {
    if (jobId || requestedJobId || source || state) return;
    const running = jobs.find((j) =>
      ["running", "extracting", "finalizing", "validating", "pending"].includes(j.state),
    );
    const pick = running ?? jobs[0];
    if (pick) void refreshState(pick.jobId, null);
  }, [jobs, jobId, requestedJobId, source, state, refreshState]);

  useEffect(() => {
    if (!state?.source) return;
    const bookChanged = sourceRef.current !== state.source;
    const countAppeared = lastCountRef.current === 0 && state.pageCount > 0;
    lastCountRef.current = state.pageCount;
    if (!bookChanged && !countAppeared) return;
    if (bookChanged) {
      sourceRef.current = state.source;
      lastCountRef.current = state.pageCount;
    }
    if (state.pageCount <= 0) return;
    const pref = loadReaderPref(state.source);
    skipSaveRef.current = true;
    setSpread(pref.spread);
    setDirection(pref.direction);
    setFit(pref.fit);
    setPageIndex(alignIndex(pref.pageIndex, pref.spread, state.pageCount));
  }, [state?.source, state?.pageCount]);

  useEffect(() => {
    if (!state?.source) return;
    if (skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }
    saveReaderPref(state.source, { pageIndex, spread, direction, fit });
  }, [state?.source, pageIndex, spread, direction, fit]);

  const visibleIndexes = useMemo(() => {
    if (!state || state.pageCount <= 0) return [] as number[];
    const i = alignIndex(pageIndex, spread, state.pageCount);
    if (spread === "double" && i + 1 < state.pageCount) return [i, i + 1];
    return [i];
  }, [state, pageIndex, spread]);

  const prefetchIndexes = useMemo(() => {
    if (!state) return visibleIndexes;
    const extra: number[] = [];
    const last = visibleIndexes[visibleIndexes.length - 1] ?? 0;
    for (let d = 1; d <= 4; d++) {
      const n = last + d;
      if (n < state.pageCount) extra.push(n);
    }
    const prev = (visibleIndexes[0] ?? 0) - 1;
    if (prev >= 0) extra.push(prev);
    return [...visibleIndexes, ...extra];
  }, [state, visibleIndexes]);

  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  useEffect(() => {
    let cancelled = false;
    const jid = state?.jobId ?? jobId;
    const src = state?.source ?? source;
    if (!src && !jid) return;

    const need = (idx: number) => {
      const existing = loadedRef.current[idx];
      const meta = state?.pages.find((p) => p.index === idx);
      if (existing && existing.kind === "enhanced") return false;
      if (existing && meta && existing.kind === meta.kind && meta.kind !== "missing") return false;
      if (existing && !meta) return false;
      return true;
    };

    const apply = (files: { index: number; name: string; kind: string; path: string }[]) => {
      if (cancelled || files.length === 0) return;
      setLoaded((prev) => {
        const next = { ...prev };
        for (const file of files) {
          next[file.index] = { ...file, url: fileUrl(file.path, file.kind) };
        }
        return next;
      });
    };

    (async () => {
      const vis = visibleIndexes.filter(need);
      const rest = prefetchIndexes.filter((i) => !visibleIndexes.includes(i) && need(i));
      try {
        if (vis.length > 0) {
          setBusy(true);
          const files = await prepareReaderPages({ jobId: jid, source: src, pageIndexes: vis });
          if (cancelled) return;
          apply(files);
        }
      } catch (e) {
        if (!cancelled) onError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
      if (cancelled || rest.length === 0) return;
      try {
        const files = await prepareReaderPages({ jobId: jid, source: src, pageIndexes: rest });
        apply(files);
      } catch {
        /* prefetch is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prefetchIndexes.join(","), state?.jobId, state?.pagesDone, jobId, source]);

  useEffect(() => {
    if (!state?.jobId) return;
    const active = ["running", "extracting", "finalizing", "validating", "pending", "cancelling"].includes(
      state.jobState ?? "",
    );
    if (!active && state.pages.every((p) => p.kind !== "missing")) return;
    const t = window.setInterval(() => {
      void refreshState(state.jobId ?? null, null);
    }, 900);
    return () => window.clearInterval(t);
  }, [state?.jobId, state?.jobState, state?.pages, refreshState]);

  const flashProgress = useCallback(() => {
    setProgressHud(true);
    if (progressTimer.current != null) window.clearTimeout(progressTimer.current);
    progressTimer.current = window.setTimeout(() => setProgressHud(false), 1800);
  }, []);

  useEffect(() => {
    if ((state?.pageCount ?? 0) > 0) flashProgress();
  }, [pageIndex, flashProgress, state?.pageCount]);

  useEffect(() => {
    return () => {
      if (progressTimer.current != null) window.clearTimeout(progressTimer.current);
    };
  }, []);

  const go = useCallback(
    (dir: 1 | -1) => {
      if (!state) return;
      setPageIndex((i) => stepIndex(i, dir, spread, state.pageCount));
    },
    [state, spread],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        go(direction === "rtl" ? -1 : 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(direction === "rtl" ? 1 : -1);
      } else if (e.key === " " || e.key === "PageDown") {
        e.preventDefault();
        go(1);
      } else if (e.key === "PageUp") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "Home") {
        e.preventDefault();
        setPageIndex(0);
      } else if (e.key === "End" && state) {
        e.preventDefault();
        setPageIndex(alignIndex(state.pageCount - 1, spread, state.pageCount));
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        void toggleFullscreen();
      } else if (e.key === "h" || e.key === "H") {
        e.preventDefault();
        setBar(!barHidden);
      } else if (e.key === "Escape") {
        if (fullscreen) {
          e.preventDefault();
          void toggleFullscreen();
        } else if (barHidden) {
          e.preventDefault();
          setBar(false);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [direction, go, spread, state, barHidden, fullscreen, setBar, toggleFullscreen]);

  const pickFile = async () => {
    const p = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: "Comic", extensions: ["cbz", "cbr", "zip", "rar", "epub", "mobi", "azw", "azw3"] },
      ],
    });
    if (typeof p === "string") {
      setJobId(null);
      sourceRef.current = "";
      onPickedSource?.(p);
      void refreshState(null, p);
    }
  };

  const pickFolder = async () => {
    const p = await open({ multiple: false, directory: true });
    if (typeof p === "string") {
      setJobId(null);
      sourceRef.current = "";
      onPickedSource?.(p);
      void refreshState(null, p);
    }
  };

  const pagesInView = visibleIndexes.map((i) => loaded[i]).filter(Boolean) as LoadedPage[];
  const displayPages = direction === "rtl" ? [...pagesInView].reverse() : pagesInView;
  const total = state?.pageCount ?? 0;
  const pageLabel =
    spread === "double" && visibleIndexes.length === 2
      ? `${visibleIndexes[0] + 1}–${visibleIndexes[1] + 1} / ${total}`
      : `${(visibleIndexes[0] ?? 0) + 1} / ${total || "—"}`;

  const clickNav = (clientX: number, rect: DOMRect) => {
    const left = clientX < rect.left + rect.width * 0.35;
    const right = clientX > rect.right - rect.width * 0.35;
    if (!left && !right) return;
    if (direction === "rtl") go(left ? 1 : -1);
    else go(right ? 1 : -1);
  };

  const lastVisible = visibleIndexes[visibleIndexes.length - 1] ?? pageIndex;
  const progressPct = total > 0 ? Math.min(100, ((lastVisible + 1) / total) * 100) : 0;

  const seekProgress = (clientX: number, rect: DOMRect) => {
    if (total <= 0) return;
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const idx = Math.min(total - 1, Math.floor(t * total));
    setPageIndex(alignIndex(idx, spread, total));
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-black">
      {immersive && (
        <div data-tauri-drag-region className="pointer-events-auto absolute left-0 top-0 z-30 h-[52px] w-[88px]" />
      )}

      {!barHidden && (
        <div
          className={`shrink-0 border-b border-ink-200/80 bg-[#f0f2f7] py-2 pr-3 dark:border-white/10 dark:bg-ink-950 ${
            immersive ? "pl-[88px]" : "pl-3"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex flex-wrap items-center gap-2">
            <JobPicker
              jobs={jobs}
              value={state?.jobId ?? jobId ?? ""}
              currentTitle={state?.title ?? null}
              placeholder={i18n.readerPickJob}
              onChange={(id) => {
                setJobId(id || null);
                sourceRef.current = "";
                void refreshState(id || null, id ? null : source);
              }}
            />
            <button type="button" className="btn-ghost !h-9 !px-3 text-xs" onClick={pickFile}>
              {i18n.readerOpenFile}
            </button>
            <button type="button" className="btn-ghost !h-9 !px-3 text-xs" onClick={pickFolder}>
              {i18n.readerOpenFolder}
            </button>
            <div className="mx-1 hidden h-5 w-px bg-ink-200 dark:bg-white/10 sm:block" />
            <Segment
              value={spread}
              onChange={(v) => {
                setSpread(v);
                setPageIndex((i) => alignIndex(i, v, total));
              }}
              options={[
                { id: "single", label: i18n.readerSingle },
                { id: "double", label: i18n.readerDouble },
              ]}
            />
            <Segment
              value={direction}
              onChange={setDirection}
              options={[
                { id: "ltr", label: i18n.readerLtr },
                { id: "rtl", label: i18n.readerRtl },
              ]}
            />
            <Segment
              value={fit}
              onChange={setFit}
              options={[
                { id: "screen", label: i18n.readerFitScreen },
                { id: "smart", label: i18n.readerFitSmart },
              ]}
            />
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                className="btn-ghost !h-9 !px-2.5 text-xs"
                disabled={!state || pageIndex <= 0}
                onClick={() => go(-1)}
              >
                {direction === "rtl" ? "›" : "‹"}
              </button>
              <span className="min-w-[6.5rem] text-center text-sm tabular-nums text-ink-700 dark:text-ink-200">
                {pageLabel}
              </span>
              <button
                type="button"
                className="btn-ghost !h-9 !px-2.5 text-xs"
                disabled={!state || pageIndex >= Math.max(0, total - (spread === "double" ? 2 : 1))}
                onClick={() => go(1)}
              >
                {direction === "rtl" ? "‹" : "›"}
              </button>
              <button
                type="button"
                className="btn-ghost !h-9 !px-3 text-xs"
                title={`${i18n.readerFullscreen} (F)`}
                onClick={() => void toggleFullscreen()}
              >
                {fullscreen ? i18n.readerExitFullscreen : i18n.readerFullscreen}
              </button>
              <button
                type="button"
                className="btn-ghost !h-9 !px-3 text-xs"
                title={`${i18n.readerHideBar} (H)`}
                onClick={() => setBar(true)}
              >
                {i18n.readerHideBar}
              </button>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-500">
            <span className="truncate font-medium text-ink-700 dark:text-ink-200">
              {state?.title ?? i18n.readerEmpty}
            </span>
            {state?.jobState && (
              <span>
                {i18n.readerJob} · {state.jobState} · {state.pagesDone}/{state.pageCount}
              </span>
            )}
            {pagesInView.map((p) => (
              <span
                key={p.index}
                className={`rounded-md border px-1.5 py-0.5 ${
                  p.kind === "enhanced"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
                    : "border-ink-200 bg-ink-100 text-ink-600 dark:border-white/10 dark:bg-white/5 dark:text-ink-300"
                }`}
              >
                {p.index + 1} {kindLabel(p.kind, i18n)}
              </span>
            ))}
            {busy && <span>{i18n.readerLoading}</span>}
          </div>
        </div>
      )}

      {barHidden && (
        <button
          type="button"
          className="absolute right-3 top-3 z-20 h-9 rounded-xl border border-white/15 bg-black/50 px-3 text-xs text-white/90 backdrop-blur-sm hover:bg-black/70"
          title={`${i18n.readerShowBar} (H)`}
          onClick={() => setBar(false)}
        >
          {i18n.readerShowBar}
        </button>
      )}

      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1 overflow-auto bg-black"
        onClick={(e) => clickNav(e.clientX, e.currentTarget.getBoundingClientRect())}
      >
        {!state && (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-ink-400">
            {i18n.readerHint}
          </div>
        )}
        {state && displayPages.length === 0 && (
          <div className="grid h-full place-items-center text-sm text-ink-400">
            {busy ? i18n.readerLoading : i18n.readerWaitingExtract}
          </div>
        )}
        {state && displayPages.length > 0 && (
          <div
            className={
              fit === "screen"
                ? "flex h-full min-h-full items-center justify-center"
                : "flex min-h-full items-start justify-center"
            }
          >
            {displayPages.map((p) => (
              <img
                key={`${p.index}-${p.kind}`}
                src={p.url}
                alt={p.name}
                decoding="async"
                draggable={false}
                className={
                  fit === "screen"
                    ? spread === "double"
                      ? "max-h-full max-w-[50%] object-contain select-none"
                      : "max-h-full max-w-full object-contain select-none"
                    : spread === "double"
                      ? "w-1/2 h-auto select-none"
                      : "w-full h-auto select-none"
                }
              />
            ))}
          </div>
        )}
      </div>

      {total > 0 && (
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 z-20 transition-opacity duration-300 ${
            progressHud ? "opacity-100" : "opacity-0"
          }`}
        >
          <div
            className="pointer-events-auto bg-gradient-to-t from-black/75 via-black/35 to-transparent px-4 pb-3 pt-8"
            onMouseEnter={() => {
              setProgressHud(true);
              if (progressTimer.current != null) window.clearTimeout(progressTimer.current);
            }}
            onMouseLeave={flashProgress}
          >
            <button
              type="button"
              aria-label={pageLabel}
              className="block h-3 w-full cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                seekProgress(e.clientX, e.currentTarget.getBoundingClientRect());
              }}
            >
              <span className="flex h-1.5 items-center rounded-full bg-white/20">
                <span
                  className="h-1.5 rounded-full bg-white shadow-sm transition-[width] duration-200"
                  style={{ width: `${progressPct}%` }}
                />
              </span>
            </button>
            <p className="mt-1.5 text-center text-[11px] tabular-nums text-white/80">{pageLabel}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function jobFileName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function JobPicker({
  jobs,
  value,
  currentTitle,
  placeholder,
  onChange,
}: {
  jobs: JobStatus[];
  value: string;
  currentTitle: string | null;
  placeholder: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = jobs.find((j) => j.jobId === value);
  const label = selected
    ? jobFileName(selected.source)
    : currentTitle || placeholder;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((v) => !v)}
        className={`btn-ghost !h-9 !px-3 text-xs max-w-[14rem] ${
          open ? "!border-accent" : ""
        }`}
      >
        <span className="truncate">{label}</span>
        <svg
          viewBox="0 0 20 20"
          className={`h-3.5 w-3.5 shrink-0 text-ink-400 transition ${open ? "rotate-180 text-accent" : ""}`}
          aria-hidden="true"
        >
          <path
            fill="currentColor"
            d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.58l3.3-3.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.42Z"
          />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute left-0 z-40 mt-1.5 min-w-[16rem] max-w-[22rem] max-h-64 overflow-auto rounded-xl border border-ink-200 bg-white py-1 shadow-panel dark:border-white/10 dark:bg-ink-900/95 dark:backdrop-blur-md"
        >
          {jobs.length === 0 && (
            <li className="px-3 py-2 text-xs text-ink-500">{placeholder}</li>
          )}
          {jobs.map((j) => {
            const active = j.jobId === value;
            return (
              <li key={j.jobId}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition ${
                    active
                      ? "bg-accent/15 text-ink-950 dark:text-white"
                      : "text-ink-700 hover:bg-ink-100 hover:text-ink-950 dark:text-ink-200 dark:hover:bg-white/10 dark:hover:text-white"
                  }`}
                  onClick={() => {
                    onChange(j.jobId);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{jobFileName(j.source)}</span>
                  <span className="shrink-0 text-[10px] text-ink-500 dark:text-ink-400">
                    {stateLabel(j.state)}
                  </span>
                  {active && (
                    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true">
                      <path
                        fill="currentColor"
                        d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.2 7.2a1 1 0 0 1-1.4 0L3.3 9.1a1 1 0 1 1 1.4-1.4l4.1 4.08 6.5-6.48a1 1 0 0 1 1.4 0Z"
                      />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Segment<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-xl border border-ink-200 bg-ink-100/80 p-0.5 dark:border-white/10 dark:bg-white/5">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onChange(opt.id)}
          className={`rounded-lg px-2.5 py-1 text-xs transition ${
            value === opt.id
              ? "bg-white text-ink-950 shadow-sm dark:bg-ink-800 dark:text-white"
              : "text-ink-600 hover:text-ink-950 dark:text-ink-300 dark:hover:text-white"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
