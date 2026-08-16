import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { comicFileFilter } from "../formats";
import {
  cancelReaderEnhance,
  clearReaderEnhanceCache,
  enhanceReaderPages,
  getReaderState,
  listEngines,
  lookupReaderEnhancePages,
  prepareReaderPages,
  readerEnhanceCacheStats,
} from "../api";
import { stateLabel, type Messages } from "../i18n";
import type {
  EnhanceCacheStats,
  EngineInfo,
  JobStatus,
  ReaderEnhanceOptions,
  ReaderPageFile,
  ReaderState,
} from "../types";
import { startWindowDrag } from "../windowDrag";
import {
  isReaderEngine,
  loadEnhanceNoise,
  loadReaderEngine,
  loadReaderPref,
  saveEnhanceNoise,
  saveReaderEngine,
  saveReaderPref,
  type FitMode,
  type ReadDirection,
  type SpreadMode,
} from "./prefs";
import {
  fitWindowToPageUrls,
  restoreDefaultWindowMinSize,
  syncReaderBarHeightCss,
} from "./smartFit";

const BAR_KEY = "comic.reader.barHidden";
/** 与后端 AppError::cancelled() 的固定文案保持一致（crates/comic-core/src/error.rs） */
const CANCEL_MESSAGE = "任务已取消";
/** 原图页内存 LRU 窗口：保留当前页 ±N 页，超长书翻页不无限膨胀 */
const LOADED_WINDOW = 120;
const LOADED_HALF_WINDOW = 60;

