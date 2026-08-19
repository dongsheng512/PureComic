import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
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
import { setNativeWindowBg, startWindowDrag } from "../windowDrag";
import {
  isReaderEngine,
  loadEnhanceNoise,
  loadReaderEngine,
  loadReaderPref,
  prefHasExplicitView,
  saveEnhanceNoise,
  saveReaderEngine,
  saveReaderPref,
  loadReaderBg,
  readerBgPreset,
  READER_BG_PRESETS,
  saveReaderBg,
  type ReaderBgId,
  type ReaderViewMode,
  type FitMode,
  type ReadDirection,
  type SpreadMode,
} from "./prefs";
import { chapterIndexFromName, shouldDefaultWebtoon } from "./webtoonDetect";
import {
  estimatedHeight,
  expandStripPrefetch,
  loadStoredAspects,
  medianAspect,
  storeAspects,
  stripIndexes,
} from "./webtoonStripHelpers";
import { WebtoonStrip, type WebtoonJumpRequest } from "./WebtoonStrip";
import {
  allowCompactWindowMinSize,
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
// Keep webtoon pages readable on large screens without upscaling the source too far.
const WEBTOON_MAX_WIDTH = 960;
/** 顶栏：窄于此时把阅读模式折进「更多」 */
const BAR_COMPACT_W = 760;
/** 顶栏：更窄时只留返回 / 页码 / 更多 */
const BAR_TINY_W = 560;

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
  const [view, setView] = useState<ReaderViewMode>("page");
  const [loaded, setLoaded] = useState<Record<number, LoadedPage>>({});
  const [busy, setBusy] = useState(false);
  const [barHidden, setBarHidden] = useState(readBarHidden);
  const [fullscreen, setFullscreen] = useState(false);
  const [canvasBg, setCanvasBg] = useState<ReaderBgId>(loadReaderBg);
  const canvasPreset = readerBgPreset(canvasBg);
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
  const barRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(0);
  const [stripWidth, setStripWidth] = useState(0);
  const [webtoonVisibleIndexes, setWebtoonVisibleIndexes] = useState<number[]>([]);
  const [jumpRequest, setJumpRequest] = useState<WebtoonJumpRequest | null>(null);
  const enhanceEpochRef = useRef(0);
  const pageInputRef = useRef<HTMLInputElement>(null);
  const progressTimer = useRef<number | null>(null);
  const aspectMap = useRef<Map<number, number>>(new Map());
  const aspectMedianRef = useRef<number | null>(null);
  const jumpSeqRef = useRef(0);
  const aspectPersistTimer = useRef<number | null>(null);
  const inflightPagesRef = useRef<Set<number>>(new Set());
  const prepareBookEpochRef = useRef(0);
  const decodedUrlsRef = useRef<Set<string>>(new Set());
  const skipProgressFlashRef = useRef(false);
  const sourceRef = useRef<string>("");
  const skipSaveRef = useRef(true);
  const lastCountRef = useRef(0);
  const didSuggestViewRef = useRef<string | null>(null);
  const detectionPagesRef = useRef<ReaderState["pages"]>([]);
  detectionPagesRef.current = state?.pages ?? [];
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

  // 切换工具栏可见性后，清掉旧按钮留下的 tooltip，避免提示悬浮在画布上。
  useEffect(() => {
    hideTip();
  }, [barHidden, hideTip]);

  /**
   * 智能适应会话键：仅在「进入 smart / 换书 / 单双页切换」时变，
   * 翻页不变更 → 窗口不会跟页乱跳（方案 A）。
   */
  const smartSessionKeyRef = useRef<string | null>(null);
  const smartFitGen = useRef(0);
  const wasWebtoonRef = useRef(false);

  const immersive = barHidden || fullscreen;

  // 工具栏高度单一来源：smartFit.ts 常量 → CSS 变量（.reader-bar 引用）
  useEffect(() => {
    syncReaderBarHeightCss();
  }, []);

  useEffect(() => {
    if (barHidden) return;
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setBarWidth(w);
    });
    ro.observe(el);
    setBarWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [barHidden]);

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

  // The reader owns the native window surface while mounted so macOS rounded
  // corners follow the canvas preset instead of the application theme.
  useEffect(() => {
    document.documentElement.setAttribute("data-reader-open", "");
    return () => {
      document.documentElement.removeAttribute("data-reader-open");
      const appBg = localStorage.getItem("comic.theme") === "light" ? "#FFFFFF" : "#212121";
      setNativeWindowBg(appBg);
    };
  }, []);

  useEffect(() => {
    setNativeWindowBg(canvasPreset.hex);
  }, [canvasPreset.hex]);

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

  const statePageLength = state?.pages.length ?? 0;
  const firstPageName = state?.pages[0]?.name ?? "";
  useEffect(() => {
    if (!state?.source) return;
    const bookChanged = sourceRef.current !== state.source;
    const countAppeared = lastCountRef.current === 0 && state.pageCount > 0;
    const namesReady = statePageLength > 0;
    const explicitView = prefHasExplicitView(state.source);
    const canSuggestView =
      namesReady &&
      !explicitView &&
      didSuggestViewRef.current !== state.source &&
      shouldDefaultWebtoon(detectionPagesRef.current);
    lastCountRef.current = state.pageCount;
    if (!bookChanged && !countAppeared && !canSuggestView) return;
    if (bookChanged) {
      sourceRef.current = state.source;
      lastCountRef.current = state.pageCount;
      didSuggestViewRef.current = null;
      setLoaded({});
      if (aspectPersistTimer.current != null) window.clearTimeout(aspectPersistTimer.current);
      aspectMap.current = loadStoredAspects(state.source);
      aspectMedianRef.current = medianAspect(Array.from(aspectMap.current.values()));
      setWebtoonVisibleIndexes([]);
      setJumpRequest(null);
      inflightPagesRef.current.clear();
      decodedUrlsRef.current.clear();
      prepareBookEpochRef.current += 1;
      jumpSeqRef.current = 0;
      setEnhanceOn(false);
      setAiPages({});
      setEnhanceBusy(false);
      enhanceEpochRef.current += 1;
    }
    if (state.pageCount <= 0) return;
    const pref = loadReaderPref(state.source);
    const storedView: ReaderViewMode = pref.view ?? "page";
    const shouldSuggest =
      namesReady &&
      !explicitView &&
      didSuggestViewRef.current !== state.source &&
      shouldDefaultWebtoon(detectionPagesRef.current);
    const suggestedView = shouldSuggest ? "webtoon" : storedView;
    if (shouldSuggest) didSuggestViewRef.current = state.source;
    skipSaveRef.current = true;
    setSpread(pref.spread);
    setDirection(pref.direction);
    setFit(pref.fit);
    setView(suggestedView);
    const initialPage = alignIndex(
      pref.pageIndex,
      suggestedView === "webtoon" ? "single" : pref.spread,
      state.pageCount,
    );
    if (suggestedView === "webtoon") {
      const seq = ++jumpSeqRef.current;
      setJumpRequest({ seq, index: initialPage, align: "start" });
    } else {
      setJumpRequest(null);
    }
    if (suggestedView !== storedView) {
      saveReaderPref(state.source, { ...pref, view: suggestedView }, { persistView: true });
    }
    setPageIndex(initialPage);
  }, [state?.source, state?.pageCount, statePageLength, firstPageName]);

  useEffect(() => {
    if (!state?.source) return;
    if (skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }
    saveReaderPref(state.source, { pageIndex, spread, direction, fit, view });
  }, [state?.source, pageIndex, spread, direction, fit, view]);

  const webtoon = view === "webtoon";
  const effectiveSpread: SpreadMode = webtoon ? "single" : spread;
  const prefetchRtl = !webtoon && direction === "rtl";

  // 只依赖页数而不是整个 ReaderState：任务进度轮询会创建新的 state 对象，
  // 但不会改变可见页。保持数组引用稳定，避免预加载 effect 被无意义地重启。
  const pageCount = state?.pageCount ?? 0;
  const visibleIndexes = useMemo(() => {
    if (pageCount <= 0) return [] as number[];
    const i = alignIndex(pageIndex, effectiveSpread, pageCount);
    if (effectiveSpread === "double" && i + 1 < pageCount) return [i, i + 1];
    return [i];
  }, [pageCount, pageIndex, effectiveSpread]);

  const webtoonPrefetchIndexes = useMemo(() => {
    if (!webtoon || pageCount <= 0) return [];
    return webtoonVisibleIndexes.length > 0
      ? webtoonVisibleIndexes
      : stripIndexes(pageIndex, pageCount);
  }, [pageCount, pageIndex, webtoon, webtoonVisibleIndexes]);

  const prefetchIndexes = useMemo(() => {
    if (pageCount <= 0) return visibleIndexes;
    if (webtoon) {
      return expandStripPrefetch(webtoonPrefetchIndexes, pageCount, 4);
    }
    const extra: number[] = [];
    const origin =
      prefetchRtl
        ? (visibleIndexes[0] ?? 0)
        : (visibleIndexes[visibleIndexes.length - 1] ?? 0);
    const step = prefetchRtl ? -1 : 1;
    const aheadN = 4;
    for (let d = 1; d <= aheadN; d++) {
      const n = origin + step * d;
      if (n < 0 || n >= pageCount) break;
      if (!visibleIndexes.includes(n)) extra.push(n);
    }
    const back =
      prefetchRtl
        ? (visibleIndexes[visibleIndexes.length - 1] ?? 0) + 1
        : (visibleIndexes[0] ?? 0) - 1;
    if (
      back >= 0 &&
      back < pageCount &&
      !visibleIndexes.includes(back) &&
      !extra.includes(back)
    ) {
      extra.push(back);
    }
    return [...visibleIndexes, ...extra];
  }, [pageCount, visibleIndexes, prefetchRtl, webtoon, webtoonPrefetchIndexes]);

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
      const aiLimit = webtoon ? 8 : 80;
      const aiHalf = webtoon ? 4 : 40;
      if (keys.length > aiLimit) {
        for (const k of keys) {
          if (Math.abs(k - pageIndex) > aiHalf) delete next[k];
        }
      }
      return next;
    });
  }, [pageIndex, webtoon]);

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
      prefetchRtl
        ? (visibleIndexes[0] ?? 0)
        : (visibleIndexes[visibleIndexes.length - 1] ?? 0);
    const step = prefetchRtl ? -1 : 1;
    // 单页：前方 2 + 回翻 1。双页按整屏走：前方 4（两屏）+ 回翻 2（上一屏）
    const aheadCount = webtoon ? 2 : visibleIndexes.length >= 2 ? 4 : 2;
    const behindCount = webtoon ? 2 : visibleIndexes.length >= 2 ? 2 : 1;
    for (let n = 1; n <= aheadCount; n++) {
      const idx = origin + step * n;
      if (idx < 0 || idx >= total) break;
      if (!visibleIndexes.includes(idx)) ahead.push(idx);
    }
    for (let n = 1; n <= behindCount; n++) {
      const idx =
        prefetchRtl
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
    visibleIndexes,
    prefetchRtl,
    enhanceOpts,
    state?.source,
    state?.jobId,
    state?.pageCount,
    source,
    jobId,
    onError,
    refreshCacheStats,
    webtoon,
  ]);

  useEffect(() => {
    const bookEpoch = prepareBookEpochRef.current;
    const stillThisBook = () => bookEpoch === prepareBookEpochRef.current;
    const jid = state?.jobId ?? jobId;
    const src = state?.source ?? source;
    if (!src && !jid) return;

    const need = (idx: number) => {
      if (inflightPagesRef.current.has(idx)) return false;
      const existing = loadedRef.current[idx];
      return !existing || existing.kind !== "original";
    };

    const apply = (files: { index: number; name: string; kind: string; path: string }[]) => {
      if (!stillThisBook() || files.length === 0) return;
      setLoaded((prev) => {
        const next = { ...prev };
        for (const file of files) {
          next[file.index] = { ...file, url: fileUrl(file.path, file.kind) };
        }
        // 原图页 LRU 窗口：翻完超长书后 loaded 无限膨胀（与 aiPages 同思路）
        const keys = Object.keys(next).map(Number);
        const center = pageIndexRef.current;
        const visible = webtoonVisibleIndexes.length;
        const limit = webtoon ? Math.max(28, visible + 12) : LOADED_WINDOW;
        const half = webtoon ? Math.max(8, Math.ceil(visible / 2) + 6) : LOADED_HALF_WINDOW;
        if (keys.length > limit) {
          for (const k of keys) {
            if (Math.abs(k - center) > half) delete next[k];
          }
        }
        return next;
      });
    };

    const mark = (indexes: number[], on: boolean) => {
      for (const index of indexes) {
        if (on) inflightPagesRef.current.add(index);
        else inflightPagesRef.current.delete(index);
      }
    };

    (async () => {
      const urgent = (webtoon ? webtoonVisibleIndexes : visibleIndexes).filter(need);
      const rest = prefetchIndexes.filter((i) => !urgent.includes(i) && need(i));
      try {
        if (urgent.length > 0) {
          if (!webtoon) setBusy(true);
          mark(urgent, true);
          try {
            const files = await prepareReaderPages({
              jobId: jid,
              source: src,
              pageIndexes: urgent,
              preferOriginal: true,
            });
            apply(files);
          } finally {
            mark(urgent, false);
          }
        }
      } catch (e) {
        if (stillThisBook()) onError(e instanceof Error ? e.message : String(e));
      } finally {
        if (stillThisBook() && !webtoon) setBusy(false);
      }
      if (!stillThisBook() || rest.length === 0) return;
      mark(rest, true);
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
      } finally {
        mark(rest, false);
      }
    })();
    // Sliding the strip must not abort in-flight extracts: cancelled applies
    // left holes that remounted as placeholders and flashed the canvas.
  }, [
    visibleIndexes,
    webtoonVisibleIndexes,
    prefetchIndexes,
    state?.source,
    state?.jobId,
    state?.pagesDone,
    jobId,
    source,
    onError,
    webtoon,
  ]);

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
    if (skipProgressFlashRef.current) {
      skipProgressFlashRef.current = false;
      return;
    }
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
      setPageIndex((i) => stepIndex(i, dir, effectiveSpread, state.pageCount));
    },
    [state, effectiveSpread],
  );

  const persistAspects = useCallback(() => {
    const source = sourceRef.current;
    if (!source) return;
    if (aspectPersistTimer.current != null) window.clearTimeout(aspectPersistTimer.current);
    aspectPersistTimer.current = window.setTimeout(() => {
      aspectPersistTimer.current = null;
      storeAspects(source, aspectMap.current);
    }, 400);
  }, []);

  const estimatedStripHeight = useCallback((index: number): number => {
    const aspect = aspectMap.current.get(index) ?? aspectMedianRef.current ?? undefined;
    const width = stripWidth > 0 ? stripWidth : (viewportRef.current?.clientWidth ?? WEBTOON_MAX_WIDTH);
    return estimatedHeight(width, WEBTOON_MAX_WIDTH, aspect);
  }, [stripWidth]);

  const handleWebtoonImageLoad = useCallback(
    (index: number, image: HTMLImageElement) => {
      const naturalWidth = Math.max(1, image.naturalWidth);
      const naturalHeight = Math.max(1, image.naturalHeight);
      const aspect = naturalHeight / naturalWidth;
      if (!Number.isFinite(aspect) || aspect <= 0) return;
      const previous = aspectMap.current.get(index);
      aspectMap.current.set(index, aspect);
      if (previous == null || Math.abs(previous - aspect) > 0.002) {
        aspectMedianRef.current = medianAspect(Array.from(aspectMap.current.values()));
        persistAspects();
      }
    },
    [persistAspects],
  );

  const handleWebtoonPageChange = useCallback(
    (index: number, meta: { fromScroll: boolean }) => {
      if (!webtoon || !meta.fromScroll || index === pageIndexRef.current) return;
      skipProgressFlashRef.current = true;
      setPageIndex(index);
    },
    [webtoon],
  );

  const requestScrollToPage = useCallback(
    (index: number, where: "top" | "bottom") => {
      const seq = ++jumpSeqRef.current;
      setJumpRequest({ seq, index, align: where === "bottom" ? "end" : "start" });
      skipProgressFlashRef.current = true;
      setPageIndex(index);
    },
    [],
  );

  const scrollOrTurn = useCallback(
    (dir: 1 | -1) => {
      if (!webtoon) {
        go(dir);
        return;
      }
      const el = viewportRef.current;
      if (!el) return;
      el.scrollBy({ top: dir * el.clientHeight * 0.9, behavior: "auto" });
    },
    [go, webtoon],
  );

  const toggleView = useCallback(() => {
    const next = view === "webtoon" ? "page" : "webtoon";
    if (next === "webtoon") {
      const seq = ++jumpSeqRef.current;
      setJumpRequest({ seq, index: pageIndexRef.current, align: "start" });
    } else {
      setJumpRequest(null);
    }
    setView(next);
    const prefSource = state?.source ?? source;
    if (prefSource) {
      saveReaderPref(
        prefSource,
        { pageIndex, spread, direction, fit, view: next },
        { persistView: true },
      );
    }
  }, [direction, fit, pageIndex, source, spread, state?.source, view]);

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
      if (webtoon && (e.key === "ArrowDown" || e.key === " " || e.key === "PageDown" || e.key === "ArrowRight")) {
        e.preventDefault();
        scrollOrTurn(1);
        return;
      } else if (webtoon && (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "ArrowLeft")) {
        e.preventDefault();
        scrollOrTurn(-1);
        return;
      } else if (e.key === "ArrowRight") {
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
        if (webtoon) requestScrollToPage(0, "top");
        else setPageIndex(0);
      } else if (e.key === "End" && state) {
        e.preventDefault();
        const last = alignIndex(state.pageCount - 1, effectiveSpread, state.pageCount);
        if (webtoon) requestScrollToPage(last, "bottom");
        else setPageIndex(last);
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
    effectiveSpread,
    webtoon,
    scrollOrTurn,
    requestScrollToPage,
    state,
    barHidden,
    fullscreen,
    setBar,
    toggleFullscreen,
    onClose,
    pageEditing,
    moreOpen,
    toggleAi,
    toggleView,
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

  const handleWebtoonVisibleIndexes = useCallback((indexes: number[]) => {
    setWebtoonVisibleIndexes((previous) => {
      if (previous.length === indexes.length && previous.every((value, i) => value === indexes[i])) {
        return previous;
      }
      return indexes;
    });
  }, []);

  useEffect(() => {
    return () => {
      if (aspectPersistTimer.current != null) window.clearTimeout(aspectPersistTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!webtoon) return;
    const el = viewportRef.current;
    if (!el) return;
    setStripWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setStripWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [webtoon]);

  useEffect(() => {
    if (!webtoon) return;
    const decoded = decodedUrlsRef.current;
    for (const index of prefetchIndexes) {
      const page = enhanceOn && aiPages[index] ? aiPages[index] : loaded[index];
      if (!page || decoded.has(page.url)) continue;
      const warm = new Image();
      warm.decoding = "async";
      warm.src = page.url;
      decoded.add(page.url);
    }
    if (decoded.size > 80) {
      const keep = new Set<string>();
      for (const index of prefetchIndexes) {
        const page = enhanceOn && aiPages[index] ? aiPages[index] : loaded[index];
        if (page) keep.add(page.url);
      }
      decodedUrlsRef.current = keep;
    }
  }, [aiPages, enhanceOn, loaded, prefetchIndexes, webtoon]);

  const showingAi =
    enhanceOn &&
    visibleIndexes.length > 0 &&
    visibleIndexes.every((i) => Boolean(aiPages[i]));
  const pageEnhancing = enhanceBusy && !showingAi;
  const displayPages = webtoon
    ? pagesInView
    : direction === "rtl"
      ? [...pagesInView].reverse()
      : pagesInView;
  const webtoonPages = useMemo(() => {
    const sourcePages = enhanceOn ? { ...loaded, ...aiPages } : loaded;
    const next: Record<number, LoadedPage> = {};
    for (const index of prefetchIndexes) {
      const page = sourcePages[index];
      if (page) next[index] = page;
    }
    return next;
  }, [aiPages, enhanceOn, loaded, prefetchIndexes]);
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
    if (view === "webtoon") {
      wasWebtoonRef.current = true;
      void allowCompactWindowMinSize();
      return;
    }
    if (wasWebtoonRef.current) {
      wasWebtoonRef.current = false;
      void restoreDefaultWindowMinSize();
      return;
    }
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
  }, [fit, fullscreen, spread, view, bookKey, pageUrlsKey === "" ? "" : "ready"]);

  /** 方案 B：贴合当前页 — 一次性 resize（可居中），然后回到适应屏幕 */
  const fitWindowToCurrentPage = useCallback(async () => {
    if (view === "webtoon" || pagesInView.length === 0 || fullscreen) return;
    try {
      await fitWindowToPageUrls(
        pagesInView.map((p) => p.url),
        effectiveSpread,
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
  }, [pagesInView, effectiveSpread, barHidden, fullscreen, view]);

  // Chapter_000 is index 0 and is shown to readers as 第 1 话 / Ch. 1.
  const currentChapter = chapterIndexFromName(state?.pages[visibleIndexes[0] ?? pageIndex]?.name ?? "");
  const barCompact = barWidth > 0 && barWidth < BAR_COMPACT_W;
  const barTiny = barWidth > 0 && barWidth < BAR_TINY_W;
  const chapterLabel =
    barCompact || !webtoon || currentChapter == null
      ? ""
      : ` · ${i18n.readerChapter.replace("{n}", String(currentChapter + 1))}`;
  const pageLabel =
    effectiveSpread === "double" && visibleIndexes.length === 2
      ? `${visibleIndexes[0] + 1}–${visibleIndexes[1] + 1} / ${total}${chapterLabel}`
      : `${(visibleIndexes[0] ?? 0) + 1} / ${total || "—"}${chapterLabel}`;

  const clickNavWebtoon = (clientY: number, rect: DOMRect) => {
    const y = (clientY - rect.top) / rect.height;
    if (y < 0.35) void scrollOrTurn(-1);
    else if (y > 0.65) void scrollOrTurn(1);
  };

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
    if (webtoon) requestScrollToPage(alignIndex(idx, effectiveSpread, total), "top");
    else setPageIndex(alignIndex(idx, effectiveSpread, total));
  };

  const commitPageJump = () => {
    const n = Number.parseInt(pageDraft.replace(/[^\d]/g, ""), 10);
    setPageEditing(false);
    if (!Number.isFinite(n) || total <= 0) return;
    if (webtoon) requestScrollToPage(alignIndex(n - 1, effectiveSpread, total), "top");
    else setPageIndex(alignIndex(n - 1, effectiveSpread, total));
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
  const canNext = !!state && pageIndex < Math.max(0, total - (effectiveSpread === "double" ? 2 : 1));
  const fitLocked = webtoon;

  const readingModeSeg = (
    <div className="reader-seg" role="group" aria-label={i18n.readerMode}>
      <button
        type="button"
        className={`reader-seg-item ${effectiveSpread === "single" ? "is-active" : ""} disabled:opacity-35`}
        aria-label={i18n.readerSingle}
        onMouseEnter={(e) => showTip(e, i18n.readerSingle)}
        onMouseLeave={hideTip}
        aria-pressed={effectiveSpread === "single"}
        disabled={webtoon}
        title={webtoon ? i18n.readerWebtoonHint : undefined}
        onClick={() => {
          setSpread("single");
          setPageIndex((i) => alignIndex(i, "single", total));
        }}
      >
        <IconSinglePage />
      </button>
      <button
        type="button"
        className={`reader-seg-item ${effectiveSpread === "double" ? "is-active" : ""} disabled:opacity-35`}
        aria-label={i18n.readerDouble}
        onMouseEnter={(e) => showTip(e, i18n.readerDouble)}
        onMouseLeave={hideTip}
        aria-pressed={effectiveSpread === "double"}
        disabled={webtoon}
        title={webtoon ? i18n.readerWebtoonNoDouble : undefined}
        onClick={() => {
          setSpread("double");
          setPageIndex((i) => alignIndex(i, "double", total));
        }}
      >
        <IconDoublePage />
      </button>
      <button
        type="button"
        className={`reader-seg-item ${direction === "rtl" ? "is-active" : ""} disabled:opacity-35`}
        aria-label={direction === "rtl" ? i18n.readerRtl : i18n.readerLtr}
        onMouseEnter={(e) =>
          showTip(e, direction === "rtl" ? i18n.readerRtl : i18n.readerLtr)
        }
        onMouseLeave={hideTip}
        aria-pressed={direction === "rtl"}
        disabled={webtoon}
        title={webtoon ? i18n.readerWebtoonNoRtl : undefined}
        onClick={() => setDirection((d) => (d === "ltr" ? "rtl" : "ltr"))}
      >
        {direction === "rtl" ? <IconRtl /> : <IconLtr />}
      </button>
      <button
        type="button"
        className={`reader-seg-item ${webtoon ? "is-active" : ""}`}
        aria-label={i18n.readerWebtoon}
        aria-pressed={webtoon}
        title={i18n.readerWebtoonHint}
        onMouseEnter={(e) => showTip(e, i18n.readerWebtoonHint)}
        onMouseLeave={hideTip}
        onClick={toggleView}
      >
        <IconWebtoon />
      </button>
      <button
        type="button"
        className="reader-seg-item"
        aria-label={i18n.readerHideBar}
        onMouseEnter={(e) => showTip(e, i18n.readerHideBar)}
        onMouseLeave={hideTip}
        onClick={() => {
          hideTip();
          setMoreOpen(false);
          setBar(true);
        }}
      >
        <IconHideBar />
      </button>
    </div>
  );

  const pagerControls = (
    <div className="pointer-events-auto group/pager flex flex-col items-center">
      <div className="flex items-center gap-0.5">
        {!barTiny && (
          <button
            type="button"
            className="reader-icon-btn"
            disabled={!canPrev}
            aria-label={i18n.readerPrevPage}
            onMouseEnter={(e) => showTip(e, i18n.readerPrevPage)}
            onMouseLeave={hideTip}
            onClick={() => {
              if (webtoon) requestScrollToPage(Math.max(0, pageIndex - 1), "top");
              else go(-1);
            }}
          >
            {direction === "rtl" ? <IconChevronRight /> : <IconChevronLeft />}
          </button>
        )}
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
            className={`reader-page-chip ${barTiny ? "reader-page-chip-sm" : ""}`}
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
        {!barTiny && (
          <button
            type="button"
            className="reader-icon-btn"
            disabled={!canNext}
            aria-label={i18n.readerNextPage}
            onMouseEnter={(e) => showTip(e, i18n.readerNextPage)}
            onMouseLeave={hideTip}
            onClick={() => {
              if (webtoon) requestScrollToPage(Math.min(Math.max(0, total - 1), pageIndex + 1), "top");
              else go(1);
            }}
          >
            {direction === "rtl" ? <IconChevronLeft /> : <IconChevronRight />}
          </button>
        )}
      </div>
      {total > 0 && !barTiny && (
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
              }}
              onPointerUp={() => {
                if (sliderDragValue == null) return;
                const idx = alignIndex(sliderDragValue - 1, effectiveSpread, total);
                setSliderDragValue(null);
                if (webtoon) requestScrollToPage(idx, "top");
                else setPageIndex(idx);
              }}
              onBlur={() => {
                if (sliderDragValue == null) return;
                const idx = alignIndex(sliderDragValue - 1, effectiveSpread, total);
                setSliderDragValue(null);
                if (webtoon) requestScrollToPage(idx, "top");
                else setPageIndex(idx);
              }}
              onKeyUp={(e) => {
                if (sliderDragValue == null) return;
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") {
                  return;
                }
                const idx = alignIndex(sliderDragValue - 1, effectiveSpread, total);
                setSliderDragValue(null);
                if (webtoon) requestScrollToPage(idx, "top");
                else setPageIndex(idx);
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
  );

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      data-reader-open=""
      data-reader-fg={canvasPreset.onDark ? "light" : "dark"}
      style={{
        backgroundColor: canvasPreset.hex,
        ["--reader-canvas" as string]: canvasPreset.hex,
      }}
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
          ref={barRef}
          className={`reader-bar relative shrink-0 border-b border-ink-200/70 bg-ink-100/95 pr-2 backdrop-blur-md dark:border-white/[0.08] dark:bg-surface/95 ${
            barTiny ? "pl-[72px]" : "pl-[88px]"
          } ${moreOpen ? "z-50" : "z-40"}`}
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
            <div
              className={`relative z-20 flex min-w-0 shrink-0 items-center gap-1 pointer-events-none ${
                barCompact ? "" : "max-w-[28%] sm:max-w-[32%]"
              }`}
            >
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
              {!barCompact &&
                (displayTitle ? (
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
                ))}
              {!barCompact && temporary && (
                <span className="pointer-events-none shrink-0 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-100">
                  {i18n.externalTempBadge}
                </span>
              )}
            </div>

            {barCompact ? (
              <div className="relative z-10 mx-1 flex min-w-0 flex-1 justify-center">{pagerControls}</div>
            ) : (
              <div className="pointer-events-none absolute inset-x-0 z-10 flex justify-center">
                {pagerControls}
              </div>
            )}

            {/* —— 右：宽屏完整控件；窄屏折进「更多」 —— */}
            <div className="relative z-20 ml-auto flex shrink-0 items-center gap-1 pointer-events-auto">
              {!barTiny && (
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
              )}

              {!barCompact && (
                <>
                  <span className="reader-bar-sep" aria-hidden="true" />
                  {readingModeSeg}
                  <span className="reader-bar-sep" aria-hidden="true" />
                </>
              )}

              {!barTiny && (
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
              )}

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
                    {barCompact && (
                      <div className="border-b border-ink-100 px-3 pb-2 pt-2 dark:border-white/[0.08]">
                        <p className="text-[10px] font-medium uppercase tracking-wide text-ink-400 dark:text-fg-muted">
                          {i18n.readerMode}
                        </p>
                        <div className="mt-1.5">{readingModeSeg}</div>
                        {barTiny && (
                          <div className="mt-2 flex flex-col">
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-xs text-ink-800 hover:bg-ink-50 dark:text-fg dark:hover:bg-white/[0.06]"
                              onClick={() => {
                                toggleAi();
                                setMoreOpen(false);
                              }}
                            >
                              <IconSparkles />
                              {i18n.readerAiLabel}
                            </button>
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left text-xs text-ink-800 hover:bg-ink-50 dark:text-fg dark:hover:bg-white/[0.06]"
                              onClick={() => {
                                void toggleFullscreen();
                                setMoreOpen(false);
                              }}
                            >
                              {fullscreen ? <IconExitFullscreen /> : <IconFullscreen />}
                              {fullscreen ? i18n.readerExitFullscreen : i18n.readerFullscreen}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {/* AI 设置：引擎 / 去噪 / 缓存（顶栏 AI 按钮只做开关，设置收敛于此） */}
                    <div className="px-3 pb-1 pt-2">
                      <p className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-ink-400 dark:text-fg-muted">
                        <IconSparkles className="h-3 w-3" />
                        {i18n.readerAiLabel}
                      </p>
                      {/* AI 关闭时只禁用引擎和降噪选项；缓存管理始终可用 */}
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
                      </div>
                      {/* 缓存信息：不依赖 AI 开关，关闭 AI 时也可以清理历史缓存 */}
                      <div className="mt-3">
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
                    <div className="mt-3 border-t border-ink-100 px-3 pt-3 dark:border-white/[0.08]">
                      <p className="px-0 py-1 text-[10px] font-medium uppercase tracking-wide text-ink-400 dark:text-fg-muted">
                        {i18n.readerBg}
                      </p>
                      <div className="mt-1.5 flex items-center gap-2" role="radiogroup" aria-label={i18n.readerBg}>
                        {READER_BG_PRESETS.map((preset) => {
                          const active = canvasBg === preset.id;
                          const label =
                            preset.id === "black"
                              ? i18n.readerBgBlack
                              : preset.id === "dark"
                                ? i18n.readerBgDark
                                : preset.id === "white"
                                  ? i18n.readerBgWhite
                                  : i18n.readerBgSepia;
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              aria-label={label}
                              title={label}
                              className={`relative h-6 w-6 rounded-full border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 dark:focus-visible:ring-offset-surface-raised ${
                                preset.onDark ? "border-white/25" : "border-ink-300"
                              }`}
                              style={{ backgroundColor: preset.hex }}
                              onClick={() => {
                                setCanvasBg(preset.id);
                                saveReaderBg(preset.id);
                                setNativeWindowBg(preset.hex);
                              }}
                            >
                              {active && (
                                <svg
                                  viewBox="0 0 20 20"
                                  className={`absolute inset-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 ${
                                    preset.onDark ? "text-white" : "text-ink-900"
                                  }`}
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.4"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                >
                                  <path d="m5.2 10.2 3.1 3.1 6.5-6.6" />
                                </svg>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="my-1 border-t border-ink-100 dark:border-white/[0.08]" />
                    <p className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-ink-400 dark:text-fg-muted">
                      {i18n.readerFitScreen}
                    </p>
                    <button
                      type="button"
                      disabled={fitLocked}
                      title={fitLocked ? i18n.readerWebtoonFitLocked : undefined}
                      className={`flex w-full px-3 py-2 text-left text-xs disabled:opacity-40 ${
                        fit === "screen"
                          ? "bg-ink-100 font-medium text-ink-900 dark:bg-surface-high dark:text-fg"
                          : "text-ink-800 hover:bg-ink-50 dark:text-fg dark:hover:bg-white/[0.06]"
                      }`}
                      onClick={() => {
                        if (fitLocked) return;
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
                      disabled={fitLocked}
                      title={fitLocked ? i18n.readerWebtoonFitLocked : i18n.readerFitSmartHint}
                      className={`flex w-full flex-col items-start px-3 py-2 text-left text-xs disabled:opacity-40 ${
                        fit === "smart"
                          ? "bg-ink-100 font-medium text-ink-900 dark:bg-surface-high dark:text-fg"
                          : "text-ink-800 hover:bg-ink-50 dark:text-fg dark:hover:bg-white/[0.06]"
                      }`}
                      onClick={() => {
                        if (fitLocked) return;
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
                      title={fitLocked ? i18n.readerWebtoonFitLocked : i18n.readerFitCurrentHint}
                      disabled={fitLocked || pagesInView.length === 0 || fullscreen}
                      className="flex w-full flex-col items-start px-3 py-2 text-left text-xs text-ink-800 hover:bg-ink-50 disabled:opacity-40 dark:text-fg dark:hover:bg-white/[0.06]"
                      onClick={() => {
                        if (fitLocked) return;
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
          className="reader-no-drag absolute right-3 top-2.5 z-40 flex h-8 w-8 items-center justify-center rounded-lg border border-white/15 bg-black/35 text-white/85 backdrop-blur-sm hover:bg-black/60"
          aria-label={i18n.readerShowBar}
          onMouseEnter={(e) => showTip(e, i18n.readerShowBar)}
          onMouseLeave={hideTip}
          onClick={() => {
            hideTip();
            setBar(false);
          }}
        >
          <IconShowBar />
        </button>
      )}

      <div
        ref={viewportRef}
        className="reader-viewport relative min-h-0 flex-1 select-none overflow-auto"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          if (webtoon) {
            const target = e.target;
            if (!(target instanceof HTMLImageElement) || !target.classList.contains("reader-page-img")) return;
            clickNavWebtoon(e.clientY, rect);
          } else clickNav(e.clientX, rect);
        }}
      >
        {!state && (
          <div className={`grid h-full place-items-center px-6 text-center text-sm ${canvasPreset.onDark ? "text-white/45" : "text-ink-500"}`}>
            {i18n.readerHint}
          </div>
        )}
        {state && (webtoon ? pageCount <= 0 : displayPages.length === 0) && (
          <div className={`grid h-full place-items-center text-sm ${canvasPreset.onDark ? "text-white/45" : "text-ink-500"}`}>
            {busy ? i18n.readerLoading : i18n.readerWaitingExtract}
          </div>
        )}
        {state && (webtoon ? pageCount > 0 : displayPages.length > 0) && (
          webtoon ? (
            <WebtoonStrip
              pageCount={pageCount}
              pageIndex={pageIndex}
              pages={webtoonPages}
              maxWidth={WEBTOON_MAX_WIDTH}
              canvasHex={canvasPreset.hex}
              sourceKey={state.source ?? source ?? ""}
              contentWidth={stripWidth}
              viewportRef={viewportRef}
              jumpRequest={jumpRequest}
              estimateSize={estimatedStripHeight}
              onImageLoad={handleWebtoonImageLoad}
              onVisibleIndexes={handleWebtoonVisibleIndexes}
              onPageChange={handleWebtoonPageChange}
            />
          ) : (
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
          )
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

function IconWebtoon() {
  return (
    <svg viewBox="0 0 20 20" className={iconClass()} fill="none" aria-hidden="true">
      <rect x="6" y="2.5" width="8" height="5" rx="1" stroke="currentColor" strokeWidth="1.35" />
      <rect x="6" y="8.25" width="8" height="5" rx="1" stroke="currentColor" strokeWidth="1.35" />
      <path d="M10 14.75v2.25m0 0-1.8-1.8M10 17l1.8-1.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
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
