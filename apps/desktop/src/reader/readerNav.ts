import { convertFileSrc } from "@tauri-apps/api/core";
import type { ReaderPageFile } from "../types";
import type { SpreadMode } from "./prefs";

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

export function jobFileName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}
