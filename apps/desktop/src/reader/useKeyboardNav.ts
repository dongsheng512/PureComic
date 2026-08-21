import { useEffect, type Dispatch, type SetStateAction } from "react";
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
    toggleAi,
  } = args;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
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
        setBar(!barHidden);
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        toggleAi();
      } else if (e.key === "Escape") {
        if (pageEditing) {
          e.preventDefault();
          setPageEditing(false);
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
    toggleAi,
  ]);
}
