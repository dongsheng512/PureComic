import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { ReadDirection, SpreadMode } from "./prefs";
import type { ReaderState } from "../types";
import { alignIndex } from "./readerNav";

type Args = {
  direction: ReadDirection;
  go: (dir: 1 | -1) => void;
  effectiveSpread: SpreadMode;
  webtoon: boolean;
  scrollOrTurn: (dir: 1 | -1) => void;
  requestScrollToPage: (index: number, where: "top" | "bottom") => void;
  setPageIndex: Dispatch<SetStateAction<number>>;
  state: ReaderState | null;
  barHidden: boolean;
  fullscreen: boolean;
  setBar: (hidden: boolean) => void;
  toggleFullscreen: () => void | Promise<void>;
  onClose?: () => void;
  pageEditing: boolean;
  setPageEditing: Dispatch<SetStateAction<boolean>>;
  moreOpen: boolean;
  setMoreOpen: Dispatch<SetStateAction<boolean>>;
  /**
   * AI 弹层状态与关闭动作,以 ref 传入:事件时刻读 .current 取实时值。
   * 若传快照值,ref 变化不触发宿主重渲染,Esc 会读到陈旧状态
   * (菜单已关仍吞 Esc,或菜单开着被穿透到关阅读器)。
   */
  aiMenuOpenRef: MutableRefObject<boolean>;
  aiMenuCloseRef: MutableRefObject<() => void>;
  toggleAi: () => void;
};

export function useKeyboardNav(args: Args) {
  const {
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
    toggleAi,
  } = args;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      // 事件时刻读实时值(见 Args 注释)
      const aiMenuOpen = aiMenuOpenRef.current;
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
        // 藏栏会卸载顶栏:更多菜单随之消失,但 state 残留会导致重显栏时菜单
        // 凭空复现且外部点击监听失效,与藏栏按钮的行为对齐
        setMoreOpen(false);
        setBar(!barHidden);
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        toggleAi();
      } else if (e.key === "Escape") {
        if (pageEditing) {
          e.preventDefault();
          setPageEditing(false);
        } else if (aiMenuOpen) {
          e.preventDefault();
          aiMenuCloseRef.current();
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
    toggleAi,
  ]);
}
