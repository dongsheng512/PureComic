import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelReaderEnhance,
  clearReaderEnhanceCache,
  enhanceReaderPages,
  preheatReaderEngine,
  errorMessage,
  isCancelledError,
  listEngines,
  lookupReaderEnhancePages,
  readerEnhanceCacheStats,
} from "../api";
import type { Messages } from "../i18n";
import type {
  EnhanceCacheStats,
  EngineInfo,
  ReaderEnhanceOptions,
  ReaderPageFile,
} from "../types";
import {
  isReaderEngine,
  loadEnhanceNoise,
  loadReaderEngine,
  saveEnhanceNoise,
  saveReaderEngine,
} from "./prefs";
import { fileUrl, type LoadedPage } from "./readerNav";


function readerEnhanceOpts(engine: string, noise: 0 | 1 | 2 | 3): ReaderEnhanceOptions {
  const fourX = engine === "realesrgan-coreml" || engine === "animevideo-coreml";
  return {
    engine,
    preset: "quality",
    scale: fourX ? 4 : 2,
    noiseLevel: fourX ? 0 : noise,
    tta: false,
  };
}

type Args = {
  i18n: Messages;
  source: string | null;
  jobId: string | null;
  stateSource?: string;
  stateJobId?: string | null;
  statePageCount?: number;
  pageIndex: number;
  visibleIndexes: number[];
  prefetchRtl: boolean;
  webtoon: boolean;
  onError: (msg: string | null) => void;
};

