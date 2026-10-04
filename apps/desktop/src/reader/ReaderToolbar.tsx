import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
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
import {
  aiStatusText,
  jobFileName,
  readingModeActive,
  type LoadedPage,
  type ReadingModeChoice,
} from "./readerNav";
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
  /** 丢弃草稿并关闭（换书场景：旧书参数不应提交并触发新书重优化） */
  aiMenuDiscardRef: MutableRefObject<() => void>;
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
  /* ⚠️ 这里**刻意不接收** effectiveSpread。竖读时它会被强制成 "single"，
     拿去当高亮依据就会让「单页」和「竖读」同时亮（修过的 bug）。
     版式高亮只认 `spread`（用户选的）+ `webtoon`，见 readingModeActive。
     渲染排版要用 effectiveSpread 时请在 ReaderView 里算，别往这一层传。 */
  direction: ReadDirection;
  setDirection: Dispatch<SetStateAction<ReadDirection>>;
  pageIndex: number;
  total: number;
  toggleView: () => void;
  /** 版式三选一（单页 / 双页 / 竖读）的统一入口，三者两两可直切 */
  selectReadingMode: (choice: ReadingModeChoice) => void;
  canPrev: boolean;
  canNext: boolean;
  requestScrollToPage: (index: number, where: "top" | "bottom") => void;
  go: (dir: 1 | -1) => void;
  pageEditing: boolean;
  setPageEditing: Dispatch<SetStateAction<boolean>>;
  pageDraft: string;
  setPageDraft: Dispatch<SetStateAction<string>>;
  pageLabel: string;
  /** 阅读进度百分比（0–100）；total 为 0 时 null，chip 尾注用 */
  pagePct: number | null;
  commitPageJump: () => void;
  visibleIndexes: number[];
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
              {/* 顺序必须是 main → sub → check：对勾靠 margin-left:auto 推到行尾。
                  放中间会让主名与副标签的间距随选中态跳变（多一个元素多一段 gap）。 */}
              <span className="ai-engine-sub">{eng.sub}</span>
              {p.engineValue === eng.id && (
                <span className="ai-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
        {/* 引擎切换提示：它解释的是**上面这份引擎列表**切换的代价，
            所以必须挂在引擎区里。旧位置在"清除缓存"按钮下面（缓存区末尾），
            视觉上像在描述那个按钮，且 `engineSwitchHint` 只在点"清除缓存"时
            才会复位 —— 切一次引擎后这条 10pt 小字会永久残留。 */}
        {p.engineSwitchHint && (
          <p className="ai-hint">{p.i18n.readerAiEngineCacheHint}</p>
        )}
      </div>
      {/* ⚠️ 区块**常驻**，不支持降噪时置灰 + 说明，不要整块卸载。
          原来用 `noiseSupported !== false` 直接不渲染：用户从 Real-CUGAN 切到
          Real-ESRGAN（无降噪参数）时，这一整段连同它的高度突然消失，
          下面的「AI 缓存」和「应用」按钮**整体上跳**，正好在鼠标位置附近塌陷 ——
          点完引擎想接着点下面，目标已经移走了。
          置灰还能顺带把"为什么没有降噪"讲清楚（禁用原因是信息，不是噪音）。 */}
      <div className="ai-section">
        {/* 禁用原因放在**标题同一行**，不另起一行。
            另起一行会让"支持降噪"与"不支持"两种引擎的面板高度差 21px，
            切换引擎时下面的内容仍会小幅跳动；放进标题行后两种状态高度完全一致。 */}
        <div className="flex items-baseline justify-between gap-2">
          <p className="ai-block-title">{p.i18n.readerNoiseLevel}</p>
          {p.noiseSupported === false && (
            <span className="ai-block-note">{p.i18n.readerNoiseNotSupported}</span>
          )}
        </div>
        <div
          className={`ai-seg ai-seg-sm mt-2 ${p.noiseSupported === false ? "is-locked" : ""}`}
          role="radiogroup"
          aria-label={p.i18n.readerNoiseLevel}
          aria-disabled={p.noiseSupported === false}
        >
          <span
            className="ai-seg-thumb"
            aria-hidden="true"
            style={{
              transform: `translateX(calc(100% * ${p.noiseValue}))`,
              visibility: p.noiseSupported === false ? "hidden" : undefined,
            }}
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
              aria-checked={p.noiseSupported !== false && p.noiseValue === n}
              disabled={p.noiseSupported === false}
              className={`ai-seg-item ${
                p.noiseSupported !== false && p.noiseValue === n ? "is-active" : ""
              }`}
              onClick={() => p.onSelectNoise(n)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
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
    aiMenuDiscardRef,
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
    direction,
    total,
    pageEditing,
    pageDraft,
    pageLabel,
    pagePct,
    canPrev,
    canNext,
    pageIndex,
    visibleIndexes,
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

  /* 面板头部的状态文案走 readerNav.aiStatusText（三态：未开启 / 处理中 / 引擎名），
     那边注释写清了为什么不能用 showingAi 当开关判定。 */
  const aiStatus = aiStatusText({
    enhanceOn,
    pageEnhancing,
    engineMain: aiEngineMain,
    offLabel: i18n.readerAiOff,
    busyLabel: i18n.readerAiBusy,
  });

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

  const discardDrafts = useCallback(() => {
    setDraftEngineId(null);
    setDraftNoise(null);
  }, []);

  /**
   * 关闭弹层 = **不应用**（等于放弃草稿）。
   *
   * 外部点击 / Esc / 藏栏 / 切"更多" 都走这里 —— 这几个手势在别处一律是"取消"，
   * 所以关闭绝不能顺手提交。提交必须是显式动作，只有「应用」按钮走
   * `applyDraftsAndClose`。旧实现是 `setAiMenuOpen(false) + commitDrafts()`：
   * 用户改完引擎想反悔、顺手点面板外面，参数被静默应用并触发重跑缓存。
   */
  const closeAiMenu = useCallback(() => {
    setAiMenuOpen(false);
    discardDrafts();
  }, [discardDrafts]);

  // 向宿主（ReaderView）暴露弹层开关状态与关闭动作：
  // 键盘导航的 Esc 优先关弹层、藏栏时收起弹层都依赖它
  useEffect(() => {
    aiMenuOpenRef.current = aiMenuOpen;
    aiMenuCloseRef.current = closeAiMenu;
  }, [aiMenuOpen, closeAiMenu, aiMenuOpenRef, aiMenuCloseRef]);

  // 换书等场景:收起弹层并丢弃草稿 —— 与"关闭=不应用"同一语义,直接复用
  useEffect(() => {
    aiMenuDiscardRef.current = closeAiMenu;
  }, [closeAiMenu, aiMenuDiscardRef]);

  // 藏栏会卸载顶栏,弹层随之消失;这里补一次收起,避免"逻辑上仍开着"的监听器残留（不提交）
  useEffect(() => {
    if (barHidden && aiMenuOpen) closeAiMenu();
  }, [barHidden, aiMenuOpen, closeAiMenu]);

  const applyDraftsAndClose = useCallback(() => {
    setAiMenuOpen(false);
    commitDrafts();
  }, [commitDrafts]);

  // 弹层打开期间挂外部点击/Esc 关闭。关闭=放弃（见 closeAiMenu），
  // 所以这里不需要"捉"最新草稿——草稿只在点「应用」时才提交。
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

  /* 三格高亮判定（互斥、最多一个为真）—— 走 readerNav.readingModeActive，
     这样"用 spread 而不是 effectiveSpread"这条约束有测试兜底。
     见该函数注释：合并这两个概念会让竖读时单页/竖读同时高亮。 */
  const modeActive = readingModeActive(webtoon, spread);

  const readingModeSeg = (
    <div className="reader-seg" role="group" aria-label={i18n.readerMode}>
      {/* 单页 / 双页 / 竖读 = 三个**互斥版式**，两两都能直接切。
          原先单页/双页在竖读下是 disabled（竖读时不可双页），
          于是退出竖读只能靠再点一次竖读按钮 —— 现在三点互通：
          竖读下点单页/双页会退出竖读并切到该版式。
          ⚠️ 因此不再有 disabled={webtoon}，title 里那两句「竖读时不可…」
            也不再适用（它们描述的是已废弃的限制）。 */}
      {/* ⚠️ 高亮判定用 `spread`（用户选的版式）而**不是** `effectiveSpread`。
          `effectiveSpread` 在竖读下会被强制成 "single"（竖读本来就是单列滚动），
          但那是"渲染时按单页排版"，不是"用户选了单页"。
          旧写法直接拿它当高亮依据 → 竖读时「单页」和「竖读」同时亮起。
          两者语义必须分开：effectiveSpread 管排版，spread 管选中态。 */}
      <button
        type="button"
        className={`reader-seg-item ${modeActive.single ? "is-active" : ""}`}
        aria-label={i18n.readerSingle}
        onMouseEnter={(e) => showTip(e, i18n.readerSingle)}
        onMouseLeave={hideTip}
        aria-pressed={modeActive.single}
        onClick={() => p.selectReadingMode("single")}
      >
        <IconSinglePage />
      </button>
      <button
        type="button"
        className={`reader-seg-item ${modeActive.double ? "is-active" : ""}`}
        aria-label={i18n.readerDouble}
        onMouseEnter={(e) => showTip(e, i18n.readerDouble)}
        onMouseLeave={hideTip}
        aria-pressed={modeActive.double}
        onClick={() => p.selectReadingMode("double")}
      >
        <IconDoublePage />
      </button>
      {/* 顺序：单页 / 双页 / 竖读 / 方向 / 隐藏栏。
          竖读与方向原为「方向在前、竖读在后」，用户要求对调 ——
          换后「单页·双页·竖读」三个都是**版式**，方向是阅读顺序，
          版式聚在一起、顺序单独在右，分组读起来更顺。
          竖读按钮是**开关**语义（再点一次退回页模式）。 */}
      {/* ⚠️ 不要再加 `title=`：本组件已经有自己的 showTip 气泡，
          两者会同时弹出（原生 title 延迟更久，于是屏幕上先后出现两个）。
          竖读是**开关**，所以已激活时 tip 改成「退出竖读」的说法，
          否则用户看到"宽度撑满，向下滚动"会以为点了没反应。 */}
      <button
        type="button"
        className={`reader-seg-item ${modeActive.webtoon ? "is-active" : ""}`}
        aria-label={i18n.readerWebtoon}
        aria-pressed={webtoon}
        onMouseEnter={(e) =>
          showTip(e, webtoon ? i18n.readerWebtoonExit : i18n.readerWebtoonHint)
        }
        onMouseLeave={hideTip}
        onClick={p.toggleView}
      >
        <IconWebtoon />
      </button>
      {/* 竖读下方向无意义，按钮禁用。禁用态的说明也走 showTip：
          `title` 只在原生 tooltip 里出现，和自定义气泡并存时文案会打架
          （实测竖读下悬停这个按钮，弹出的是「从左到右」而不是禁用原因）。
          ⚠️ 禁用按钮仍会触发 mouseenter，所以这里能正常显示。 */}
      <button
        type="button"
        className={`reader-seg-item ${direction === "rtl" ? "is-active" : ""} disabled:opacity-35`}
        aria-label={direction === "rtl" ? i18n.readerRtl : i18n.readerLtr}
        onMouseEnter={(e) =>
          showTip(
            e,
            webtoon
              ? i18n.readerWebtoonNoRtl
              : direction === "rtl"
                ? i18n.readerRtl
                : i18n.readerLtr,
          )
        }
        onMouseLeave={hideTip}
        aria-pressed={direction === "rtl"}
        disabled={webtoon}
        onClick={() => p.setDirection((d) => (d === "ltr" ? "rtl" : "ltr"))}
      >
        {direction === "rtl" ? <IconRtl /> : <IconLtr />}
      </button>
    </div>
  );

  const pagerControls = (
    <div className="pointer-events-auto group/pager flex flex-col items-center">
      {/* reader-pager-group：让「箭头 + 页码 + 箭头」的 hover 底连成一整块，
          避免从箭头滑到页码时闪断（方案 B，只改 hover，不加常驻轨道）。 */}
      <div className="reader-pager-group">
        {!barTiny && (
          <button
            type="button"
            className="reader-icon-btn"
            disabled={!canPrev}
            aria-label={i18n.readerPrevPage}
            onMouseEnter={(e) =>
              showTip(e, webtoon ? i18n.readerPrevPage : `${i18n.readerPrevPage} ←`)
            }
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
            className={`reader-page-chip-edit ${barTiny ? "reader-page-chip-sm" : ""}`}
            inputMode="numeric"
            aria-label={i18n.readerJumpHint}
            /* 4 位页码对条漫也够用；超长输入提交时只会被 clamp 回有效范围 */
            maxLength={4}
          />
        ) : (
          <button
            type="button"
            className={`reader-page-chip ${barTiny ? "reader-page-chip-sm" : ""}`}
            aria-label={`${i18n.readerPageLabel} · ${pageLabel}`}
            onMouseEnter={(e) =>
              showTip(
                e,
                pagePct != null
                  ? `${i18n.readerPageLabel} · ${i18n.readerPagePct.replace("{pct}", String(pagePct))}`
                  : i18n.readerPageLabel,
              )
            }
            onMouseLeave={hideTip}
            disabled={total <= 0}
            onClick={() => {
              const cur = (visibleIndexes[0] ?? pageIndex) + 1;
              p.setPageDraft(String(cur));
              p.setPageEditing(true);
            }}
          >
            {pageLabel}
            {/* 进度尾注：仅悬停翻页组时显示——常驻会把双页页码挤到折行；
                拖动/编辑态不显示（预览页码跳变时百分比跟着闪）。窄窗不显示。 */}
            {!barTiny && pagePct != null && (
              <span className="ml-1.5 hidden opacity-50 group-hover/pager:inline">
                {pagePct}%
              </span>
            )}
          </button>
        )}
        {!barTiny && (
          <button
            type="button"
            className="reader-icon-btn"
            disabled={!canNext}
            aria-label={i18n.readerNextPage}
            onMouseEnter={(e) =>
              showTip(e, webtoon ? i18n.readerNextPage : `${i18n.readerNextPage} →`)
            }
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
      {/* 这里原有「悬停页码 → 浮出进度滑杆」。已移除：与底部 ProgressHud 的
          进度条功能完全重复（底部那条还能拖拽 seek、支持方向键/Home/End，
          且带完整 role="slider" ARIA），把 seek 收敛到一处避免两套交互不一致。
          见 docs/reader-toolbar-center.md。 */}
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
          className={`reader-bar relative shrink-0 pr-2 ${
            /* 左侧要避开系统红绿灯（12pt 灯、20pt 间距 → 灯组右缘约 66pt）。
               窄窗给 78：返回键现在有可见的底，原来的 72 只剩 6pt 间隙，会贴到绿灯上；
               常规给 88（离灯 22pt），与原生工具栏观感一致。 */
            barTiny ? "pl-[78px]" : "pl-[88px]"
          } ${moreOpen ? "z-50" : "z-40"}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            data-tauri-drag-region
            className="absolute inset-0 z-0"
            onMouseDown={startWindowDrag}
          />
          {/* pt-3：28px 控件顶在 12px，圆心落在 26px。
              这个 26 是**本应用顶栏的内容线**：App 标签栏是 `h-[52px] + items-center`，
              内容中心同样是 26。两边同线，进出阅读器时才不会跳。
              ⚠️ 2026-10-01 更正：原注释写「与 y=20 的 12px 红绿灯对齐」是错的 ——
              实测 macOS 把 trafficLightPosition.y 当作灯的大致**中心**，配置 y=20 时
              灯心实际落在 17.5，比控件低约 8.5px。修法是调 tauri.conf.json 的
              trafficLightPosition.y（已改 20→28），**不是**把这里的 pt 改小：
              pt-1 虽能让控件中心落到 18，却会偏离 44px 栏的几何中心(22)、
              并与标签栏(26)不一致。另见 docs/reader-toolbar-alignment.md。 */}
          <div className="relative z-10 flex h-full items-start gap-2 pt-3 pointer-events-none">
            {/* gap-2(8pt) 而不是 gap-1(4pt)：返回键现在有可见的底，
                4pt 会让它的右边框紧贴书名（书名的首个字形是 [ ，视觉上更挤） */}
            <div
              className={`relative z-20 flex min-w-0 shrink-0 items-center gap-2 pointer-events-none ${
                barCompact ? "" : "max-w-[28%] sm:max-w-[32%]"
              }`}
            >
              {onClose && (
                <button
                  type="button"
                  className="reader-back-btn pointer-events-auto"
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
                    className="reader-bar-title min-w-0 flex-1 truncate text-[13px] font-medium pointer-events-auto"
                    title={displayTitle}
                    onMouseDown={startWindowDrag}
                  >
                    {displayTitle}
                  </span>
                ) : (
                  <span
                    data-tauri-drag-region
                    className="reader-bar-muted truncate text-[12px] pointer-events-auto"
                    onMouseDown={startWindowDrag}
                  >
                    {i18n.readerEmpty}
                  </span>
                ))}
              {!barCompact && temporary && (
                <span className="pointer-events-none shrink-0 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-warning-soft dark:text-warning-fg">
                  {i18n.externalTempBadge}
                </span>
              )}
            </div>

            {barCompact ? (
              <div className="relative z-10 mx-1 flex min-w-0 flex-1 justify-center">{pagerControls}</div>
            ) : (
              /* 居中基准 = **窗口中心**（不是内容盒中心）。
                 `inset-x-0` 的定位基准是 .reader-bar 的 **padding box**，
                 而该栏 padding 左右不对称（pl-88 给红绿灯让位 / pr-8）。
                 原因是 .reader-bar 带着 `transform: translateZ(0)`（防逐帧重绘
                 抖动而加的独立合成层）—— 带 transform 的元素会成为绝对定位后代的
                 包含块，此时 inset 按 padding box 解析：几何 = x 88..1092、中心 590。
                 实测（无头 Chrome + 构建产物）确认组心就在 590，比窗口中心 550
                 右偏 **40px**，正是 (88-8)/2。

                 用 `-translate-x-10` 平移 40px（transform 不动布局，数值精确）。
                 ⚠️ 试过两种不行的写法：
                    · `left-1/2 -translate-x-1/2` —— 在同一个 padding box 下解析，
                      算出来仍是 590，等于没改；
                    · `-ml-10` —— inset-x-0 同时设了 left/right，负 margin 会重算
                      宽度、右缘仍锚在 1092，只移了 20px（实测 570）。
                 ⚠️ 若改动 .reader-bar 的左右 padding，这里的 40 必须同步改。 */
              <div className="pointer-events-none absolute inset-x-0 top-3 z-10 -translate-x-10 flex justify-center">
                {pagerControls}
              </div>
            )}

            <div className="relative z-20 ml-auto flex shrink-0 items-center gap-1 pointer-events-auto">
              {!barTiny && (
                <div className="relative z-50" ref={aiRef}>
                  {/* 忙态只有图标位的 spinner 表达（见下方 reader-ai-spin）。
                      ⚠️ 这里原来还渲染一个 `<span class="reader-ai-ring">`，但 styles.css 里
                      从来没有这个类（407db62 把忙态改成扫光时连 ring 的样式一起删了，
                      只剩 JSX）—— 等于渲染了个什么都不画的空元素。已删。
                      要重新加进度环就在 styles.css 里补类，别只往 JSX 里塞类名。 */}
                  <div
                    className={`reader-ai-capsule ${(enhanceOn || showingAi) ? "is-on" : ""} ${pageEnhancing ? "is-busy" : ""}`}
                  >
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
                      aria-label={i18n.readerAiSettings}
                      aria-expanded={aiMenuOpen}
                      onMouseEnter={(e) => showTip(e, i18n.readerAiSettings)}
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
                      /* role="dialog" 而不是 "menu"：面板内容是两个 radiogroup
                         （引擎列表 / 去噪分段）+ 若干普通按钮。`role="menu"` 要求
                         子元素是 menuitem/menuitemradio 之类，套在 radiogroup 上
                         属于无效结构，读屏软件会念错甚至报错。 */
                      role="dialog"
                      aria-label={i18n.readerAiSettings}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="ai-section flex items-center justify-between">
                        <span className="text-[12px] font-semibold text-ink-800 dark:text-fg">
                          {i18n.readerAiLabel}
                        </span>
                        <span
                          className={`text-[10px] tabular-nums ${
                            aiStatus.on ? "" : "text-ink-400 dark:text-fg-muted"
                          }`}
                          style={aiStatus.on ? { color: "var(--ai-accent)" } : undefined}
                        >
                          {aiStatus.text}
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
                        /* 竖排：说明占整行，按钮另起一行右对齐。
                           横排时两段文字与两个按钮抢 260px，摘要会被截成
                           「将应用：Real-ESR...」，正好把"要切到哪个引擎"这个
                           最关键的词吃掉（改前实测）。 */
                        <div className="ai-section ai-apply-bar">
                          <div className="min-w-0">
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
                          <div className="flex shrink-0 items-center justify-end gap-1.5">
                            <button
                              type="button"
                              className="ai-btn-discard"
                              onClick={closeAiMenu}
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
                    showTip(
                      e,
                      `${fullscreen ? i18n.readerExitFullscreen : i18n.readerFullscreen} F`,
                    )
                  }
                  onMouseLeave={hideTip}
                  onClick={() => void toggleFullscreen()}
                >
                  {fullscreen ? <IconExitFullscreen /> : <IconFullscreen />}
                </button>
              )}

              {/* 藏栏是窗口行为而非阅读版式，归到右侧行为组；H 键收起、Esc/重显栏恢复 */}
              {!barTiny && (
                <button
                  type="button"
                  className="reader-icon-btn"
                  aria-label={i18n.readerHideBar}
                  onMouseEnter={(e) => showTip(e, `${i18n.readerHideBar} H`)}
                  onMouseLeave={hideTip}
                  onClick={() => {
                    hideTip();
                    setMoreOpen(false);
                    setBar(true);
                  }}
                >
                  <IconHideBar />
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
                      <div className="border-b border-ink-100 px-3 pb-2 pt-2 dark:border-white/10">
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
                    <div className="mt-3 border-t border-ink-100 px-3 pt-3 dark:border-white/10">
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

                    <div className="my-1 border-t border-ink-100 dark:border-white/10" />
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
                    <div className="my-1 border-t border-ink-100 dark:border-white/10" />
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
                        <div className="my-1 border-t border-ink-100 dark:border-white/10" />
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
