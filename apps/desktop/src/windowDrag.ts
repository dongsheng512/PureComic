import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent as ReactMouseEvent } from "react";

/** 可交互元素上不启动拖窗 */
const INTERACTIVE =
  'button, a, input, select, textarea, label, [role="button"], [role="menuitem"], [role="option"], [role="listbox"], [role="menu"], [contenteditable="true"]';

/**
 * 在 mousedown 时拖动窗口。
 * 比单独依赖 data-tauri-drag-region 更稳：属性只对「直接点到的元素」生效，子节点会挡住。
 */
export function startWindowDrag(e: ReactMouseEvent | MouseEvent) {
  if (e.button !== 0) return;
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.closest(INTERACTIVE)) return;
  // 防止文本选中
  e.preventDefault();
  void getCurrentWindow()
    .startDragging()
    .catch(() => undefined);
}


/** Sync the native window surface with a reader canvas preset. No-op in Vite/browser. */
export function setNativeWindowBg(hex: string) {
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().setBackgroundColor(hex))
    .catch(() => undefined);
}
