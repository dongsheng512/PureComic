import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { comicFileFilter } from "../formats";
import { errorMessage, getReaderState, touchLibrary } from "../api";
import type { Messages } from "../i18n";
import type { JobStatus, ReaderState } from "../types";
import { setNativeWindowBg } from "../windowDrag";
import {
  loadReaderPref,
  prefHasExplicitView,
  saveReaderPref,
  loadReaderBg,
  readerBgPreset,
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
import { ProgressHud, type ProgressPreview } from "./ProgressHud";
import { ReaderToolbar } from "./ReaderToolbar";
import {
  alignIndex,
  progressIndex,
  readingModeTarget,
  stepIndex,
  type LoadedPage,
  type ReadingModeChoice,
} from "./readerNav";
import { useKeyboardNav } from "./useKeyboardNav";
import { useSwipePageTurn } from "./useSwipePageTurn";
import { usePagePreload } from "./usePagePreload";
import { useReaderEnhance } from "./useReaderEnhance";

const BAR_KEY = "comic.reader.barHidden";
const WEBTOON_MAX_WIDTH = 960;
const BAR_COMPACT_W = 760;
const BAR_TINY_W = 560;

type Props = {
  jobs: JobStatus[];
  source: string | null;
  requestedJobId: string | null;
  bookTitle?: string | null;
  temporary?: boolean;
  i18n: Messages;
  backLabel?: string;
  onClose?: () => void;
  onError: (msg: string | null) => void;
  onPickedSource?: (path: string) => void;
  onImmersiveChange?: (immersive: boolean) => void;
};

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
  const [barHidden, setBarHidden] = useState(readBarHidden);
  const [fullscreen, setFullscreen] = useState(false);
  const [canvasBg, setCanvasBg] = useState<ReaderBgId>(loadReaderBg);
  const canvasPreset = readerBgPreset(canvasBg);
  const [progressHud, setProgressHud] = useState(false);
  const [pageEditing, setPageEditing] = useState(false);
  const [pageDraft, setPageDraft] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  // AI 弹层的开关与"关闭即放弃草稿"逻辑都在 Toolbar 内部(草稿状态在那里);
  // 键盘导航(Esc 优先关弹层)与藏栏收起通过这两个 ref 请求 Toolbar 执行
  const aiMenuOpenRef = useRef(false);
  const aiMenuCloseRef = useRef<() => void>(() => {});
  const aiMenuDiscardRef = useRef<() => void>(() => {});
  // 全屏进出时顶栏的联动（见下方 fullscreen effect）：记进全屏之前的 barHidden，退出时还原
  const barBeforeFullscreenRef = useRef<boolean | null>(null);
  const prevFullscreenRef = useRef(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // 测根容器宽而非顶栏内容宽：顶栏 padding 随 tiny 模式变化，
  // 若直接测顶栏会在阈值附近形成 tiny↔非tiny 的测量反馈死循环（按钮整排横移抖动）
  const [chromeWidth, setChromeWidth] = useState(0);
  const [stripWidth, setStripWidth] = useState(0);
  const [webtoonVisibleIndexes, setWebtoonVisibleIndexes] = useState<number[]>([]);
  const [jumpRequest, setJumpRequest] = useState<WebtoonJumpRequest | null>(null);
  const pageInputRef = useRef<HTMLInputElement>(null);
  const progressTimer = useRef<number | null>(null);
  const aspectMap = useRef<Map<number, number>>(new Map());
  const aspectMedianRef = useRef<number | null>(null);
  const jumpSeqRef = useRef(0);
  const aspectPersistTimer = useRef<number | null>(null);
  const decodedUrlsRef = useRef<Set<string>>(new Set());
  const skipProgressFlashRef = useRef(false);
  const sourceRef = useRef<string>("");
  const skipSaveRef = useRef(true);
  const lastCountRef = useRef(0);
  const didSuggestViewRef = useRef<string | null>(null);
  const detectionPagesRef = useRef<ReaderState["pages"]>([]);
  detectionPagesRef.current = state?.pages ?? [];
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

  useEffect(() => {
    hideTip();
  }, [barHidden, hideTip]);

  const smartSessionKeyRef = useRef<string | null>(null);
  const smartFitGen = useRef(0);
  const wasWebtoonRef = useRef(false);

  const immersive = barHidden || fullscreen;
  const webtoon = view === "webtoon";
  const effectiveSpread: SpreadMode = webtoon ? "single" : spread;
  const prefetchRtl = !webtoon && direction === "rtl";
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

  const preload = usePagePreload({
    jobId,
    source,
    stateSource: state?.source,
    stateJobId: state?.jobId,
    statePagesDone: state?.pagesDone,
    visibleIndexes,
    webtoonVisibleIndexes,
    prefetchIndexes,
    webtoon,
    pageIndex,
    onError,
  });
  const { loaded, busy, resetForNewBook: resetLoaded, pageIndexRef } = preload;

  const enhance = useReaderEnhance({
    i18n,
    source,
    jobId,
    stateSource: state?.source,
    stateJobId: state?.jobId,
    statePageCount: state?.pageCount,
    pageIndex,
    visibleIndexes,
    prefetchRtl,
    webtoon,
    onError,
  });

  useEffect(() => {
    syncReaderBarHeightCss();
  }, []);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setChromeWidth(w);
    });
    ro.observe(el);
    setChromeWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
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
    document.documentElement.setAttribute("data-reader-open", "");
    return () => {
      document.documentElement.removeAttribute("data-reader-open");
      const appBg = localStorage.getItem("comic.theme") === "light" ? "#FFFFFF" : "#1c1c1e";
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

  /**
   * 全屏进出的顶栏联动：进全屏顺手藏栏，退出时**还原成进全屏之前的状态**。
   *
   * 为什么放在 effect 而不是 toggleFullscreen 里：用 macOS 绿钮 / ⌘⌃F 退出全屏
   * 走的是上面 onResized 那条路，不走我们的 toggle。
   * 不还原的后果：`immersive = barHidden || fullscreen` 会一直是 true，
   * 退出全屏后顶栏仍藏着，看起来像"退出全屏没生效"，得再按一次 H。
   *
   * 故意只依赖 fullscreen：barHidden 变化不该触发这段（否则进全屏时会把刚藏好的
   * true 记成"进入前的值"，退出后就还原成隐藏）。
   */
  useEffect(() => {
    const prev = prevFullscreenRef.current;
    prevFullscreenRef.current = fullscreen;
    if (fullscreen === prev) return;
    if (fullscreen) {
      barBeforeFullscreenRef.current = barHidden;
      setBarHidden(true);
    } else {
      const restore = barBeforeFullscreenRef.current;
      barBeforeFullscreenRef.current = null;
      setBarHidden(restore ?? false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullscreen]);

  const setBar = useCallback((hidden: boolean) => {
    setBarHidden(hidden);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      setFullscreen(next);
      // 藏栏不在这里做 —— 交给下面的 fullscreen effect，
      // 那里能同时覆盖"绿钮/⌘⌃F 退出全屏"这条不经过本函数的路径
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
      onError(errorMessage(e));
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
      resetLoaded();
      if (aspectPersistTimer.current != null) window.clearTimeout(aspectPersistTimer.current);
      aspectMap.current = loadStoredAspects(state.source);
      aspectMedianRef.current = medianAspect(Array.from(aspectMap.current.values()));
      setWebtoonVisibleIndexes([]);
      setJumpRequest(null);
      decodedUrlsRef.current.clear();
      jumpSeqRef.current = 0;
      // 换书(含阅读中拖放)不重挂组件:丢弃草稿并收起弹层,
      // 避免旧书参数被提交后对新书触发重优化
      setMoreOpen(false);
      aiMenuDiscardRef.current();
      enhance.resetForNewBook();
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
    // resetForNewBook / enhance.resetForNewBook are stable-enough identity per book change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.source, state?.pageCount, statePageLength, firstPageName]);

  useEffect(() => {
    if (!state?.source) return;
    if (skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }
    saveReaderPref(state.source, { pageIndex, spread, direction, fit, view });
  }, [state?.source, pageIndex, spread, direction, fit, view]);

  useEffect(() => {
    const path = state?.source;
    if (!path) return;
    const page = pageIndex;
    const timer = window.setTimeout(() => {
      void touchLibrary(path, page).catch((err) => {
        console.warn("touchLibrary", err);
      });
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [state?.source, pageIndex]);

  useEffect(() => {
    return () => {
      const path = sourceRef.current;
      if (!path) return;
      // 关书时要的是最新页，不是 effect 创建时的页。
      // eslint-disable-next-line react-hooks/exhaustive-deps
      void touchLibrary(path, pageIndexRef.current).catch((err) => {
        console.warn("touchLibrary", err);
      });
    };
  }, [pageIndexRef]);

  useEffect(() => {
    if (!state?.jobId) return;
    const activeStates = [
      "running",
      "extracting",
      "finalizing",
      "validating",
      "pending",
      "cancelling",
    ];
    const active = activeStates.includes(state.jobState ?? "");
    const hasMissing = state.pages.some((p) => p.kind === "missing");
    if (!active && !hasMissing) return;

    let stale = 0;
    let lastSig = state.pages.map((p) => `${p.index}:${p.kind}`).join(",");
    const jid = state.jobId;
    const t = window.setInterval(() => {
      void refreshState(jid, null).then((next) => {
        if (!next) return;
        const sig = next.pages.map((p) => `${p.index}:${p.kind}`).join(",");
        if (sig === lastSig) stale += 1;
        else {
          stale = 0;
          lastSig = sig;
        }
        const stillActive = activeStates.includes(next.jobState ?? "");
        if (!stillActive && stale >= 3) window.clearInterval(t);
      });
    }, 900);
    return () => window.clearInterval(t);
    // pages 用内容签名在 interval 内比较，不放进依赖，避免每轮 setState 重置计数
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.jobId, state?.jobState, refreshState]);

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

  useSwipePageTurn({
    enabled: Boolean(state) && !webtoon && !pageEditing,
    direction,
    go,
    viewportRef,
  });

  const persistAspects = useCallback(() => {
    const src = sourceRef.current;
    if (!src) return;
    if (aspectPersistTimer.current != null) window.clearTimeout(aspectPersistTimer.current);
    aspectPersistTimer.current = window.setTimeout(() => {
      aspectPersistTimer.current = null;
      storeAspects(src, aspectMap.current);
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
    [webtoon, pageIndexRef],
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

  /* 版式三选一（单页 / 双页 / 竖读）的统一入口。
     三者两两互通：竖读下点单页或双页会退出竖读并切到该版式，
     单/双页下点竖读进入竖读。切到「页」时同时把页下标按目标 spread 对齐，
     切到竖读时按单页对齐（用双页对齐会平白跳掉一页），且**不动 spread**，
     这样退出竖读能回到用户原先选的单页/双页。 */
  const selectReadingMode = useCallback(
    (choice: ReadingModeChoice) => {
      const target = readingModeTarget(choice, pageIndexRef.current, pageCount);
      if (target.view === "webtoon") {
        const seq = ++jumpSeqRef.current;
        setJumpRequest({ seq, index: target.index, align: "start" });
      } else {
        setJumpRequest(null);
      }
      setView(target.view);
      if (target.spread !== null) setSpread(target.spread);
      setPageIndex(target.index);
      const prefSource = state?.source ?? source;
      if (prefSource) {
        saveReaderPref(
          prefSource,
          {
            pageIndex: target.index,
            // target.spread 为 null 表示「保持当前 spread」（进竖读的情况）
            spread: target.spread ?? spread,
            direction,
            fit,
            view: target.view,
          },
          { persistView: true },
        );
      }
    },
    [direction, fit, pageCount, pageIndexRef, source, spread, state?.source],
  );

  /* 「竖读」按钮是**开关**语义：不在竖读时进入竖读，已在竖读时退回页模式。
     退回时按用户记住的 spread 还原（而不是硬编码单页），与改版前一致。 */
  const toggleView = useCallback(() => {
    selectReadingMode(webtoon ? spread : "webtoon");
  }, [selectReadingMode, spread, webtoon]);

  useKeyboardNav({
    direction,
    go,
    effectiveSpread,
    webtoon,
    scrollOrTurn,
    requestScrollToPage,
    setPageIndex,
    state,
    barHidden,
    fullscreen,
    setBar,
    toggleFullscreen,
    onClose,
    pageEditing,
    setPageEditing,
    moreOpen,
    setMoreOpen,
    aiMenuOpenRef,
    aiMenuCloseRef,
    toggleAi: enhance.toggleAi,
  });

  const pickFile = async () => {
    try {
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
    } catch (err) {
      console.warn("pickFile", err);
    }
  };

  const pickFolder = async () => {
    try {
      const p = await open({ multiple: false, directory: true });
      if (typeof p === "string") {
        setJobId(null);
        sourceRef.current = "";
        onPickedSource?.(p);
        void refreshState(null, p);
      }
    } catch (err) {
      console.warn("pickFolder", err);
    }
  };

  const pagesInView = visibleIndexes
    .map((i) => (enhance.enhanceOn && enhance.aiPages[i] ? enhance.aiPages[i] : loaded[i]))
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
      const page = enhance.enhanceOn && enhance.aiPages[index] ? enhance.aiPages[index] : loaded[index];
      if (!page || decoded.has(page.url)) continue;
      const warm = new Image();
      warm.decoding = "async";
      warm.src = page.url;
      decoded.add(page.url);
    }
    if (decoded.size > 80) {
      const keep = new Set<string>();
      for (const index of prefetchIndexes) {
        const page = enhance.enhanceOn && enhance.aiPages[index] ? enhance.aiPages[index] : loaded[index];
        if (page) keep.add(page.url);
      }
      decodedUrlsRef.current = keep;
    }
  }, [enhance.aiPages, enhance.enhanceOn, loaded, prefetchIndexes, webtoon]);

  const showingAi =
    enhance.enhanceOn &&
    visibleIndexes.length > 0 &&
    visibleIndexes.every((i) => Boolean(enhance.aiPages[i]));
  const pageEnhancing = enhance.enhanceBusy && !showingAi;
  const displayPages = webtoon
    ? pagesInView
    : direction === "rtl"
      ? [...pagesInView].reverse()
      : pagesInView;
  const webtoonPages = useMemo(() => {
    const sourcePages = enhance.enhanceOn ? { ...loaded, ...enhance.aiPages } : loaded;
    const next: Record<number, LoadedPage> = {};
    for (const index of prefetchIndexes) {
      const page = sourcePages[index];
      if (page) next[index] = page;
    }
    return next;
  }, [enhance.aiPages, enhance.enhanceOn, loaded, prefetchIndexes]);
  const total = state?.pageCount ?? 0;

  const cacheLine = enhance.cacheStats
    ? i18n.readerAiCacheCount
        .replace("{done}", String(enhance.cacheStats.files))
        .replace("{total}", String(total))
        .replace("{size}", enhance.cacheSizeText(enhance.cacheStats))
    : "—";
  const cachePct =
    total > 0 && enhance.cacheStats ? Math.min(100, (enhance.cacheStats.files / total) * 100) : 0;

  const pageUrlsKey = pagesInView.map((pg) => `${pg.index}:${pg.url}`).join("|");
  const bookKey = state?.source ?? source ?? "";

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

    const sessionKey = `${bookKey}|${spread}`;
    if (smartSessionKeyRef.current === sessionKey) return;

    const urls = pagesInView.map((pg) => pg.url);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit, fullscreen, spread, view, bookKey, pageUrlsKey === "" ? "" : "ready"]);

  const fitWindowToCurrentPage = useCallback(async () => {
    if (view === "webtoon" || pagesInView.length === 0 || fullscreen) return;
    try {
      await fitWindowToPageUrls(
        pagesInView.map((pg) => pg.url),
        effectiveSpread,
        !barHidden,
        true,
      );
    } catch {
      /* ignore */
    }
    smartSessionKeyRef.current = null;
    setFit("screen");
    void restoreDefaultWindowMinSize();
  }, [pagesInView, effectiveSpread, barHidden, fullscreen, view]);

  const currentChapter = chapterIndexFromName(state?.pages[visibleIndexes[0] ?? pageIndex]?.name ?? "");
  // 阈值按旧口径换算：旧测量 = 窗宽 − pl(88) − pr(8)，故统一减 96 保持行为一致
  const barCompact = chromeWidth > 0 && chromeWidth - 96 < BAR_COMPACT_W;
  const barTiny = chromeWidth > 0 && chromeWidth - 96 < BAR_TINY_W;
  const chapterLabel =
    barCompact || !webtoon || currentChapter == null
      ? ""
      : ` · ${i18n.readerChapter.replace("{n}", String(currentChapter + 1))}`;
  const pageLabel =
    effectiveSpread === "double" && visibleIndexes.length === 2
      ? `${visibleIndexes[0] + 1}–${visibleIndexes[1] + 1} / ${total}${chapterLabel}`
      : `${(visibleIndexes[0] ?? 0) + 1} / ${total || "—"}${chapterLabel}`;
  // header 页码 chip 的进度尾注（阅读进度一瞥即得，免去心算）
  const pagePct =
    total > 0
      ? Math.min(
          100,
          Math.max(
            0,
            Math.round((((visibleIndexes[0] ?? pageIndex) + 1) / total) * 100),
          ),
        )
      : null;

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

  // 拖动只预览落点，松手才翻页，避免途经的每一页都去加载
  const progressAt = (clientX: number, rect: DOMRect): ProgressPreview | null => {
    if (total <= 0 || rect.width <= 0) return null;
    const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const idx = alignIndex(progressIndex(t, total), effectiveSpread, total);
    const end = effectiveSpread === "double" && idx + 1 < total ? idx + 1 : idx;
    const chapter =
      barCompact || !webtoon ? null : chapterIndexFromName(state?.pages[idx]?.name ?? "");
    const chapterSuffix =
      chapter == null ? "" : ` · ${i18n.readerChapter.replace("{n}", String(chapter + 1))}`;
    const label =
      end !== idx
        ? `${idx + 1}–${end + 1} / ${total}${chapterSuffix}`
        : `${idx + 1} / ${total}${chapterSuffix}`;
    return { pct: t * 100, label, page: idx + 1 };
  };

  const seekProgress = (clientX: number, rect: DOMRect) => {
    const hit = progressAt(clientX, rect);
    if (!hit || hit.page - 1 === pageIndex) return;
    skipProgressFlashRef.current = true;
    if (webtoon) requestScrollToPage(hit.page - 1, "top");
    else setPageIndex(hit.page - 1);
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

  return (
    <div
      ref={rootRef}
      className="reader-root relative flex h-full min-h-0 flex-col"
      data-reader-open=""
      data-reader-fg={canvasPreset.onDark ? "light" : "dark"}
      style={{
        backgroundColor: canvasPreset.hex,
        ["--reader-canvas" as string]: canvasPreset.hex,
      }}
      onMouseDownCapture={(e) => {
        if (e.button !== 0) return;
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) sel.removeAllRanges();
      }}
    >
      <ReaderToolbar
        i18n={i18n}
        barRef={barRef}
        moreRef={moreRef}
        pageInputRef={pageInputRef}
        smartSessionKeyRef={smartSessionKeyRef}
        barHidden={barHidden}
        barCompact={barCompact}
        barTiny={barTiny}
        moreOpen={moreOpen}
        setMoreOpen={setMoreOpen}
        aiMenuOpenRef={aiMenuOpenRef}
        aiMenuCloseRef={aiMenuCloseRef}
        aiMenuDiscardRef={aiMenuDiscardRef}
        fullscreen={fullscreen}
        temporary={temporary}
        displayTitle={displayTitle}
        backLabel={backLabel}
        onClose={onClose}
        showTip={showTip}
        hideTip={hideTip}
        setBar={setBar}
        toggleFullscreen={toggleFullscreen}
        webtoon={webtoon}
        effectiveSpread={effectiveSpread}
        direction={direction}
        setDirection={setDirection}
        pageIndex={pageIndex}
        total={total}
        toggleView={toggleView}
        selectReadingMode={selectReadingMode}
        canPrev={canPrev}
        canNext={canNext}
        requestScrollToPage={requestScrollToPage}
        go={go}
        pageEditing={pageEditing}
        setPageEditing={setPageEditing}
        pageDraft={pageDraft}
        setPageDraft={setPageDraft}
        pageLabel={pageLabel}
        pagePct={pagePct}
        commitPageJump={commitPageJump}
        visibleIndexes={visibleIndexes}
        showingAi={showingAi}
        enhanceOn={enhance.enhanceOn}
        pageEnhancing={pageEnhancing}
        toggleAi={enhance.toggleAi}
        engineOptions={enhance.engineOptions}
        engineId={enhance.engineId}
        persistEngine={enhance.persistEngine}
        engineSwitchHint={enhance.engineSwitchHint}
        cacheStats={enhance.cacheStats}
        noiseLevel={enhance.noiseLevel}
        persistNoise={enhance.persistNoise}
        cacheLine={cacheLine}
        cachePct={cachePct}
        handleClearClick={enhance.handleClearClick}
        clearingCache={enhance.clearingCache}
        clearConfirming={enhance.clearConfirming}
        cacheSizeText={enhance.cacheSizeText}
        canvasBg={canvasBg}
        setCanvasBg={setCanvasBg}
        fit={fit}
        fitLocked={fitLocked}
        setFit={setFit}
        pagesInView={pagesInView}
        spread={spread}
        bookKey={bookKey}
        fitWindowToCurrentPage={fitWindowToCurrentPage}
        pickFile={pickFile}
        pickFolder={pickFolder}
        jobs={jobs}
        state={state}
        jobId={jobId}
        setJobId={setJobId}
        sourceRef={sourceRef}
        refreshState={refreshState}
      />

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
              {displayPages.map((pg) => (
                <img
                  key={`${pg.index}-${pg.kind}`}
                  src={pg.url}
                  alt={pg.name}
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

      <ProgressHud
        total={total}
        progressHud={progressHud}
        progressPct={progressPct}
        pageLabel={pageLabel}
        pageNumber={sliderPage}
        showPageLabel={barHidden || fullscreen}
        onDark={canvasPreset.onDark}
        progressTimer={progressTimer}
        setProgressHud={setProgressHud}
        flashProgress={flashProgress}
        previewProgress={progressAt}
        seekProgress={seekProgress}
        go={go}
      />

      {enhance.clearToast && (
        <div className="reader-toast" role="status">
          {enhance.clearToast}
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