export function useReaderEnhance(args: Args) {
  const {
    i18n,
    source,
    jobId,
    stateSource,
    stateJobId,
    statePageCount,
    pageIndex,
    visibleIndexes,
    prefetchRtl,
    webtoon,
    onError,
  } = args;

  const [enhanceOn, setEnhanceOn] = useState(false);
  const [enhanceBusy, setEnhanceBusy] = useState(false);
  const [aiPages, setAiPages] = useState<Record<number, LoadedPage>>({});
  const [engineId, setEngineId] = useState(loadReaderEngine);
  const [noiseLevel, setNoiseLevel] = useState<0 | 1 | 2 | 3>(loadEnhanceNoise);
  const [catalog, setCatalog] = useState<EngineInfo[]>([]);
  const [cacheStats, setCacheStats] = useState<EnhanceCacheStats | null>(null);
  const [clearConfirming, setClearConfirming] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [clearToast, setClearToast] = useState<string | null>(null);
  const [engineSwitchHint, setEngineSwitchHint] = useState(false);
  const clearRevertTimer = useRef<number | null>(null);
  const clearToastTimer = useRef<number | null>(null);
  const enhanceEpochRef = useRef(0);
  const prevEnhanceOnRef = useRef(false);
  /** 每次 effect 运行的代际:busy 状态归属哪个 effect 实例(翻页不 bump epoch,但会换 effect) */
  const runGenRef = useRef(0);
  const aiPagesRef = useRef(aiPages);
  aiPagesRef.current = aiPages;
  /** 已提交、尚未返回的增强页。跳页只在和新可见页不相交时取消。 */
  const inflightRef = useRef<{ id: number; pages: number[] }[]>([]);
  const inflightSeqRef = useRef(0);
  const switchTailRef = useRef(Promise.resolve());
  /** 跳页 / 切引擎的取消 IPC 串行。后一次提交必须等前一次取消返回。 */
  const cancelTailRef = useRef(Promise.resolve());
  const enhanceOnRef = useRef(enhanceOn);
  enhanceOnRef.current = enhanceOn;
  const engineIdRef = useRef(engineId);
  const noiseLevelRef = useRef(noiseLevel);
  const seenEngineRef = useRef(engineId);
  const seenNoiseRef = useRef(noiseLevel);
  // 只在 ref 还停在上一版 state 时跟随。点击已经把 ref 拨到新值时，不能被旧 state 盖回去。
  useEffect(() => {
    if (engineIdRef.current === seenEngineRef.current) engineIdRef.current = engineId;
    seenEngineRef.current = engineId;
  }, [engineId]);
  useEffect(() => {
    if (noiseLevelRef.current === seenNoiseRef.current) noiseLevelRef.current = noiseLevel;
    seenNoiseRef.current = noiseLevel;
  }, [noiseLevel]);

  const settleCancelTail = useCallback((task: () => Promise<void>) => {
    const run = cancelTailRef.current.catch(() => undefined).then(task);
    cancelTailRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }, []);

  const enhanceOpts = useMemo(
    () => readerEnhanceOpts(engineId, noiseLevel),
    [engineId, noiseLevel],
  );

  const applyAiFiles = useCallback((files: ReaderPageFile[]) => {
    if (files.length === 0) return;
    setAiPages((prev) => {
      const next = { ...prev };
      for (const file of files) {
        next[file.index] = { ...file, url: fileUrl(file.path, file.kind) };
      }
      const keys = Object.keys(next).map(Number);
      // 条漫快滑会马上回到刚离开的几页；8 页窗口会把它们清掉再重跑。
      const aiLimit = webtoon ? 12 : 80;
      const aiHalf = webtoon ? 6 : 40;
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
          reader.find((e) => e.id === "realcugan-coreml" && e.available) ??
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
      // 仅在 true→false 的切换沿取消在途批次;AI 关闭状态下翻页会反复
      // 重跑本 effect,每次都发取消 IPC 是无谓开销
      if (prevEnhanceOnRef.current) void cancelReaderEnhance();
      prevEnhanceOnRef.current = false;
      return;
    }
    prevEnhanceOnRef.current = true;
    const src = stateSource ?? source;
    const total = statePageCount ?? 0;
    if (!src || visibleIndexes.length === 0 || total <= 0) return;

    const ahead: number[] = [];
    const origin =
      prefetchRtl
        ? (visibleIndexes[0] ?? 0)
        : (visibleIndexes[visibleIndexes.length - 1] ?? 0);
    const step = prefetchRtl ? -1 : 1;
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
    // busy 归属用运行代际而非 epoch:翻页会换 effect 实例但 epoch 不变,
    // 旧任务的 finally/cleanup 不得清掉新任务刚置位的"增强中"
    const gen = ++runGenRef.current;
    const isCurrentGen = () => gen === runGenRef.current;
    let cancelled = false;
    const stillThis = () => !cancelled && epoch === enhanceEpochRef.current;

    const trackInflight = (pages: number[]) => {
      if (pages.length === 0) return () => {};
      const id = ++inflightSeqRef.current;
      inflightRef.current = [...inflightRef.current, { id, pages }];
      return () => {
        inflightRef.current = inflightRef.current.filter((batch) => batch.id !== id);
      };
    };

    const runEnhance = async (pages: number[], reportError: boolean) => {
      if (pages.length === 0 || !stillThis()) return;
      const release = trackInflight(pages);
      try {
        // 更早一次跳页的取消可能在本请求注册之后才到达。当前效果还在就再交一次。
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (!stillThis()) return;
          try {
            const files = await enhanceReaderPages({
              source: src,
              jobId: stateJobId ?? jobId,
              pageIndexes: pages,
              options: enhanceOpts,
            });
            if (epoch === enhanceEpochRef.current) applyAiRef.current(files);
            return;
          } catch (e) {
            if (isCancelledError(e) && stillThis() && attempt < 2) continue;
            if (reportError && stillThis() && !isCancelledError(e)) onError(errorMessage(e));
            return;
          }
        }
      } finally {
        release();
      }
    };

    (async () => {
      try {
        // 翻页不取消仍覆盖新可见页的批次（下一页往往已在预取里）。
        // 完全不相交才取消，并且必须等取消 IPC 返回再提交，否则全局取消
        // 会把刚注册的新请求一起清掉。当前这一页的推理停不掉，省的是后面几页。
        const overlapsInflight = visibleIndexes.some((index) =>
          inflightRef.current.some((batch) => batch.pages.includes(index)),
        );
        if (inflightRef.current.length > 0 && !overlapsInflight) {
          const staleIds = inflightRef.current.map((batch) => batch.id);
          try {
            await settleCancelTail(async () => {
              await cancelReaderEnhance();
              // 只摘掉这次取消的批次。等待期间新 effect 可能已经登记了自己的页。
              inflightRef.current = inflightRef.current.filter(
                (batch) => !staleIds.includes(batch.id),
              );
            });
          } catch {
            // 取消失败仍继续提交当前页，避免这次翻页被丢掉。
          }
          if (!stillThis()) return;
        } else {
          // 重叠页也要等前一次取消落地，否则全局取消会清掉刚注册的新请求。
          await cancelTailRef.current;
          if (!stillThis()) return;
        }
        const needLookup = visibleIndexes.filter((i) => !aiPagesRef.current[i]);
        if (needLookup.length > 0) {
          const hits = await lookupReaderEnhancePages({
            source: src,
            jobId: stateJobId ?? jobId,
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
            await runEnhance(miss, true);
          } finally {
            // 运行代际守卫:翻页后旧任务 resolve 晚于新任务置 busy 时不清零
            if (isCurrentGen()) setEnhanceBusy(false);
          }
        } else if (isCurrentGen()) {
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
          jobId: stateJobId ?? jobId,
          pageIndexes: prefNeed,
          options: enhanceOpts,
        });
        // 翻页不 bump epoch。lookup 在飞时离开本页，不能再把旧预取交出去。
        if (!stillThis()) return;
        applyAiRef.current(prefHits);
        const prefMiss = prefNeed.filter((i) => !aiPagesRef.current[i]);
        if (prefMiss.length === 0) {
          refreshCacheStats();
          return;
        }
        await runEnhance(prefMiss, false);
        if (stillThis()) refreshCacheStats();
      } catch (e) {
        if (stillThis() && !isCancelledError(e)) {
          onError(errorMessage(e));
        }
        if (isCurrentGen()) setEnhanceBusy(false);
      }
    })();

    return () => {
      cancelled = true;
      // 恒为当前代(React 保证 cleanup 先于下一个 setup),直接清零:
      // 翻页场景由新 setup 的 visCached 分支或新任务置位接管 busy
      if (isCurrentGen()) setEnhanceBusy(false);
    };
  }, [
    enhanceOn,
    visibleIndexes,
    prefetchRtl,
    enhanceOpts,
    stateSource,
    stateJobId,
    statePageCount,
    source,
    jobId,
    onError,
    refreshCacheStats,
    webtoon,
    settleCancelTail,
  ]);

  const toggleAi = useCallback(() => {
    if (enhanceOn) {
      enhanceEpochRef.current += 1;
      setEnhanceOn(false);
      setEnhanceBusy(false);
      void settleCancelTail(async () => {
        await cancelReaderEnhance();
        inflightRef.current = [];
      });
      return;
    }
    if (visibleIndexes.length === 0) return;
    void preheatReaderEngine(enhanceOpts).catch(() => undefined);
    setEnhanceOn(true);
  }, [enhanceOn, enhanceOpts, settleCancelTail, visibleIndexes]);

  const resetForNewBook = () => {
    setEnhanceOn(false);
    setAiPages({});
    setEnhanceBusy(false);
    enhanceEpochRef.current += 1;
    void settleCancelTail(async () => {
      await cancelReaderEnhance();
      inflightRef.current = [];
    });
  };

  const cacheSizeText = (stats: EnhanceCacheStats | null): string => {
    if (!stats) return "—";
    const mb = stats.bytes / (1024 * 1024);
    return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
  };

  /** 引擎副标签兜底：后端 detail 可能很长（如「就绪 · 目录批处理 · 线程 -j …」），只取第一段并限长 */
  const compactDetail = (detail: string): string => {
    const first = (detail ?? "").split("·")[0].trim();
    if (!first) return "";
    return first.length > 12 ? `${first.slice(0, 11)}…` : first;
  };

  const engineOptions = useMemo(() => {
    const list =
      catalog.length > 0
        ? catalog
        : [
            {
              id: "realcugan-coreml",
              label: "Real-CUGAN Core ML",
              available: true,
              detail: "",
              scales: [2],
              models: [],
            },
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
            {
              id: "animevideo-coreml",
              label: "AnimeVideo v3 4×",
              available: true,
              detail: "",
              scales: [4],
              models: [],
            },
          ];
    return list
      .filter((e) => isReaderEngine(e.id) && e.available !== false)
      .map((e) => {
        const known =
          e.id === "realcugan-coreml"
            ? { main: "Real-CUGAN", sub: "Core ML", noise: true }
            : e.id === "waifu2x-coreml"
              ? { main: "Waifu2x", sub: "Core ML", noise: true }
              : e.id === "realesrgan-coreml"
                ? { main: "Real-ESRGAN", sub: "4×", noise: false }
                : e.id === "animevideo-coreml"
                  ? { main: "AnimeVideo v3", sub: "4× 极速", noise: false }
                  : null;
        return {
          id: e.id,
          main: known?.main ?? e.label,
          sub: known?.sub ?? compactDetail(e.detail),
          // ESRGAN/AnimeVideo 无降噪参数，设置面板据此显隐降噪区块
          noise: known?.noise ?? true,
        };
      });
  }, [catalog]);

  // useCallback：AI 弹层打开期间这些引用进入多个 effect 依赖链
  // （提交回调、document 监听 effect），每次渲染换新引用会导致监听器
  // 拆除重挂、漏事件
  const persistEngine = useCallback(
    (id: string) => {
      if (!isReaderEngine(id) || id === engineIdRef.current) return;
      engineIdRef.current = id;
      enhanceEpochRef.current += 1;
      const hint = Boolean(cacheStats && cacheStats.bytes > 0);
      // 串行：上一次切换的取消返回之后才改状态、发预热。
      // 预热读 ref，不读点击当时的降噪；后面紧接着改的降噪不会暖错模型。
      switchTailRef.current = switchTailRef.current.catch(() => undefined).then(async () => {
        if (engineIdRef.current !== id) return;
        try {
          await settleCancelTail(async () => {
            await cancelReaderEnhance();
            inflightRef.current = [];
          });
        } catch {
          // 取消失败也落下选择，否则这次点击被吞掉。
        }
        if (engineIdRef.current !== id) return;
        setEngineId(id);
        saveReaderEngine(id);
        setAiPages({});
        if (hint) setEngineSwitchHint(true);
        if (enhanceOnRef.current) {
          void preheatReaderEngine(
            readerEnhanceOpts(engineIdRef.current, noiseLevelRef.current),
          ).catch(() => undefined);
        }
      }).catch(() => undefined);
    },
    [cacheStats, settleCancelTail],
  );

  /* 引擎切换提示的**自动复位**：它只在"切换后还没重新出图"这段时间里有意义。
     旧实现只在点「清除缓存」时才 setEngineSwitchHint(false)，于是用户切一次引擎、
     缓存早已按新引擎重建完毕，那行 10pt 小字仍永久挂在面板里 —— 变成噪音。

     判据用 aiPages 是否已产出：applyAiFiles（拿到增强结果时）会把 aiPages 填上，
     只要存在任意一页结果，就说明新引擎已经跑起来了，提示可以撤。 */
  useEffect(() => {
    if (!engineSwitchHint) return;
    if (Object.keys(aiPages).length === 0) return;
    setEngineSwitchHint(false);
  }, [engineSwitchHint, aiPages]);

  const persistNoise = useCallback(
    (n: 0 | 1 | 2 | 3) => {
      if (n === noiseLevelRef.current) return;
      noiseLevelRef.current = n;
      enhanceEpochRef.current += 1;
      switchTailRef.current = switchTailRef.current.catch(() => undefined).then(async () => {
        if (noiseLevelRef.current !== n) return;
        try {
          await settleCancelTail(async () => {
            await cancelReaderEnhance();
            inflightRef.current = [];
          });
        } catch {
          // 取消失败也落下选择，否则这次点击被吞掉。
        }
        if (noiseLevelRef.current !== n) return;
        setNoiseLevel(n);
        saveEnhanceNoise(n);
        setAiPages({});
        if (enhanceOnRef.current) {
          void preheatReaderEngine(
            readerEnhanceOpts(engineIdRef.current, noiseLevelRef.current),
          ).catch(() => undefined);
        }
      }).catch(() => undefined);
    },
    [settleCancelTail],
  );

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
      onError(errorMessage(e));
    } finally {
      setClearingCache(false);
    }
  };

  return {
    enhanceOn,
    enhanceBusy,
    aiPages,
    engineId,
    noiseLevel,
    catalog,
    cacheStats,
    clearConfirming,
    clearingCache,
    clearToast,
    engineSwitchHint,
    engineOptions,
    cacheSizeText,
    persistEngine,
    persistNoise,
    handleClearClick,
    toggleAi,
    resetForNewBook,
    refreshCacheStats,
  };
}
