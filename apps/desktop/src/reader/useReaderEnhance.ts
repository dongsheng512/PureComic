import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelReaderEnhance,
  clearReaderEnhanceCache,
  enhanceReaderPages,
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
  const aiPagesRef = useRef(aiPages);
  aiPagesRef.current = aiPages;

  const enhanceOpts = useMemo<ReaderEnhanceOptions>(
    () => ({
      engine: engineId,
      preset: "quality",
      scale: engineId === "realesrgan-coreml" ? 4 : 2,
      noiseLevel: engineId === "realesrgan-coreml" ? 0 : noiseLevel,
      tta: false,
    }),
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
      void cancelReaderEnhance();
      return;
    }
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
    let cancelled = false;
    const stillThis = () => !cancelled && epoch === enhanceEpochRef.current;

    (async () => {
      try {
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
            const files = await enhanceReaderPages({
              source: src,
              jobId: stateJobId ?? jobId,
              pageIndexes: miss,
              options: enhanceOpts,
            });
            if (epoch === enhanceEpochRef.current) applyAiRef.current(files);
          } catch (e) {
            if (stillThis() && !isCancelledError(e)) {
              onError(errorMessage(e));
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
          jobId: stateJobId ?? jobId,
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
            jobId: stateJobId ?? jobId,
            pageIndexes: prefMiss,
            options: enhanceOpts,
          });
          if (epoch === enhanceEpochRef.current) applyAiRef.current(files);
        } catch (e) {
          if (isCancelledError(e) || epoch !== enhanceEpochRef.current) return;
        }
        if (stillThis()) refreshCacheStats();
      } catch (e) {
        if (stillThis() && !isCancelledError(e)) {
          onError(errorMessage(e));
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
    stateSource,
    stateJobId,
    statePageCount,
    source,
    jobId,
    onError,
    refreshCacheStats,
    webtoon,
  ]);

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

  const resetForNewBook = () => {
    setEnhanceOn(false);
    setAiPages({});
    setEnhanceBusy(false);
    enhanceEpochRef.current += 1;
    void cancelReaderEnhance();
  };

  const cacheSizeText = (stats: EnhanceCacheStats | null): string => {
    if (!stats) return "—";
    const mb = stats.bytes / (1024 * 1024);
    return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
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
          ];
    return list
      .filter((e) => isReaderEngine(e.id) && e.available !== false)
      .map((e) => {
        const known =
          e.id === "realcugan-coreml"
            ? { main: "Real-CUGAN", sub: "Core ML" }
            : e.id === "waifu2x-coreml"
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

  const persistEngine = (id: string) => {
    if (!isReaderEngine(id) || id === engineId) return;
    enhanceEpochRef.current += 1;
    void cancelReaderEnhance();
    setEngineId(id);
    saveReaderEngine(id);
    setAiPages({});
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
    engineIndex,
    cacheSizeText,
    persistEngine,
    persistNoise,
    handleClearClick,
    toggleAi,
    resetForNewBook,
    refreshCacheStats,
  };
}