type Props = {
  jobs: JobStatus[];
  source: string | null;
  requestedJobId: string | null;
  /** 当前书名（书库下钻时优先展示） */
  bookTitle?: string | null;
  /** 临时/外部打开：未写入书库 */
  temporary?: boolean;
  i18n: Messages;
  /** 工具栏返回按钮文案 */
  backLabel?: string;
  /** 关闭阅读器（返回书库等）；Esc 在非全屏且工具栏可见时触发 */
  onClose?: () => void;
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
  bookTitle = null,
  temporary = false,
  i18n,
  backLabel,
  onClose,
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
  /** 悬停滑杆拖动中的暂存值：拖动不 align，松手再对齐（避免 double 模式 thumb 回弹） */
  const [sliderDragValue, setSliderDragValue] = useState<number | null>(null);
  const [pageEditing, setPageEditing] = useState(false);
  const [pageDraft, setPageDraft] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [enhanceOn, setEnhanceOn] = useState(false);
  const [enhanceBusy, setEnhanceBusy] = useState(false);
  const [aiPages, setAiPages] = useState<Record<number, LoadedPage>>({});
  const [engineId, setEngineId] = useState(loadReaderEngine);
  const [noiseLevel, setNoiseLevel] = useState<0 | 1 | 2 | 3>(loadEnhanceNoise);
  const [catalog, setCatalog] = useState<EngineInfo[]>([]);
  const [cacheStats, setCacheStats] = useState<EnhanceCacheStats | null>(null);
  /** 清除缓存：行内二次确认 / 清除中 / 完成 toast */
  const [clearConfirming, setClearConfirming] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [clearToast, setClearToast] = useState<string | null>(null);
  /** 切换引擎后、缓存仍存在时的提示（新缓存生成期间保持可见） */
  const [engineSwitchHint, setEngineSwitchHint] = useState(false);
  const clearRevertTimer = useRef<number | null>(null);
  const clearToastTimer = useRef<number | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const enhanceEpochRef = useRef(0);
  const pageInputRef = useRef<HTMLInputElement>(null);
  const progressTimer = useRef<number | null>(null);
  const sourceRef = useRef<string>("");
  const skipSaveRef = useRef(true);
  const lastCountRef = useRef(0);
  /** 悬停说明：极简单例 tooltip（延迟 120ms 显示，避免扫过闪烁） */
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const tipTimer = useRef<number | null>(null);
  const showTip = useCallback((e: React.MouseEvent, text: string) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => {
      setTip({
        text,
        x: Math.min(Math.max(rect.left + rect.width / 2, 64), window.innerWidth - 64),
        y: rect.bottom,
      });
    }, 120);
  }, []);
  const hideTip = useCallback(() => {
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    setTip(null);
  }, []);
  /**
   * 智能适应会话键：仅在「进入 smart / 换书 / 单双页切换」时变，
   * 翻页不变更 → 窗口不会跟页乱跳（方案 A）。
   */
  const smartSessionKeyRef = useRef<string | null>(null);
  const smartFitGen = useRef(0);

  const immersive = barHidden || fullscreen;

  // 工具栏高度单一来源：smartFit.ts 常量 → CSS 变量（.reader-bar 引用）
  useEffect(() => {
    syncReaderBarHeightCss();
  }, []);

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
      setLoaded({});
      setEnhanceOn(false);
      setAiPages({});
      setEnhanceBusy(false);
      enhanceEpochRef.current += 1;
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
    const origin =
      direction === "rtl"
        ? (visibleIndexes[0] ?? 0)
        : (visibleIndexes[visibleIndexes.length - 1] ?? 0);
    const step = direction === "rtl" ? -1 : 1;
    for (let d = 1; d <= 4; d++) {
      const n = origin + step * d;
      if (n < 0 || n >= state.pageCount) break;
      if (!visibleIndexes.includes(n)) extra.push(n);
    }
    const back =
      direction === "rtl"
        ? (visibleIndexes[visibleIndexes.length - 1] ?? 0) + 1
        : (visibleIndexes[0] ?? 0) - 1;
    if (
      back >= 0 &&
      back < state.pageCount &&
      !visibleIndexes.includes(back) &&
      !extra.includes(back)
    ) {
      extra.push(back);
    }
    return [...visibleIndexes, ...extra];
  }, [state, visibleIndexes, direction]);

  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const pageIndexRef = useRef(pageIndex);
  pageIndexRef.current = pageIndex;

  const enhanceOpts = useMemo<ReaderEnhanceOptions>(
    () => ({
      engine: engineId,
      preset: "quality",
      scale: engineId === "realesrgan-coreml" ? 4 : 2,
      noiseLevel: engineId === "waifu2x-coreml" ? noiseLevel : 0,
      tta: false,
    }),
    [engineId, noiseLevel],
  );

  const aiPagesRef = useRef(aiPages);
  aiPagesRef.current = aiPages;

  const applyAiFiles = useCallback((files: ReaderPageFile[]) => {
    if (files.length === 0) return;
    setAiPages((prev) => {
      const next = { ...prev };
      for (const file of files) {
        next[file.index] = { ...file, url: fileUrl(file.path, file.kind) };
      }
      const keys = Object.keys(next).map(Number);
      if (keys.length > 80) {
        for (const k of keys) {
          if (Math.abs(k - pageIndex) > 40) delete next[k];
        }
      }
      return next;
    });
  }, [pageIndex]);

  const applyAiRef = useRef(applyAiFiles);
  applyAiRef.current = applyAiFiles;

  useEffect(() => {
    let cancelled = false;
    listEngines()
      .then((c) => {
        if (cancelled) return;
        const reader = c.filter((e) => isReaderEngine(e.id));
        setCatalog(reader);
        const saved = loadReaderEngine();
        const pick =
          reader.find((e) => e.id === saved && e.available) ??
          reader.find((e) => e.id === "waifu2x-coreml" && e.available) ??
          reader.find((e) => e.available) ??
          reader[0];
        if (!pick || !isReaderEngine(pick.id)) return;
        setEngineId(pick.id);
        saveReaderEngine(pick.id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshCacheStats = useCallback(() => {
    void readerEnhanceCacheStats()
      .then(setCacheStats)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshCacheStats();
  }, [refreshCacheStats, aiPages]);

  useEffect(() => {
    if (!enhanceOn) {
      setEnhanceBusy(false);
      void cancelReaderEnhance();
      return;
    }
    const src = state?.source ?? source;
    const total = state?.pageCount ?? 0;
    if (!src || visibleIndexes.length === 0 || total <= 0) return;

    const ahead: number[] = [];
    const origin =
      direction === "rtl"
        ? (visibleIndexes[0] ?? 0)
        : (visibleIndexes[visibleIndexes.length - 1] ?? 0);
    const step = direction === "rtl" ? -1 : 1;
    // 单页：前方 2 + 回翻 1。双页按整屏走：前方 4（两屏）+ 回翻 2（上一屏）
    const aheadCount = visibleIndexes.length >= 2 ? 4 : 2;
    const behindCount = visibleIndexes.length >= 2 ? 2 : 1;
    for (let n = 1; n <= aheadCount; n++) {
      const idx = origin + step * n;
      if (idx < 0 || idx >= total) break;
      if (!visibleIndexes.includes(idx)) ahead.push(idx);
    }
    for (let n = 1; n <= behindCount; n++) {
      const idx =
        direction === "rtl"
          ? (visibleIndexes[visibleIndexes.length - 1] ?? 0) + n
          : (visibleIndexes[0] ?? 0) - n;
      if (
        idx >= 0 &&
        idx < total &&
        !visibleIndexes.includes(idx) &&
        !ahead.includes(idx)
      ) {
        ahead.push(idx);
      }
    }

    const visCached = visibleIndexes.every((i) => Boolean(aiPagesRef.current[i]));
    if (visCached) setEnhanceBusy(false);

    const epoch = enhanceEpochRef.current;
    let cancelled = false;
    const stillThis = () => !cancelled && epoch === enhanceEpochRef.current;
    const isCancel = (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return msg === CANCEL_MESSAGE || msg.startsWith(CANCEL_MESSAGE);
    };

    (async () => {
      try {
        const needLookup = visibleIndexes.filter((i) => !aiPagesRef.current[i]);
        if (needLookup.length > 0) {
          const hits = await lookupReaderEnhancePages({
            source: src,
            jobId: state?.jobId ?? jobId,
            pageIndexes: needLookup,
            options: enhanceOpts,
          });
          if (!stillThis()) return;
          applyAiRef.current(hits);
        }
        const miss = visibleIndexes.filter((i) => !aiPagesRef.current[i]);
        if (miss.length > 0) {
          setEnhanceBusy(true);
          try {
            const files = await enhanceReaderPages({
              source: src,
              jobId: state?.jobId ?? jobId,
              pageIndexes: miss,
              options: enhanceOpts,
            });
            if (epoch === enhanceEpochRef.current) applyAiRef.current(files);
          } catch (e) {
            if (stillThis() && !isCancel(e)) {
              onError(e instanceof Error ? e.message : String(e));
            }
          } finally {
            setEnhanceBusy(false);
          }
        } else {
          setEnhanceBusy(false);
        }
        if (!stillThis()) return;
        const prefNeed = ahead.filter((i) => !aiPagesRef.current[i]);
        if (prefNeed.length === 0) {
          refreshCacheStats();
          return;
        }
        const prefHits = await lookupReaderEnhancePages({
          source: src,
          jobId: state?.jobId ?? jobId,
          pageIndexes: prefNeed,
          options: enhanceOpts,
        });
        if (epoch !== enhanceEpochRef.current) return;
        applyAiRef.current(prefHits);
        const prefMiss = prefNeed.filter((i) => !aiPagesRef.current[i]);
        if (prefMiss.length === 0) {
          refreshCacheStats();
          return;
        }
        try {
          const files = await enhanceReaderPages({
            source: src,
            jobId: state?.jobId ?? jobId,
            pageIndexes: prefMiss,
            options: enhanceOpts,
          });
          if (epoch === enhanceEpochRef.current) applyAiRef.current(files);
        } catch (e) {
          if (isCancel(e) || epoch !== enhanceEpochRef.current) return;
        }
        if (stillThis()) refreshCacheStats();
      } catch (e) {
        if (stillThis() && !isCancel(e)) {
          onError(e instanceof Error ? e.message : String(e));
        }
        setEnhanceBusy(false);
      }
    })();

    return () => {
      cancelled = true;
      setEnhanceBusy(false);
    };
  }, [
    enhanceOn,
    visibleIndexes.join(","),
    direction,
    engineId,
    noiseLevel,
    state?.source,
    state?.jobId,
    state?.pageCount,
    source,
    jobId,
    // applyAiFiles / onError 用 ref，避免父组件重渲打断预热
  ]);

  useEffect(() => {
    let cancelled = false;
    const jid = state?.jobId ?? jobId;
    const src = state?.source ?? source;
    if (!src && !jid) return;

    const need = (idx: number) => {
      const existing = loadedRef.current[idx];
      return !existing || existing.kind !== "original";
    };

    const apply = (files: { index: number; name: string; kind: string; path: string }[]) => {
      if (cancelled || files.length === 0) return;
      setLoaded((prev) => {
        const next = { ...prev };
        for (const file of files) {
          next[file.index] = { ...file, url: fileUrl(file.path, file.kind) };
        }
        // 原图页 LRU 窗口：翻完超长书后 loaded 无限膨胀（与 aiPages 同思路）
        const keys = Object.keys(next).map(Number);
        const center = pageIndexRef.current;
        if (keys.length > LOADED_WINDOW) {
          for (const k of keys) {
            if (Math.abs(k - center) > LOADED_HALF_WINDOW) delete next[k];
          }
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
          const files = await prepareReaderPages({
            jobId: jid,
            source: src,
            pageIndexes: vis,
            preferOriginal: true,
          });
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
        const files = await prepareReaderPages({
          jobId: jid,
          source: src,
          pageIndexes: rest,
          preferOriginal: true,
        });
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

  const toggleAi = useCallback(() => {
    if (enhanceOn) {
      enhanceEpochRef.current += 1;
      setEnhanceOn(false);
      setEnhanceBusy(false);
      void cancelReaderEnhance();
      return;
    }
    if (visibleIndexes.length === 0) return;
    setEnhanceOn(true);
  }, [enhanceOn, visibleIndexes]);

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
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        toggleAi();
      } else if (e.key === "Escape") {
        if (pageEditing) {
          e.preventDefault();
          setPageEditing(false);
        } else if (moreOpen) {
          e.preventDefault();
          setMoreOpen(false);
        } else if (fullscreen) {
          e.preventDefault();
          void toggleFullscreen();
        } else if (barHidden) {
          e.preventDefault();
          setBar(false);
        } else if (onClose) {
          e.preventDefault();
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    direction,
    go,
    spread,
    state,
    barHidden,
    fullscreen,
    setBar,
    toggleFullscreen,
    onClose,
    pageEditing,
    moreOpen,
    toggleAi,
  ]);

  const pickFile = async () => {
    const p = await open({
      multiple: false,
      directory: false,
      filters: [comicFileFilter("Comic")],
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

  const pagesInView = visibleIndexes
    .map((i) => (enhanceOn && aiPages[i] ? aiPages[i] : loaded[i]))
    .filter(Boolean) as LoadedPage[];
  const showingAi =
    enhanceOn &&
    visibleIndexes.length > 0 &&
    visibleIndexes.every((i) => Boolean(aiPages[i]));
  const pageEnhancing = enhanceBusy && !showingAi;
  const displayPages = direction === "rtl" ? [...pagesInView].reverse() : pagesInView;
  const total = state?.pageCount ?? 0;

  const cacheSizeText = (stats: EnhanceCacheStats | null): string => {
    if (!stats) return "—";
    const mb = stats.bytes / (1024 * 1024);
    return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
  };

  /** 引擎分段选项：主标签 13pt + 副标签 10pt */
  const engineOptions = useMemo(() => {
    const list =
      catalog.length > 0
        ? catalog
        : [
            {
              id: "waifu2x-coreml",
              label: "Waifu2x Core ML",
              available: true,
              detail: "",
              scales: [2],
              models: [],
            },
            {
              id: "realesrgan-coreml",
              label: "Real-ESRGAN Anime 4×",
              available: true,
              detail: "",
              scales: [4],
              models: [],
            },
          ];
    return list
      .filter((e) => e.available !== false)
      .map((e) => {
        const known =
          e.id === "waifu2x-coreml"
            ? { main: "Waifu2x", sub: "Core ML" }
            : e.id === "realesrgan-coreml"
              ? { main: "Real-ESRGAN", sub: "4×" }
              : null;
        return {
          id: e.id,
          main: known?.main ?? e.label,
          sub: known?.sub ?? e.detail ?? "",
        };
      });
  }, [catalog]);
  const engineIndex = Math.max(0, engineOptions.findIndex((o) => o.id === engineId));

  const cacheLine = cacheStats
    ? i18n.readerAiCacheCount
        .replace("{done}", String(cacheStats.files))
        .replace("{total}", String(total))
        .replace("{size}", cacheSizeText(cacheStats))
    : "—";
  const cachePct =
    total > 0 && cacheStats ? Math.min(100, (cacheStats.files / total) * 100) : 0;

  const persistEngine = (id: string) => {
    if (!isReaderEngine(id) || id === engineId) return;
    enhanceEpochRef.current += 1;
    void cancelReaderEnhance();
    setEngineId(id);
    saveReaderEngine(id);
    setAiPages({});
    // 已有缓存时切换引擎：提示新缓存需重新生成（清除缓存后自动消失）
    if (cacheStats && cacheStats.bytes > 0) setEngineSwitchHint(true);
  };

  const persistNoise = (n: 0 | 1 | 2 | 3) => {
    if (n === noiseLevel) return;
    enhanceEpochRef.current += 1;
    void cancelReaderEnhance();
    setNoiseLevel(n);
    saveEnhanceNoise(n);
    setAiPages({});
  };

  /** 清除缓存：行内二次确认（3 秒自动还原）→ 清除中 spinner → toast */
  const handleClearClick = async () => {
    if (clearingCache) return;
    if (!clearConfirming) {
      setClearConfirming(true);
      if (clearRevertTimer.current) window.clearTimeout(clearRevertTimer.current);
      clearRevertTimer.current = window.setTimeout(() => setClearConfirming(false), 3000);
      return;
    }
    if (clearRevertTimer.current) window.clearTimeout(clearRevertTimer.current);
    setClearConfirming(false);
    setClearingCache(true);
    const size = cacheSizeText(cacheStats);
    try {
      await clearReaderEnhanceCache();
      setAiPages({});
      setEngineSwitchHint(false);
      refreshCacheStats();
      onError(null);
      setClearToast(i18n.readerAiClearedToast.replace("{size}", size));
      if (clearToastTimer.current) window.clearTimeout(clearToastTimer.current);
      clearToastTimer.current = window.setTimeout(() => setClearToast(null), 2200);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setClearingCache(false);
    }
  };

  const pageUrlsKey = pagesInView.map((p) => `${p.index}:${p.url}`).join("|");
  const bookKey = state?.source ?? source ?? "";

  // 方案 A：智能适应持续模式 — 仅在会话键变化时定一次窗口；翻页只缩放图片
  useEffect(() => {
    if (fit !== "smart") {
      smartSessionKeyRef.current = null;
      void restoreDefaultWindowMinSize();
      return;
    }
    if (fullscreen || pagesInView.length === 0 || !bookKey) return;

    // 会话键不含页码 / barHidden，避免翻页、藏栏导致窗口乱跳
    const sessionKey = `${bookKey}|${spread}`;
    if (smartSessionKeyRef.current === sessionKey) return;

    const urls = pagesInView.map((p) => p.url);
    const gen = ++smartFitGen.current;
    let cancelled = false;
    (async () => {
      try {
        await fitWindowToPageUrls(urls, spread, !barHidden, false);
        if (!cancelled && gen === smartFitGen.current) {
          smartSessionKeyRef.current = sessionKey;
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
    // 刻意不依赖 pageIndex / pageUrls 的每一页变化；仅在进入 smart、换书、切单双页时跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit, fullscreen, spread, bookKey, pageUrlsKey === "" ? "" : "ready"]);

  /** 方案 B：贴合当前页 — 一次性 resize（可居中），然后回到适应屏幕 */
  const fitWindowToCurrentPage = useCallback(async () => {
    if (pagesInView.length === 0 || fullscreen) return;
    try {
      await fitWindowToPageUrls(
        pagesInView.map((p) => p.url),
        spread,
        !barHidden,
        true,
      );
    } catch {
      /* ignore */
    }
    // 一次性动作：不保持 smart 连续会话
    smartSessionKeyRef.current = null;
    setFit("screen");
    void restoreDefaultWindowMinSize();
  }, [pagesInView, spread, barHidden, fullscreen]);

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
  const sliderPage = Math.min(total, (visibleIndexes[0] ?? pageIndex) + 1);

  const seekProgress = (clientX: number, rect: DOMRect) => {
    if (total <= 0) return;
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const idx = Math.min(total - 1, Math.floor(t * total));
    setPageIndex(alignIndex(idx, spread, total));
  };

  const commitPageJump = () => {
    const n = Number.parseInt(pageDraft.replace(/[^\d]/g, ""), 10);
    setPageEditing(false);
    if (!Number.isFinite(n) || total <= 0) return;
    setPageIndex(alignIndex(n - 1, spread, total));
  };

  useEffect(() => {
    if (!pageEditing) return;
    pageInputRef.current?.focus();
    pageInputRef.current?.select();
  }, [pageEditing]);

  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (moreRef.current && !moreRef.current.contains(t)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    // 延后绑定，避免打开菜单的同一次 mousedown 被当成“点外部”
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", onDoc);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const displayTitle = bookTitle || state?.title || null;
  const canPrev = !!state && pageIndex > 0;
  const canNext = !!state && pageIndex < Math.max(0, total - (spread === "double" ? 2 : 1));

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-black"
      onMouseDownCapture={(e) => {
        if (e.button !== 0) return;
        /* WebKit：点击 user-select:none 的内容不会收起既有选区，
           任何点击先清一次，保证阅读器里不会出现“无法取消选中”。 */
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) sel.removeAllRanges();
      }}
    >
      {/* 工具栏隐藏时：整条顶栏拖窗 */}
      {barHidden && (
        <div
          data-tauri-drag-region
          className="pointer-events-auto absolute inset-x-0 top-0 z-30 h-11"
          onMouseDown={startWindowDrag}
        />
      )}

      {!barHidden && (
        <div
          className={`reader-bar relative shrink-0 border-b border-ink-200/70 bg-ink-100/95 pl-[88px] pr-2 backdrop-blur-md dark:border-white/[0.08] dark:bg-surface/95 ${
            moreOpen ? "z-50" : "z-40"
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 底层整栏拖窗：上层控件 pointer-events-auto，空白处穿透到此层 */}
          <div
            data-tauri-drag-region
            className="absolute inset-0 z-0"
            onMouseDown={startWindowDrag}
          />
          <div className="relative z-10 flex h-full items-center gap-2 pointer-events-none">
            {/* —— 左：返回 + 书名 —— */}
            <div className="relative z-20 flex min-w-0 max-w-[28%] shrink-0 items-center gap-1 sm:max-w-[32%] pointer-events-none">
              {onClose && (
                <button
                  type="button"
                  className="reader-icon-btn pointer-events-auto"
                  aria-label={backLabel ?? i18n.readerBackLibrary}
                  onMouseEnter={(e) => showTip(e, backLabel ?? i18n.readerBackLibrary)}
                  onMouseLeave={hideTip}
                  onClick={onClose}
                >
                  <IconBack />
                </button>
              )}
              {displayTitle ? (
                <span
                  data-tauri-drag-region
                  className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-900 dark:text-fg pointer-events-auto"
                  title={displayTitle}
                  onMouseDown={startWindowDrag}
                >
                  {displayTitle}
                </span>
              ) : (
                <span
                  data-tauri-drag-region
                  className="truncate text-[12px] text-ink-500 dark:text-fg-muted pointer-events-auto"
                  onMouseDown={startWindowDrag}
                >
                  {i18n.readerEmpty}
                </span>
              )}
              {temporary && (
                <span className="pointer-events-none shrink-0 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-100">
                  {i18n.externalTempBadge}
                </span>
              )}
            </div>

            {/* —— 中：翻页进度（绝对居中） —— */}
            <div className="pointer-events-none absolute inset-x-0 z-10 flex justify-center">
              <div className="pointer-events-auto group/pager flex flex-col items-center">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    className="reader-icon-btn"
                    disabled={!canPrev}
                    aria-label={i18n.readerPrevPage}
                    onMouseEnter={(e) => showTip(e, i18n.readerPrevPage)}
                    onMouseLeave={hideTip}
                    onClick={() => go(-1)}
                  >
                    {direction === "rtl" ? <IconChevronRight /> : <IconChevronLeft />}
                  </button>
                  {pageEditing ? (
                    <input
                      ref={pageInputRef}
                      value={pageDraft}
                      onChange={(e) => setPageDraft(e.target.value)}
                      onBlur={commitPageJump}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitPageJump();
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setPageEditing(false);
                        }
                      }}
                      className="reader-page-chip border-0 bg-white text-center outline-none ring-1 ring-ink-300 dark:bg-surface-raised dark:ring-white/15"
                      inputMode="numeric"
                      aria-label={i18n.readerJumpHint}
                    />
                  ) : (
                    <button
                      type="button"
                      className="reader-page-chip"
                      aria-label={i18n.readerPageLabel}
                      onMouseEnter={(e) => showTip(e, i18n.readerPageLabel)}
                      onMouseLeave={hideTip}
                      disabled={total <= 0}
                      onClick={() => {
                        const cur = (visibleIndexes[0] ?? pageIndex) + 1;
                        setPageDraft(String(cur));
                        setPageEditing(true);
                      }}
                    >
                      {pageLabel}
                    </button>
                  )}
                  <button
                    type="button"
                    className="reader-icon-btn"
                    disabled={!canNext}
                    aria-label={i18n.readerNextPage}
                    onMouseEnter={(e) => showTip(e, i18n.readerNextPage)}
                    onMouseLeave={hideTip}
                    onClick={() => go(1)}
                  >
                    {direction === "rtl" ? <IconChevronLeft /> : <IconChevronRight />}
                  </button>
                </div>
                {/* 悬停显示进度条跳转：面板化，与 reader-menu / 底部 HUD 同一套视觉语言 */}
                {total > 0 && (
                  <div className="pointer-events-none absolute top-full z-20 pt-2 opacity-0 transition-opacity duration-150 group-hover/pager:pointer-events-auto group-hover/pager:opacity-100">
                    <div className="w-64 select-none rounded-xl border border-ink-200 bg-white px-3 py-2.5 shadow-panel dark:border-white/[0.08] dark:bg-surface-raised">
                      <input
                        type="range"
                        min={1}
                        max={total}
                        value={sliderDragValue ?? sliderPage}
                        onPointerDown={() => setSliderDragValue(sliderPage)}
                        onChange={(e) => {
                          const n = Number(e.target.value);
                          setSliderDragValue(n);
                          // 拖动中直接落位（不 align），thum 跟随指针，页码不闪跳
                          setPageIndex(Math.min(Math.max(0, n - 1), Math.max(0, total - 1)));
                        }}
                        onPointerUp={() => {
                          if (sliderDragValue == null) return;
                          setSliderDragValue(null);
                          setPageIndex((i) => alignIndex(i, spread, total));
                        }}
                        onBlur={() => {
                          if (sliderDragValue == null) return;
                          setSliderDragValue(null);
                          setPageIndex((i) => alignIndex(i, spread, total));
                        }}
                        onKeyUp={() => {
                          // 键盘方向键走 onChange（会置 drag 值），此处统一收口对齐
                          setSliderDragValue(null);
                          setPageIndex((i) => alignIndex(i, spread, total));
                        }}
                        className="reader-range w-full"
                        style={
                          {
                            "--range-pct":
                              (total > 0
                                ? ((sliderDragValue ?? sliderPage) / total) * 100
                                : 0) + "%",
                          } as CSSProperties
                        }
                        aria-label="progress"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* —— 右：AI / 阅读模式+隐藏 / 窗口，三组分隔 —— */}
            <div className="relative z-20 ml-auto flex shrink-0 items-center gap-1 pointer-events-auto">
              <div className="relative z-50">
                <button
                  type="button"
                  className={`reader-ai-trigger ${showingAi ? "is-on" : ""} ${pageEnhancing ? "is-busy" : ""}`}
                  disabled={visibleIndexes.length === 0}
                  aria-label={i18n.readerAiTooltip}
                  onMouseEnter={(e) => showTip(e, i18n.readerAiTooltip)}
                  onMouseLeave={hideTip}
                  aria-pressed={showingAi}
                  onClick={() => toggleAi()}
                >
                  <IconSparkles />
                  {showingAi && <span className="reader-ai-dot" aria-hidden="true" />}
                </button>
              </div>

              <span className="reader-bar-sep" aria-hidden="true" />

              {/* ② 阅读模式：单双页 + 方向 */}
              <div className="reader-seg" role="group" aria-label={i18n.readerSingle}>
                <button
                  type="button"
                  className={`reader-seg-item ${spread === "single" ? "is-active" : ""}`}
                  aria-label={i18n.readerSingle}
                  onMouseEnter={(e) => showTip(e, i18n.readerSingle)}
                  onMouseLeave={hideTip}
                  aria-pressed={spread === "single"}
                  onClick={() => {
                    setSpread("single");
                    setPageIndex((i) => alignIndex(i, "single", total));
                  }}
                >
                  <IconSinglePage />
                </button>
                <button
                  type="button"
                  className={`reader-seg-item ${spread === "double" ? "is-active" : ""}`}
                  aria-label={i18n.readerDouble}
                  onMouseEnter={(e) => showTip(e, i18n.readerDouble)}
                  onMouseLeave={hideTip}
                  aria-pressed={spread === "double"}
                  onClick={() => {
                    setSpread("double");
                    setPageIndex((i) => alignIndex(i, "double", total));
                  }}
                >
                  <IconDoublePage />
                </button>
                {/* 方向并入同一容器：视觉上是一个「阅读模式」组 */}
                <button
                  type="button"
                  className={`reader-seg-item ${direction === "rtl" ? "is-active" : ""}`}
                  aria-label={direction === "rtl" ? i18n.readerRtl : i18n.readerLtr}
                  onMouseEnter={(e) =>
                    showTip(e, direction === "rtl" ? i18n.readerRtl : i18n.readerLtr)
                  }
                  onMouseLeave={hideTip}
                  aria-pressed={direction === "rtl"}
                  onClick={() => setDirection((d) => (d === "ltr" ? "rtl" : "ltr"))}
                >
                  {direction === "rtl" ? <IconRtl /> : <IconLtr />}
                </button>
                {/* 隐藏工具栏：方向切换按钮右侧，快捷键 H 保留 */}
                <button
                  type="button"
                  className="reader-seg-item"
                  aria-label={i18n.readerHideBar}
                  onMouseEnter={(e) => showTip(e, i18n.readerHideBar)}
                  onMouseLeave={hideTip}
                  onClick={() => setBar(true)}
                >
                  <IconHideBar />
                </button>
              </div>

              <span className="reader-bar-sep" aria-hidden="true" />

              {/* ③ 窗口：全屏 + 更多（隐藏工具栏收进更多，快捷键 H 保留） */}
              <button
                type="button"
                className={`reader-icon-btn ${fullscreen ? "is-active" : ""}`}
                aria-label={`${fullscreen ? i18n.readerExitFullscreen : i18n.readerFullscreen}`}
                onMouseEnter={(e) =>
                  showTip(e, fullscreen ? i18n.readerExitFullscreen : i18n.readerFullscreen)
                }
                onMouseLeave={hideTip}
                onClick={() => void toggleFullscreen()}
              >
                {fullscreen ? <IconExitFullscreen /> : <IconFullscreen />}
              </button>

              {/* 更多：AI 设置 / 适应模式 / 打开文件 / 任务切换 */}
              <div className="relative z-50" ref={moreRef}>
                <button
                  type="button"
                  className={`reader-icon-btn ${moreOpen ? "is-active" : ""}`}
                  aria-label={i18n.readerMore}
                  onMouseEnter={(e) => showTip(e, i18n.readerMore)}
                  onMouseLeave={hideTip}
                  aria-expanded={moreOpen}
                  aria-haspopup="menu"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMoreOpen((v) => !v);
                  }}
                >
                  <IconMore />
                </button>
                {moreOpen && (
                  <div className="reader-menu reader-menu-wide" role="menu" onClick={(e) => e.stopPropagation()}>
                    {/* AI 设置：引擎 / 去噪 / 缓存（顶栏 AI 按钮只做开关，设置收敛于此） */}
                    <div className="px-3 pb-1 pt-2">
                      <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-ink-400 dark:text-fg-muted">
                        <IconSparkles className="h-3 w-3" />
                        {i18n.readerAiLabel}
                      </p>
                      {/* AI 关闭时设置整体降透明并禁用交互，但保持可见 */}
                      <div className={`mt-2 flex flex-col gap-3 ${enhanceOn ? "" : "pointer-events-none opacity-40"}`}>
                        {/* 引擎 */}
                        <div>
                          <p className="ai-block-title">{i18n.engine}</p>
                          <div className="ai-seg ai-seg-lg mt-1.5" role="radiogroup" aria-label={i18n.engine}>
                            <span
                              className="ai-seg-thumb"
                              aria-hidden="true"
                              style={{ transform: `translateX(calc(100% * ${engineIndex}))` }}
                            />
                            {engineOptions.map((eng) => (
                              <button
                                key={eng.id}
                                type="button"
                                role="radio"
                                aria-checked={engineId === eng.id}
                                className="ai-seg-item"
                                onClick={() => persistEngine(eng.id)}
                              >
                                <span className="ai-seg-main">{eng.main}</span>
                                <span className="ai-seg-sub">{eng.sub}</span>
                              </button>
                            ))}
                          </div>
                          {engineSwitchHint && cacheStats && cacheStats.bytes > 0 && (
                            <p className="ai-hint">{i18n.readerAiEngineCacheHint}</p>
                          )}
                        </div>
                        {/* 去噪强度 */}
                        <div>
                          <p className="ai-block-title">{i18n.readerNoiseLevel}</p>
                          <div className="ai-seg ai-seg-sm mt-1.5" role="radiogroup" aria-label={i18n.readerNoiseLevel}>
                            <span
                              className="ai-seg-thumb"
                              aria-hidden="true"
                              style={{ transform: `translateX(calc(100% * ${noiseLevel}))` }}
                            />
                            {(
                              [
                                [0, i18n.readerNoiseLight],
                                [1, i18n.readerNoiseStandard],
                                [2, i18n.readerNoiseStrong],
                                [3, i18n.readerNoiseMax],
                              ] as const
                            ).map(([n, label]) => (
                              <button
                                key={n}
                                type="button"
                                role="radio"
                                aria-checked={noiseLevel === n}
                                className={`ai-seg-item ${noiseLevel === n ? "is-active" : ""}`}
                                onClick={() => persistNoise(n)}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                        {/* 缓存信息 */}
                        <div>
                          <p className="ai-block-title">{i18n.readerAiCache}</p>
                          <div className="mt-1.5 flex items-baseline justify-between gap-2">
                            <span className="text-[12px] text-ink-500 dark:text-fg-muted">
                              {i18n.readerAiCacheLabel}
                            </span>
                            <span className="text-[12px] tabular-nums text-ink-800 dark:text-fg">
                              {cacheLine}
                            </span>
                          </div>
                          <div className="reader-cache-bar mt-1.5" aria-hidden="true">
                            <span style={{ width: `${cachePct}%` }} />
                          </div>
                          <button
                            type="button"
                            className={`ai-clear-btn ${clearConfirming ? "is-confirm" : ""}`}
                            onClick={() => void handleClearClick()}
                          >
                            {clearingCache ? (
                              <>
                                <span className="reader-ai-spin" aria-hidden="true" />
                                {i18n.readerAiClearing}
                              </>
                            ) : clearConfirming ? (
                              i18n.readerAiClearConfirm.replace("{size}", cacheSizeText(cacheStats))
                            ) : (
                              i18n.readerAiCacheClear
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="my-1 border-t border-ink-100 dark:border-white/[0.08]" />
                    <p className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-ink-400 dark:text-fg-muted">
                      {i18n.readerFitScreen}
                    </p>
                    <button
                      type="button"
                      className={`flex w-full px-3 py-2 text-left text-xs ${
                        fit === "screen"
                          ? "bg-ink-100 font-medium text-ink-900 dark:bg-surface-high dark:text-fg"
                          : "text-ink-800 hover:bg-ink-50 dark:text-fg dark:hover:bg-white/[0.06]"
                      }`}
                      onClick={() => {
                        setFit("screen");
                        smartSessionKeyRef.current = null;
                        void restoreDefaultWindowMinSize();
                        setMoreOpen(false);
                      }}
                    >
                      {i18n.readerFitScreen}
                    </button>
                    <button
                      type="button"
                      title={i18n.readerFitSmartHint}
                      className={`flex w-full flex-col items-start px-3 py-2 text-left text-xs ${
                        fit === "smart"
                          ? "bg-ink-100 font-medium text-ink-900 dark:bg-surface-high dark:text-fg"
                          : "text-ink-800 hover:bg-ink-50 dark:text-fg dark:hover:bg-white/[0.06]"
                      }`}
                      onClick={() => {
                        setMoreOpen(false);
                        // 已在 smart：按当前页再定一次窗；否则进入 smart（effect 定一次）
                        if (fit === "smart") {
                          if (pagesInView.length === 0 || fullscreen) return;
                          void fitWindowToPageUrls(
                            pagesInView.map((p) => p.url),
                            spread,
                            !barHidden,
                            false,
                          ).then(() => {
                            smartSessionKeyRef.current = `${bookKey}|${spread}`;
                          });
                        } else {
                          smartSessionKeyRef.current = null;
                          setFit("smart");
                        }
                      }}
                    >
                      <span>{i18n.readerFitSmart}</span>
                      <span className="mt-0.5 font-normal text-[10px] text-ink-400 dark:text-fg-muted">
                        {i18n.readerFitSmartHint}
                      </span>
                    </button>
                    <button
                      type="button"
                      title={i18n.readerFitCurrentHint}
                      disabled={pagesInView.length === 0 || fullscreen}
                      className="flex w-full flex-col items-start px-3 py-2 text-left text-xs text-ink-800 hover:bg-ink-50 disabled:opacity-40 dark:text-fg dark:hover:bg-white/[0.06]"
                      onClick={() => {
                        setMoreOpen(false);
                        void fitWindowToCurrentPage();
                      }}
                    >
                      <span>{i18n.readerFitCurrent}</span>
                      <span className="mt-0.5 font-normal text-[10px] text-ink-400 dark:text-fg-muted">
                        {i18n.readerFitCurrentHint}
                      </span>
                    </button>
                    {/* 清缓存已收敛到 AI 菜单（含用量进度条），此处不再重复 */}
                    <div className="my-1 border-t border-ink-100 dark:border-white/[0.08]" />
                    <button
                      type="button"
                      className="flex w-full px-3 py-2 text-left text-xs text-ink-800 hover:bg-ink-50 dark:text-fg dark:hover:bg-white/[0.06]"
                      onClick={() => {
                        setMoreOpen(false);
                        void pickFile();
                      }}
                    >
                      {i18n.readerOpenFile}
                    </button>
                    <button
                      type="button"
                      className="flex w-full px-3 py-2 text-left text-xs text-ink-800 hover:bg-ink-50 dark:text-fg dark:hover:bg-white/[0.06]"
                      onClick={() => {
                        setMoreOpen(false);
                        void pickFolder();
                      }}
                    >
                      {i18n.readerOpenFolder}
                    </button>
                    {jobs.length > 0 && (
                      <>
                        <div className="my-1 border-t border-ink-100 dark:border-white/[0.08]" />
                        <p className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-ink-400 dark:text-fg-muted">
                          {i18n.readerPickJob}
                        </p>
                        <ul className="max-h-40 overflow-auto">
                          {jobs.map((j) => {
                            const active = j.jobId === (state?.jobId ?? jobId);
                            return (
                              <li key={j.jobId}>
                                <button
                                  type="button"
                                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                                    active
                                      ? "bg-ink-100 font-medium dark:bg-surface-high"
                                      : "hover:bg-ink-50 dark:hover:bg-white/[0.06]"
                                  }`}
                                  onClick={() => {
                                    setJobId(j.jobId);
                                    sourceRef.current = "";
                                    void refreshState(j.jobId, null);
                                    setMoreOpen(false);
                                  }}
                                >
                                  <span className="min-w-0 flex-1 truncate">{jobFileName(j.source)}</span>
                                  <span className="shrink-0 text-[10px] text-ink-400">{stateLabel(j.state)}</span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {barHidden && (
        <button
          type="button"
          className="reader-no-drag absolute right-3 top-2.5 z-40 flex h-8 w-8 items-center justify-center rounded-lg border border-white/15 bg-black/50 text-white/90 backdrop-blur-sm hover:bg-black/70"
          aria-label={i18n.readerShowBar}
          onMouseEnter={(e) => showTip(e, i18n.readerShowBar)}
          onMouseLeave={hideTip}
          onClick={() => setBar(false)}
        >
          <IconShowBar />
        </button>
      )}

      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1 select-none overflow-auto bg-black"
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
          <div className="flex h-full min-h-full select-none items-center justify-center">
            {displayPages.map((p) => (
              <img
                key={`${p.index}-${p.kind}`}
                src={p.url}
                alt={p.name}
                decoding="async"
                draggable={false}
                className={
                  spread === "double"
                    ? "reader-page-img max-h-full max-w-[50%] object-contain select-none"
                    : "reader-page-img max-h-full max-w-full object-contain select-none"
                }
              />
            ))}
          </div>
        )}
      </div>

      {total > 0 && (
        <div
          className={`pointer-events-none absolute inset-x-0 bottom-0 z-20 select-none transition-opacity duration-300 ${
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
            {/* mousedown preventDefault：细条按下易变成拖选（WebKit 选区），禁止从进度条启动选区 */}
            <button
              type="button"
              aria-label={pageLabel}
              className={`block h-3 w-full cursor-pointer ${
                progressHud ? "pointer-events-auto" : "pointer-events-none"
              }`}
              onMouseDown={(e) => e.preventDefault()}
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
            <p className="pointer-events-none mt-1.5 select-none text-center text-[11px] tabular-nums text-white/80">
              {pageLabel}
            </p>
          </div>
        </div>
      )}

      {clearToast && (
        <div className="reader-toast" role="status">
          {clearToast}
        </div>
      )}

      {tip && (
        <div className="reader-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}

function jobFileName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function iconClass(extra = "") {
  return `h-4 w-4 ${extra}`.trim();
}

function IconBack() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <path d="M12.5 4.5 7 10l5.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconChevronLeft() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <path d="M12 5 7 10l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconChevronRight() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <path d="m8 5 5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconSparkles({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={iconClass(className)} fill="none" aria-hidden="true">
      <path
        d="M10 3.2c.42 2.1 1.4 3.08 3.5 3.5-2.1.42-3.08 1.4-3.5 3.5-.42-2.1-1.4-3.08-3.5-3.5 2.1-.42 3.08-1.4 3.5-3.5Z"
        fill="currentColor"
      />
      <path
        d="M16.2 11.4c.25 1.25.83 1.83 2.08 2.08-1.25.25-1.83.83-2.08 2.08-.25-1.25-.83-1.83-2.08-2.08 1.25-.25 1.83-.83 2.08-2.08Z"
        fill="currentColor"
      />
      <path
        d="M5.6 11.8c.18.9.6 1.32 1.5 1.5-.9.18-1.32.6-1.5 1.5-.18-.9-.6-1.32-1.5-1.5.9-.18 1.32-.6 1.5-1.5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconSinglePage() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <rect x="5" y="3.5" width="10" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconDoublePage() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <rect x="2.5" y="3.5" width="6.5" height="13" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
      <rect x="11" y="3.5" width="6.5" height="13" rx="1.2" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function IconLtr() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <path d="M4 10h11M11 6l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconRtl() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <path d="M16 10H5M9 6 5 10l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconFullscreen() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <path d="M4 8V4h4M12 4h4v4M16 12v4h-4M8 16H4v-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconExitFullscreen() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <path d="M8 4v4H4M12 4v4h4M8 16v-4H4M12 16v-4h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconHideBar() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      {/* 两条横线：与 ShowBar 三条横线形成「收起一行」的折叠语义 */}
      <path d="M4 7h12M4 13h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconShowBar() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <path d="M4 6.5h12M4 10h12M4 13.5h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconMore() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="10" r="1.35" />
      <circle cx="10" cy="10" r="1.35" />
      <circle cx="15" cy="10" r="1.35" />
    </svg>
  );
}
