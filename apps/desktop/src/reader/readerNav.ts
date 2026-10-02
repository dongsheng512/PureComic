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

export function jobFileName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}
