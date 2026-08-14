import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  loadEnhanceEngine,
  loadReaderPref,
  saveEnhanceEngine,
  saveReaderPref,
  type FitMode,
  type ReadDirection,
  type SpreadMode,
} from "./prefs";
import { fitWindowToPageUrls, restoreDefaultWindowMinSize } from "./smartFit";

const BAR_KEY = "comic.reader.barHidden";

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
  const [pageEditing, setPageEditing] = useState(false);
  const [pageDraft, setPageDraft] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const [enhanceOn, setEnhanceOn] = useState(false);
  const [enhanceBusy, setEnhanceBusy] = useState(false);
  const [aiPages, setAiPages] = useState<Record<number, LoadedPage>>({});
  const [engineId, setEngineId] = useState(() => loadEnhanceEngine().engineId);
  const [cuganModel, setCuganModel] = useState(() => loadEnhanceEngine().cuganModel);
  const [catalog, setCatalog] = useState<EngineInfo[]>([]);
  const [cacheStats, setCacheStats] = useState<EnhanceCacheStats | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const aiMenuRef = useRef<HTMLDivElement>(null);
  const enhanceEpochRef = useRef(0);
  const pageInputRef = useRef<HTMLInputElement>(null);
  const progressTimer = useRef<number | null>(null);
  const sourceRef = useRef<string>("");
  const skipSaveRef = useRef(true);
  const lastCountRef = useRef(0);
  /**
   * 智能适应会话键：仅在「进入 smart / 换书 / 单双页切换」时变，
   * 翻页不变更 → 窗口不会跟页乱跳（方案 A）。
   */
  const smartSessionKeyRef = useRef<string | null>(null);
  const smartFitGen = useRef(0);

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

  const enhanceOpts = useMemo<ReaderEnhanceOptions>(
    () => ({
      engine: engineId,
      cuganModel: engineId === "realcugan" ? cuganModel : undefined,
      preset: "fast",
      scale: 2,
      noiseLevel: 0,
      tta: false,
    }),
    [engineId, cuganModel],
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
        setCatalog(c);
        const saved = loadEnhanceEngine();
        const pick =
          c.find((e) => e.id === saved.engineId && e.available) ??
          c.find((e) => e.id === "realcugan" && e.available) ??
          c.find((e) => e.available) ??
          c[0];
        if (!pick) return;
        const model =
          saved.cuganModel && pick.models.some((m) => m.id === saved.cuganModel)
            ? saved.cuganModel
            : pick.models.find((m) => m.id === "nose")?.id ??
              pick.models[0]?.id ??
              "nose";
        setEngineId(pick.id);
        setCuganModel(model);
        saveEnhanceEngine(pick.id, model);
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
    // 最小预热：阅读方向上后 2 页，再补 1 页回翻
    for (let n = 1; n <= 2; n++) {
      const idx = origin + step * n;
      if (idx < 0 || idx >= total) break;
      if (!visibleIndexes.includes(idx)) ahead.push(idx);
    }
    const behind =
      direction === "rtl"
        ? (visibleIndexes[visibleIndexes.length - 1] ?? 0) + 1
        : (visibleIndexes[0] ?? 0) - 1;
    if (
      behind >= 0 &&
      behind < total &&
      !visibleIndexes.includes(behind) &&
      !ahead.includes(behind)
    ) {
      ahead.push(behind);
    }

    const visCached = visibleIndexes.every((i) => Boolean(aiPagesRef.current[i]));
    if (visCached) setEnhanceBusy(false);

    const epoch = enhanceEpochRef.current;
    let cancelled = false;
    const stillThis = () => !cancelled && epoch === enhanceEpochRef.current;
    const isCancel = (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      return msg.includes("取消") || msg.toLowerCase().includes("cancel");
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
    cuganModel,
    state?.source,
    state?.jobId,
    state?.pageCount,
    source,
    jobId,
    // applyAiFiles / onError 用 ref，避免父组件重渲打断预热
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        if (pageEditing) {
          e.preventDefault();
          setPageEditing(false);
        } else if (moreOpen || aiMenuOpen) {
          e.preventDefault();
          setMoreOpen(false);
          setAiMenuOpen(false);
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
    aiMenuOpen,
  ]);

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

  const pagesInView = visibleIndexes
    .map((i) => (enhanceOn && aiPages[i] ? aiPages[i] : loaded[i]))
    .filter(Boolean) as LoadedPage[];
  const showingAi =
    enhanceOn &&
    visibleIndexes.length > 0 &&
    visibleIndexes.every((i) => Boolean(aiPages[i]));
  const pageEnhancing = enhanceBusy && !showingAi;
  const displayPages = direction === "rtl" ? [...pagesInView].reverse() : pagesInView;

  const persistEngine = (id: string, model: string) => {
    enhanceEpochRef.current += 1;
    void cancelReaderEnhance();
    setEngineId(id);
    setCuganModel(model);
    saveEnhanceEngine(id, model);
    setAiPages({});
  };

  const toggleAi = () => {
    if (enhanceOn) {
      setEnhanceOn(false);
      setEnhanceBusy(false);
      void cancelReaderEnhance();
      return;
    }
    if (visibleIndexes.length === 0) return;
    setEnhanceOn(true);
  };

  const clearAiCache = async () => {
    try {
      await clearReaderEnhanceCache();
      setAiPages({});
      refreshCacheStats();
      onError(null);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  const formatCache = (stats: EnhanceCacheStats | null) => {
    if (!stats) return "—";
    const mb = stats.bytes / (1024 * 1024);
    const size = mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
    return `${size} · ${stats.files} ${i18n.libraryPages}`;
  };
  const total = state?.pageCount ?? 0;

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
    if (!aiMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (aiMenuRef.current && !aiMenuRef.current.contains(t)) setAiMenuOpen(false);
    };
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", onDoc);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [aiMenuOpen]);

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
    <div className="relative flex h-full min-h-0 flex-col bg-black">
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
            moreOpen || aiMenuOpen ? "z-50" : "z-40"
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
                  title={`${backLabel ?? i18n.readerBackLibrary} (Esc)`}
                  aria-label={backLabel ?? i18n.readerBackLibrary}
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
                    aria-label="prev"
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
                      className="reader-page-chip w-[5.5rem] border-0 bg-white text-center outline-none ring-1 ring-ink-300 dark:bg-surface-raised dark:ring-white/15"
                      inputMode="numeric"
                      aria-label={i18n.readerJumpHint}
                    />
                  ) : (
                    <button
                      type="button"
                      className="reader-page-chip"
                      title={i18n.readerJumpHint}
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
                    aria-label="next"
                    onClick={() => go(1)}
                  >
                    {direction === "rtl" ? <IconChevronLeft /> : <IconChevronRight />}
                  </button>
                </div>
                {/* 悬停显示进度条跳转 */}
                {total > 0 && (
                  <div className="pointer-events-none absolute top-full z-20 mt-1 w-48 opacity-0 transition-opacity group-hover/pager:pointer-events-auto group-hover/pager:opacity-100">
                    <input
                      type="range"
                      min={1}
                      max={total}
                      value={Math.min(total, (visibleIndexes[0] ?? pageIndex) + 1)}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        setPageIndex(alignIndex(n - 1, spread, total));
                      }}
                      className="h-1 w-full cursor-pointer accent-ink-800 dark:accent-fg"
                      aria-label="progress"
                    />
                  </div>
                )}
              </div>
            </div>

            {/* —— 右：模式 / 工具 —— */}
            <div className="relative z-20 ml-auto flex shrink-0 items-center gap-1 pointer-events-auto">
              <div
                className={`reader-ai-split ${aiMenuOpen ? "is-open" : ""}`}
                ref={aiMenuRef}
              >
                <button
                  type="button"
                  className={`reader-ai-btn ${showingAi ? "is-on" : ""} ${pageEnhancing ? "is-busy" : ""}`}
                  disabled={visibleIndexes.length === 0}
                  title={i18n.readerAiOptimize}
                  onClick={() => toggleAi()}
                >
                  {pageEnhancing ? (
                    <>
                      <span className="reader-ai-spin" aria-hidden="true" />
                      {i18n.readerAiBusy}
                    </>
                  ) : showingAi ? (
                    <>
                      <span aria-hidden="true">✨</span>
                      {i18n.readerAiOn}
                    </>
                  ) : (
                    <>
                      <span aria-hidden="true">✨</span>
                      {i18n.readerAiOptimize}
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className={`reader-icon-btn reader-ai-caret ${aiMenuOpen ? "is-active" : ""}`}
                  title={i18n.readerAiModel}
                  aria-expanded={aiMenuOpen}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMoreOpen(false);
                    setAiMenuOpen((v) => !v);
                  }}
                >
                  <IconChevronDown />
                </button>
                {aiMenuOpen && (
                  <div className="reader-ai-pop" role="menu">
                    <p className="px-3 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-ink-400 dark:text-fg-muted">
                      {i18n.engine}
                    </p>
                    {(catalog.length > 0
                      ? catalog
                      : [
                          {
                            id: "realcugan",
                            label: i18n.engineCugan,
                            available: true,
                            detail: "",
                            scales: [],
                            models: [],
                          },
                          {
                            id: "waifu2x",
                            label: i18n.engineWaifu2x,
                            available: true,
                            detail: "",
                            scales: [],
                            models: [],
                          },
                        ]
                    ).map((eng) => (
                      <button
                        key={eng.id}
                        type="button"
                        disabled={eng.available === false}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                          engineId === eng.id
                            ? "bg-ink-100 font-medium text-ink-900 dark:bg-surface-high dark:text-fg"
                            : "text-ink-800 hover:bg-ink-50 dark:text-fg dark:hover:bg-white/[0.06]"
                        } disabled:opacity-40`}
                        onClick={() => {
                          const mid =
                            eng.id === "realcugan"
                              ? eng.models.some((m) => m.id === cuganModel)
                                ? cuganModel
                                : (eng.models.find((m) => m.id === "nose")?.id ??
                                  eng.models[0]?.id ??
                                  "nose")
                              : "cunet";
                          persistEngine(eng.id, mid);
                        }}
                      >
                        <span className="w-3 shrink-0 text-accent">
                          {engineId === eng.id ? <IconCheck /> : null}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {eng.id === "realcugan"
                            ? "Real-CUGAN"
                            : eng.id === "waifu2x"
                              ? "Waifu2x"
                              : eng.label}
                        </span>
                      </button>
                    ))}
                    {engineId === "realcugan" && (
                      <>
                        <div className="my-1 border-t border-ink-100 dark:border-white/[0.08]" />
                        <p className="px-3 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-ink-400 dark:text-fg-muted">
                          {i18n.cuganPack}
                        </p>
                        {(
                          catalog.find((e) => e.id === "realcugan")?.models ?? [
                            { id: "se", label: "SE（推荐 / 护网点）" },
                            { id: "pro", label: "PRO（更高质量）" },
                            { id: "nose", label: "NOSE（更快）" },
                          ]
                        ).map((m) => (
                          <button
                            key={m.id}
                            type="button"
                            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
                              cuganModel === m.id
                                ? "bg-ink-100 font-medium text-ink-900 dark:bg-surface-high dark:text-fg"
                                : "text-ink-800 hover:bg-ink-50 dark:text-fg dark:hover:bg-white/[0.06]"
                            }`}
                            onClick={() => persistEngine("realcugan", m.id)}
                          >
                            <span className="w-3 shrink-0 text-accent">
                              {cuganModel === m.id ? <IconCheck /> : null}
                            </span>
                            <span className="min-w-0 flex-1 truncate">{m.label}</span>
                          </button>
                        ))}
                      </>
                    )}
                    <div className="my-1 border-t border-ink-100 dark:border-white/[0.08]" />
                    <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                      <span className="text-[11px] text-ink-600 dark:text-fg-muted">
                        {i18n.readerAiCache}
                      </span>
                      <span className="text-[11px] tabular-nums text-ink-800 dark:text-fg">
                        {formatCache(cacheStats)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="flex w-full px-3 py-1.5 text-left text-xs text-ink-800 hover:bg-ink-50 dark:text-fg dark:hover:bg-white/[0.06]"
                      onClick={() => {
                        setAiMenuOpen(false);
                        void clearAiCache();
                      }}
                    >
                      {i18n.readerAiCacheClear}
                    </button>
                  </div>
                )}
              </div>

              {/* 单页 / 双页 图标分段 */}
              <div className="reader-seg" role="group" aria-label={i18n.readerSingle}>
                <button
                  type="button"
                  className={`reader-seg-item ${spread === "single" ? "is-active" : ""}`}
                  title={i18n.readerSingle}
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
                  title={i18n.readerDouble}
                  aria-pressed={spread === "double"}
                  onClick={() => {
                    setSpread("double");
                    setPageIndex((i) => alignIndex(i, "double", total));
                  }}
                >
                  <IconDoublePage />
                </button>
              </div>

              {/* 阅读方向 */}
              <button
                type="button"
                className={`reader-icon-btn ${direction === "rtl" ? "is-active" : ""}`}
                title={direction === "rtl" ? i18n.readerRtl : i18n.readerLtr}
                aria-label={direction === "rtl" ? i18n.readerRtl : i18n.readerLtr}
                onClick={() => setDirection((d) => (d === "ltr" ? "rtl" : "ltr"))}
              >
                {direction === "rtl" ? <IconRtl /> : <IconLtr />}
              </button>

              {/* 原「适应屏幕」位：点击隐藏顶栏 */}
              <button
                type="button"
                className="reader-icon-btn"
                title={`${i18n.readerHideBar} (H)`}
                aria-label={i18n.readerHideBar}
                onClick={() => setBar(true)}
              >
                <IconHideBar />
              </button>

              <button
                type="button"
                className={`reader-icon-btn ${fullscreen ? "is-active" : ""}`}
                title={`${fullscreen ? i18n.readerExitFullscreen : i18n.readerFullscreen} (F)`}
                onClick={() => void toggleFullscreen()}
              >
                {fullscreen ? <IconExitFullscreen /> : <IconFullscreen />}
              </button>

              {/* 更多：适应模式 / 打开文件 / 任务切换 */}
              <div className="relative z-50" ref={moreRef}>
                <button
                  type="button"
                  className={`reader-icon-btn ${moreOpen ? "is-active" : ""}`}
                  title={i18n.readerMore}
                  aria-expanded={moreOpen}
                  aria-haspopup="menu"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAiMenuOpen(false);
                    setMoreOpen((v) => !v);
                  }}
                >
                  <IconMore />
                </button>
                {moreOpen && (
                  <div className="reader-menu" role="menu" onClick={(e) => e.stopPropagation()}>
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
                    <div className="my-1 border-t border-ink-100 dark:border-white/[0.08]" />
                    <button
                      type="button"
                      className="flex w-full flex-col items-start px-3 py-2 text-left text-xs text-ink-800 hover:bg-ink-50 dark:text-fg dark:hover:bg-white/[0.06]"
                      onClick={() => {
                        setMoreOpen(false);
                        void clearAiCache();
                      }}
                    >
                      <span>{i18n.readerAiCacheClear}</span>
                      <span className="mt-0.5 font-normal text-[10px] text-ink-400 dark:text-fg-muted">
                        {i18n.readerAiCache} {formatCache(cacheStats)}
                      </span>
                    </button>
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
          title={`${i18n.readerShowBar} (H)`}
          aria-label={i18n.readerShowBar}
          onClick={() => setBar(false)}
        >
          <IconShowBar />
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
          <div className="flex h-full min-h-full items-center justify-center">
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

function IconChevronDown() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <path d="m5 8 5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden="true">
      <path d="M2.2 6.2 4.7 8.6 9.8 3.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
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
      <path d="M4 6.5h12M4 10h12M4 13.5h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="m14 12 2.5 2.5L14 17" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
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
