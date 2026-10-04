import { convertFileSrc } from "@tauri-apps/api/core";
import type { ReaderPageFile } from "../types";
import type { ReaderViewMode, SpreadMode } from "./prefs";

export type LoadedPage = ReaderPageFile & { url: string };

export function fileUrl(path: string, kind: string): string {
  const base = convertFileSrc(path);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}k=${encodeURIComponent(kind)}`;
}

/** 进度条位置 0..1 映射到页下标。右端点落在最后一页，与点击跳转同一口径。 */
export function progressIndex(ratio: number, total: number): number {
  if (total <= 0) return 0;
  const t = Math.min(1, Math.max(0, ratio));
  return Math.min(total - 1, Math.floor(t * total));
}

export function alignIndex(index: number, spread: SpreadMode, total: number): number {
  if (total <= 0) return 0;
  let i = Math.min(Math.max(0, index), total - 1);
  if (spread === "double") i -= i % 2;
  return i;
}

export function stepIndex(index: number, dir: 1 | -1, spread: SpreadMode, total: number): number {
  const step = spread === "double" ? 2 : 1;
  return alignIndex(index + dir * step, spread, total);
}

/** 版式三选一：单页 / 双页 / 竖读。三者互斥，且**两两都能直接切换**。 */
export type ReadingModeChoice = "single" | "double" | "webtoon";

/** 把「点了哪个版式按钮」翻译成 view / spread / 页下标。
 *
 *  单页、双页、竖读三个按钮两两互通：在竖读下点单页或双页会**退出竖读**
 *  并切到该版式（不再禁用），在单/双页下点竖读则进入竖读。所以调用方
 *  不需要自己判断能不能切，算出来的就是目标状态。
 *
 *  `spread` 返回 `null` 表示**保持不动** —— 进入竖读不改 spread，
 *  这样退出竖读时能回到用户原来选的单页/双页，而不是被重置成单页。 */
export function readingModeTarget(
  choice: ReadingModeChoice,
  currentIndex: number,
  total: number,
): { view: ReaderViewMode; spread: SpreadMode | null; index: number } {
  if (choice === "webtoon") {
    // 竖读按单页对齐：用双页对齐会平白跳掉一页
    return { view: "webtoon", spread: null, index: alignIndex(currentIndex, "single", total) };
  }
  return { view: "page", spread: choice, index: alignIndex(currentIndex, choice, total) };
}

/** 版式分段里「哪一格该高亮」。三格互斥，**最多只有一个**为真。
 *
 *  ⚠️ 这里必须用用户选的 `spread`，不能用渲染用的 `effectiveSpread`。
 *  `effectiveSpread` 在竖读下会被强制成 `"single"`（竖读就是单列滚动），
 *  但那是"按单页排版"而不是"用户选了单页"。拿它当高亮依据会让竖读时
 *  「单页」和「竖读」两格同时亮起 —— 这是修过的 bug，别再合并这两个概念。
 *
 *  `spread` 只在页模式下参与判定：竖读时单页/双页两格都不亮。 */
export function readingModeActive(
  webtoon: boolean,
  spread: SpreadMode,
): { single: boolean; double: boolean; webtoon: boolean } {
  return {
    single: !webtoon && spread === "single",
    double: !webtoon && spread === "double",
    webtoon,
  };
}

/** AI 面板右上角的状态文案（三态）。
 *
 *  ⚠️ 开关本身**只认 `enhanceOn`**。`showingAi`（当前可见页是否都已增强）
 *  是"渲染就绪"，不是"功能开关"：拿它当开关会得到"AI 开着、当前页还在处理"
 *  时显示「未开启」，而同一面板里引擎行却是高亮选中的自相矛盾状态。
 *  这和「单页/竖读同时高亮」是同一类错误，别再合并这两个概念。
 *
 *  返回 `on: false` 表示该用弱化色（未开启）。 */
export function aiStatusText(args: {
  enhanceOn: boolean;
  pageEnhancing: boolean;
  engineMain: string;
  offLabel: string;
  busyLabel: string;
}): { text: string; on: boolean } {
  if (!args.enhanceOn) return { text: args.offLabel, on: false };
  if (args.pageEnhancing) {
    return { text: `${args.engineMain} · ${args.busyLabel}`, on: true };
  }
  return { text: args.engineMain, on: true };
}

export function jobFileName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}
