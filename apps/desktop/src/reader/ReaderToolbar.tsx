import { useCallback, useEffect, useRef, useState, type CSSProperties, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import { stateLabel, type Messages } from "../i18n";
import type { EnhanceCacheStats, JobStatus, ReaderState } from "../types";
import { setNativeWindowBg, startWindowDrag } from "../windowDrag";
import {
  IconBack,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconDoublePage,
  IconExitFullscreen,
  IconFullscreen,
  IconHideBar,
  IconLtr,
  IconMore,
  IconRtl,
  IconShowBar,
  IconSinglePage,
  IconSparkles,
  IconWebtoon,
} from "./icons";
import {
  READER_BG_PRESETS,
  saveReaderBg,
  type FitMode,
  type ReadDirection,
  type ReaderBgId,
  type SpreadMode,
} from "./prefs";
import { alignIndex, jobFileName, type LoadedPage } from "./readerNav";
import { fitWindowToPageUrls, restoreDefaultWindowMinSize } from "./smartFit";

type EngineOption = { id: string; main: string; sub: string; noise?: boolean };

export type ReaderToolbarProps = {
  i18n: Messages;
  barRef: RefObject<HTMLDivElement | null>;
  moreRef: RefObject<HTMLDivElement | null>;
  pageInputRef: RefObject<HTMLInputElement | null>;
  smartSessionKeyRef: MutableRefObject<string | null>;
  barHidden: boolean;
  barCompact: boolean;
  barTiny: boolean;
  moreOpen: boolean;
  setMoreOpen: Dispatch<SetStateAction<boolean>>;
  /** 弹层开关/关闭逻辑留在本组件（草稿状态在此），但键盘导航与藏栏需要访问 */
  aiMenuOpenRef: MutableRefObject<boolean>;
  aiMenuCloseRef: MutableRefObject<() => void>;
  fullscreen: boolean;
  temporary: boolean;
  displayTitle: string | null;
  backLabel?: string;
  onClose?: () => void;
  showTip: (e: React.MouseEvent, text: string) => void;
  hideTip: () => void;
  setBar: (hidden: boolean) => void;
  toggleFullscreen: () => void;
  webtoon: boolean;
  effectiveSpread: SpreadMode;
  direction: ReadDirection;
  setSpread: Dispatch<SetStateAction<SpreadMode>>;
  setDirection: Dispatch<SetStateAction<ReadDirection>>;
  setPageIndex: Dispatch<SetStateAction<number>>;
  pageIndex: number;
  total: number;
  toggleView: () => void;
  canPrev: boolean;
  canNext: boolean;
  requestScrollToPage: (index: number, where: "top" | "bottom") => void;
  go: (dir: 1 | -1) => void;
  pageEditing: boolean;
  setPageEditing: Dispatch<SetStateAction<boolean>>;
  pageDraft: string;
  setPageDraft: Dispatch<SetStateAction<string>>;
  pageLabel: string;
  commitPageJump: () => void;
  visibleIndexes: number[];
  sliderDragValue: number | null;
  setSliderDragValue: Dispatch<SetStateAction<number | null>>;
  sliderPage: number;
  showingAi: boolean;
  enhanceOn: boolean;
  pageEnhancing: boolean;
  toggleAi: () => void;
  engineOptions: EngineOption[];
  engineId: string;
  persistEngine: (id: string) => void;
  engineSwitchHint: boolean;
  cacheStats: EnhanceCacheStats | null;
  noiseLevel: 0 | 1 | 2 | 3;
  persistNoise: (n: 0 | 1 | 2 | 3) => void;
  cacheLine: string;
  cachePct: number;
  handleClearClick: () => void;
  clearingCache: boolean;
  clearConfirming: boolean;
  cacheSizeText: (stats: EnhanceCacheStats | null) => string;
  canvasBg: ReaderBgId;
  setCanvasBg: Dispatch<SetStateAction<ReaderBgId>>;
  fit: FitMode;
  fitLocked: boolean;
  setFit: Dispatch<SetStateAction<FitMode>>;
  pagesInView: LoadedPage[];
  spread: SpreadMode;
  bookKey: string;
  fitWindowToCurrentPage: () => void;
  pickFile: () => void;
  pickFolder: () => void;
  jobs: JobStatus[];
  state: ReaderState | null;
  jobId: string | null;
  setJobId: Dispatch<SetStateAction<string | null>>;
  sourceRef: MutableRefObject<string>;
  refreshState: (jid: string | null, src: string | null) => void;
};

function AiEnginePanel(p: {
  i18n: Messages;
  engineOptions: EngineOption[];
  engineValue: string;
  noiseValue: 0 | 1 | 2 | 3;
  onSelectEngine: (id: string) => void;
  onSelectNoise: (n: 0 | 1 | 2 | 3) => void;
  /** 当前（草稿）引擎是否支持降噪；不支持时隐藏降噪区块 */
  noiseSupported?: boolean;
  engineSwitchHint?: boolean;
  cacheStats?: EnhanceCacheStats | null;
  cacheLine?: string;
  cachePct?: number;
  clearingCache?: boolean;
  clearConfirming?: boolean;
  handleClearClick?: () => void;
  cacheSizeText?: (stats: EnhanceCacheStats | null) => string;
  onPick?: () => void;
}) {
  return (
    <>
      <div className="ai-section">
        <p className="ai-block-title">{p.i18n.engine}</p>
        <div className="ai-engine-list mt-2" role="radiogroup" aria-label={p.i18n.engine}>
          {p.engineOptions.map((eng) => (
            <button
              key={eng.id}
              type="button"
              role="radio"
              aria-checked={p.engineValue === eng.id}
              className={`ai-engine-item ${p.engineValue === eng.id ? "is-active" : ""}`}
              onClick={() => p.onSelectEngine(eng.id)}
            >
              <span className="ai-engine-main">{eng.main}</span>
              {p.engineValue === eng.id && (
                <span className="ai-check" aria-hidden="true">
                  ✓
                </span>
              )}
              <span className="ai-engine-sub">{eng.sub}</span>
            </button>
          ))}
        </div>
      </div>
      {p.noiseSupported !== false && (
        <div className="ai-section">
          <p className="ai-block-title">{p.i18n.readerNoiseLevel}</p>
          <div className="ai-seg ai-seg-sm mt-2" role="radiogroup" aria-label={p.i18n.readerNoiseLevel}>
            <span
              className="ai-seg-thumb"
              aria-hidden="true"
              style={{ transform: `translateX(calc(100% * ${p.noiseValue}))` }}
            />
            {(
              [
                [0, p.i18n.readerNoiseLight],
                [1, p.i18n.readerNoiseStandard],
                [2, p.i18n.readerNoiseStrong],
                [3, p.i18n.readerNoiseMax],
              ] as const
            ).map(([n, label]) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={p.noiseValue === n}
                className={`ai-seg-item ${p.noiseValue === n ? "is-active" : ""}`}
                onClick={() => p.onSelectNoise(n)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {p.handleClearClick && (
        <div className="ai-section">
          <p className="ai-block-title">{p.i18n.readerAiCache}</p>
          <div className="mt-1.5 flex items-baseline justify-between gap-2">
            <span className="text-[12px] text-ink-500 dark:text-fg-muted">
              {p.i18n.readerAiCacheLabel}
            </span>
            <span className="text-[12px] tabular-nums text-ink-800 dark:text-fg">
              {p.cacheLine}
            </span>
          </div>
          <div className="reader-cache-bar mt-2" aria-hidden="true">
            <span style={{ width: `${p.cachePct ?? 0}%` }} />
          </div>
          <button
            type="button"
            className={`ai-clear-btn mt-2.5 ${p.clearConfirming ? "is-confirm" : ""}`}
            onClick={() => p.handleClearClick?.()}
          >
            {p.clearingCache ? (
              <>
                <span className="reader-ai-spin" aria-hidden="true" />
                {p.i18n.readerAiClearing}
              </>
            ) : p.clearConfirming ? (
              p.i18n.readerAiClearConfirm.replace("{size}", p.cacheSizeText?.(p.cacheStats ?? null) ?? "")
            ) : (
              p.i18n.readerAiCacheClear
            )}
          </button>
          {p.engineSwitchHint && (
            <p className="ai-hint">{p.i18n.readerAiEngineCacheHint}</p>
          )}
        </div>
      )}
    </>
  );
}

export function ReaderToolbar(p: ReaderToolbarProps) {
  const {
    i18n,
    barHidden,
    barCompact,
    barTiny,
    moreOpen,
    setMoreOpen,
    aiMenuOpenRef,
    aiMenuCloseRef,
    fullscreen,
    temporary,
    displayTitle,
    backLabel,
    onClose,
    showTip,
    hideTip,
    setBar,
    toggleFullscreen,
    webtoon,
    effectiveSpread,
    direction,
    total,
    pageEditing,
    pageDraft,
    pageLabel,
    canPrev,
    canNext,
    pageIndex,
    visibleIndexes,
    sliderDragValue,
    sliderPage,
    showingAi,
    pageEnhancing,
    engineOptions,
    engineId,
    enhanceOn,
    engineSwitchHint,
    persistEngine,
    persistNoise,
    cacheStats,
    noiseLevel,
    cacheLine,
    cachePct,
    clearingCache,
    clearConfirming,
    canvasBg,
    fit,
    fitLocked,
    pagesInView,
    spread,
    bookKey,
    jobs,
    state,
    jobId,
    smartSessionKeyRef,
  } = p;

  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  // 弹层内的草稿选择:收回菜单时才统一提交(AI 开启时由此触发一次重优化)
  const [draftEngineId, setDraftEngineId] = useState<string | null>(null);
  const [draftNoise, setDraftNoise] = useState<0 | 1 | 2 | 3 | null>(null);
  const aiRef = useRef<HTMLDivElement>(null);
  const aiPopRef = useRef<HTMLDivElement>(null);

  const aiEngineMain =
    engineOptions.find((eng) => eng.id === engineId)?.main ?? engineId;

  // 草稿对应引擎（决定降噪区块显隐）：优先草稿，回落当前引擎
  const effectiveEngineId = draftEngineId ?? engineId;
  const effectiveEngine =
    engineOptions.find((eng) => eng.id === effectiveEngineId);
  const noiseSupported = effectiveEngine?.noise ?? true;

  const engineDirty = Boolean(draftEngineId && draftEngineId !== engineId);
  const noiseDirty =
    noiseSupported && draftNoise != null && draftNoise !== noiseLevel;
  const aiDirty = engineDirty || noiseDirty;

  // 胶囊 tooltip 动态化：关闭 / 处理中 / 当前页已增强
  const aiTipText = !enhanceOn
    ? i18n.readerAiTooltip
    : showingAi
      ? i18n.readerAiTipEnhanced
      : pageEnhancing
        ? i18n.readerAiTipWorking
        : i18n.readerAiTooltip;

  // 草稿变更摘要，如「Real-ESRGAN · 降噪 强」
  const noiseLabelFor = (n: 0 | 1 | 2 | 3) =>
    n === 0
      ? i18n.readerNoiseLight
      : n === 1
        ? i18n.readerNoiseStandard
        : n === 2
          ? i18n.readerNoiseStrong
          : i18n.readerNoiseMax;
  const aiDirtyParts: string[] = [];
  if (engineDirty) aiDirtyParts.push(effectiveEngine?.main ?? draftEngineId ?? "");
  if (noiseDirty && draftNoise != null) {
    aiDirtyParts.push(`${i18n.readerNoiseLevel} ${noiseLabelFor(draftNoise)}`);
  }
  const aiDirtySummary = aiDirtyParts.join(" · ");

  const commitDrafts = useCallback(() => {
    if (draftEngineId && draftEngineId !== engineId) persistEngine(draftEngineId);
    // 目标引擎不支持降噪时丢弃草稿降噪档（避免无效果参数写入）
    const targetNoise =
      engineOptions.find((eng) => eng.id === (draftEngineId ?? engineId))?.noise ??
      true;
    if (targetNoise && draftNoise != null && draftNoise !== noiseLevel) {
      persistNoise(draftNoise);
    }
    setDraftEngineId(null);
    setDraftNoise(null);
  }, [draftEngineId, draftNoise, engineId, engineOptions, noiseLevel, persistEngine, persistNoise]);

  const closeAiMenu = useCallback(() => {
    setAiMenuOpen(false);
    commitDrafts();
  }, [commitDrafts]);

  // 向宿主（ReaderView）暴露弹层开关状态与关闭动作：
  // 键盘导航的 Esc 优先关弹层、藏栏时收起弹层都依赖它
  useEffect(() => {
    aiMenuOpenRef.current = aiMenuOpen;
    aiMenuCloseRef.current = closeAiMenu;
  }, [aiMenuOpen, closeAiMenu, aiMenuOpenRef, aiMenuCloseRef]);

  // 藏栏时收起弹层（提交草稿），避免"逻辑上仍开着"的监听器残留
  useEffect(() => {
    if (barHidden && aiMenuOpen) closeAiMenu();
  }, [barHidden, aiMenuOpen, closeAiMenu]);

  const discardDrafts = useCallback(() => {
    setDraftEngineId(null);
    setDraftNoise(null);
  }, []);

  const applyDraftsAndClose = useCallback(() => {
    setAiMenuOpen(false);
    commitDrafts();
  }, [commitDrafts]);

  // 弹层打开期间挂外部点击/Esc 关闭;依赖 closeAiMenu 保证提交的是最新草稿
  useEffect(() => {
    if (!aiMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (aiRef.current && !aiRef.current.contains(t)) closeAiMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // 阻断到 window 层(useKeyboardNav)的冒泡：Esc 语义已被本弹层消费
        e.stopPropagation();
        closeAiMenu();
      }
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
  }, [aiMenuOpen, closeAiMenu]);

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
          p.setSpread("single");
          p.setPageIndex((i) => alignIndex(i, "single", total));
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
          p.setSpread("double");
          p.setPageIndex((i) => alignIndex(i, "double", total));
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
        onClick={() => p.setDirection((d) => (d === "ltr" ? "rtl" : "ltr"))}
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
        onClick={p.toggleView}
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
              if (webtoon) p.requestScrollToPage(Math.max(0, pageIndex - 1), "top");
              else p.go(-1);
            }}
          >
            {direction === "rtl" ? <IconChevronRight /> : <IconChevronLeft />}
          </button>
        )}
        {pageEditing ? (
          <input
            ref={p.pageInputRef}
            value={pageDraft}
            onChange={(e) => p.setPageDraft(e.target.value)}
            onBlur={p.commitPageJump}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                p.commitPageJump();
              } else if (e.key === "Escape") {
                e.preventDefault();
                p.setPageEditing(false);
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
              p.setPageDraft(String(cur));
              p.setPageEditing(true);
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
              if (webtoon) p.requestScrollToPage(Math.min(Math.max(0, total - 1), pageIndex + 1), "top");
              else p.go(1);
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
              onPointerDown={() => p.setSliderDragValue(sliderPage)}
              onChange={(e) => {
                const n = Number(e.target.value);
                p.setSliderDragValue(n);
              }}
              onPointerUp={() => {
                if (sliderDragValue == null) return;
                const idx = alignIndex(sliderDragValue - 1, effectiveSpread, total);
                p.setSliderDragValue(null);
                if (webtoon) p.requestScrollToPage(idx, "top");
                else p.setPageIndex(idx);
              }}
              onBlur={() => {
                if (sliderDragValue == null) return;
                const idx = alignIndex(sliderDragValue - 1, effectiveSpread, total);
                p.setSliderDragValue(null);
                if (webtoon) p.requestScrollToPage(idx, "top");
                else p.setPageIndex(idx);
              }}
              onKeyUp={(e) => {
                if (sliderDragValue == null) return;
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") {
                  return;
                }
                const idx = alignIndex(sliderDragValue - 1, effectiveSpread, total);
                p.setSliderDragValue(null);
                if (webtoon) p.requestScrollToPage(idx, "top");
                else p.setPageIndex(idx);
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
    <>
      {barHidden && (
        <div
          data-tauri-drag-region
          className="pointer-events-auto absolute inset-x-0 top-0 z-30 h-11"
          onMouseDown={startWindowDrag}
        />
      )}

      {!barHidden && (
        <div
          ref={p.barRef}
          className={`reader-bar relative shrink-0 border-b border-ink-200/70 bg-ink-100 pr-2 dark:border-white/[0.08] dark:bg-surface ${
            barTiny ? "pl-[72px]" : "pl-[88px]"
          } ${moreOpen ? "z-50" : "z-40"}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            data-tauri-drag-region
            className="absolute inset-0 z-0"
            onMouseDown={startWindowDrag}
          />
          <div className="relative z-10 flex h-full items-center gap-2 pointer-events-none">
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

            <div className="relative z-20 ml-auto flex shrink-0 items-center gap-1 pointer-events-auto">
              {!barTiny && (
                <div className="relative z-50" ref={aiRef}>
                  <div
                    className={`reader-ai-capsule ${(enhanceOn || showingAi) ? "is-on" : ""} ${pageEnhancing ? "is-busy" : ""}`}
                  >
                    {pageEnhancing && <span className="reader-ai-ring" aria-hidden="true" />}
                    <button
                      type="button"
                      className="reader-ai-trigger"
                      disabled={visibleIndexes.length === 0}
                      aria-label={aiTipText}
                      aria-pressed={enhanceOn}
                      onMouseEnter={(e) => showTip(e, aiTipText)}
                      onMouseLeave={hideTip}
                      onClick={() => p.toggleAi()}
                    >
                      {pageEnhancing ? (
                        <span className="reader-ai-spin" aria-hidden="true" />
                      ) : (
                        <IconSparkles />
                      )}
                    </button>
                    <span className="reader-ai-capsule-sep" aria-hidden="true" />
                    <button
                      type="button"
                      className="reader-ai-more"
                      aria-label={i18n.engine}
                      aria-expanded={aiMenuOpen}
                      onMouseEnter={(e) => showTip(e, i18n.engine)}
                      onMouseLeave={hideTip}
                      onClick={() => {
                        setMoreOpen(false);
                        if (aiMenuOpen) closeAiMenu();
                        else setAiMenuOpen(true);
                      }}
                    >
                      <IconChevronDown />
                    </button>
                  </div>
                  {aiMenuOpen && (
                    <div
                      ref={aiPopRef}
                      className="reader-menu reader-menu-ai"
                      role="menu"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="ai-section flex items-center justify-between">
                        <span className="text-[12px] font-semibold text-ink-800 dark:text-fg">
                          {i18n.readerAiLabel}
                        </span>
                        <span
                          className={`text-[10px] tabular-nums ${
                            showingAi ? "" : "text-ink-400 dark:text-fg-muted"
                          }`}
                          style={showingAi ? { color: "var(--ai-accent)" } : undefined}
                        >
                          {showingAi ? aiEngineMain : i18n.readerAiOff}
                        </span>
                      </div>
<AiEnginePanel
                        i18n={i18n}
                        engineOptions={engineOptions}
                        engineValue={draftEngineId ?? engineId}
                        noiseValue={draftNoise ?? noiseLevel}
                        onSelectEngine={(id) => setDraftEngineId(id)}
                        onSelectNoise={(n) => setDraftNoise(n)}
                        noiseSupported={noiseSupported}
                        engineSwitchHint={engineSwitchHint}
                        cacheStats={cacheStats}
                        cacheLine={cacheLine}
                        cachePct={cachePct}
                        clearingCache={clearingCache}
                        clearConfirming={clearConfirming}
                        handleClearClick={() => void p.handleClearClick()}
                        cacheSizeText={p.cacheSizeText}
                      />
                      {aiDirty && (
                        <div className="ai-section ai-apply-bar">
                          <div className="min-w-0 flex-1">
                            <p className="ai-apply-summary">
                              {i18n.aiWillApply}
                              {aiDirtySummary}
                            </p>
                            <p className="ai-apply-note">
                              {cacheStats && cacheStats.bytes > 0
                                ? `${i18n.aiCacheRegen}（${p.cacheSizeText(cacheStats)}）`
                                : i18n.aiDirtyHint}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              className="ai-btn-discard"
                              onClick={discardDrafts}
                            >
                              {i18n.aiDiscard}
                            </button>
                            <button
                              type="button"
                              className="ai-btn-apply"
                              onClick={applyDraftsAndClose}
                            >
                              {i18n.aiApply}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
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

              <div className="relative z-50" ref={p.moreRef}>
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
                    if (aiMenuOpen) closeAiMenu();
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
                                p.toggleAi();
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
                                p.setCanvasBg(preset.id);
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
                        p.setFit("screen");
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
                        if (fit === "smart") {
                          if (pagesInView.length === 0 || fullscreen) return;
                          void fitWindowToPageUrls(
                            pagesInView.map((pg) => pg.url),
                            spread,
                            !barHidden,
                            false,
                          ).then(() => {
                            smartSessionKeyRef.current = `${bookKey}|${spread}`;
                          });
                        } else {
                          smartSessionKeyRef.current = null;
                          p.setFit("smart");
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
                        void p.fitWindowToCurrentPage();
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
                      className="flex w-full px-3 py-2 text-left text-xs text-ink-800 hover:bg-ink-50 dark:text-fg dark:hover:bg-white/[0.06]"
                      onClick={() => {
                        setMoreOpen(false);
                        void p.pickFile();
                      }}
                    >
                      {i18n.readerOpenFile}
                    </button>
                    <button
                      type="button"
                      className="flex w-full px-3 py-2 text-left text-xs text-ink-800 hover:bg-ink-50 dark:text-fg dark:hover:bg-white/[0.06]"
                      onClick={() => {
                        setMoreOpen(false);
                        void p.pickFolder();
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
                                    p.setJobId(j.jobId);
                                    p.sourceRef.current = "";
                                    void p.refreshState(j.jobId, null);
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
    </>
  );
}
