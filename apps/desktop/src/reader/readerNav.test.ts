import { describe, expect, it } from "vitest";
import { alignIndex, progressIndex, readingModeTarget, stepIndex } from "./readerNav";

describe("progressIndex", () => {
  it("maps the track onto pages and keeps the right edge on the last page", () => {
    expect(progressIndex(0, 10)).toBe(0);
    expect(progressIndex(0.099, 10)).toBe(0);
    expect(progressIndex(0.1, 10)).toBe(1);
    expect(progressIndex(0.99, 10)).toBe(9);
    expect(progressIndex(1, 10)).toBe(9);
    expect(progressIndex(-1, 10)).toBe(0);
    expect(progressIndex(2, 10)).toBe(9);
    expect(progressIndex(0.5, 0)).toBe(0);
  });
});

describe("alignIndex", () => {
  it("clamps into range", () => {
    expect(alignIndex(-3, "single", 10)).toBe(0);
    expect(alignIndex(99, "single", 10)).toBe(9);
    expect(alignIndex(4, "single", 0)).toBe(0);
  });

  it("snaps double spread onto even pages", () => {
    expect(alignIndex(0, "double", 10)).toBe(0);
    expect(alignIndex(1, "double", 10)).toBe(0);
    expect(alignIndex(2, "double", 10)).toBe(2);
    expect(alignIndex(9, "double", 10)).toBe(8);
  });
});

describe("stepIndex", () => {
  it("steps one page in single mode", () => {
    expect(stepIndex(3, 1, "single", 10)).toBe(4);
    expect(stepIndex(3, -1, "single", 10)).toBe(2);
  });

  it("steps two pages in double mode and stays even", () => {
    expect(stepIndex(2, 1, "double", 10)).toBe(4);
    expect(stepIndex(2, -1, "double", 10)).toBe(0);
    expect(stepIndex(0, -1, "double", 10)).toBe(0);
  });
});

describe("readingModeTarget", () => {
  // 版式三选一：单页 / 双页 / 竖读，两两都能直接切。
  // 这里锁的是「点某个版式按钮后算出来的目标状态」——
  // 组件层只需照单执行，不再自己判断能不能切。
  const TOTAL = 10;

  it("单页 / 双页互切：view=page，spread=目标，index 按目标对齐", () => {
    expect(readingModeTarget("single", 4, TOTAL)).toEqual({
      view: "page",
      spread: "single",
      index: 4,
    });
    // 双页必须落在偶数页
    expect(readingModeTarget("double", 4, TOTAL)).toEqual({
      view: "page",
      spread: "double",
      index: 4,
    });
    expect(readingModeTarget("double", 5, TOTAL)).toEqual({
      view: "page",
      spread: "double",
      index: 4,
    });
    expect(readingModeTarget("double", 9, TOTAL)).toEqual({
      view: "page",
      spread: "double",
      index: 8,
    });
  });

  it("任一版式 -> 竖读：退出页模式，且 spread 保持不动（null）", () => {
    // spread: null 是「别动它」，这样退出竖读能回到用户原先选的单/双页，
    // 而不是被重置成单页。
    expect(readingModeTarget("webtoon", 0, TOTAL)).toEqual({
      view: "webtoon",
      spread: null,
      index: 0,
    });
    expect(readingModeTarget("webtoon", 4, TOTAL)).toEqual({
      view: "webtoon",
      spread: null,
      index: 4,
    });
  });

  it("竖读 -> 单页/双页：这是本次改动的核心，必须能直接切", () => {
    // 改前单页/双页在竖读下是 disabled，只能靠再点一次竖读退出。
    expect(readingModeTarget("single", 7, TOTAL)).toEqual({
      view: "page",
      spread: "single",
      index: 7,
    });
    expect(readingModeTarget("double", 7, TOTAL)).toEqual({
      view: "page",
      spread: "double",
      index: 6, // 7 不属于双页对，向前对齐到 6
    });
  });

  it("竖读按单页对齐，不按双页（否则会平白跳掉一页）", () => {
    // 若这里误用 double 对齐，索引 7 会变成 6 —— 进竖读时凭空退一页。
    expect(readingModeTarget("webtoon", 7, TOTAL).index).toBe(7);
  });

  it("越界与空书都夹回合法范围", () => {
    expect(readingModeTarget("single", 99, TOTAL).index).toBe(TOTAL - 1);
    expect(readingModeTarget("double", -5, TOTAL).index).toBe(0);
    expect(readingModeTarget("webtoon", 0, 0).index).toBe(0);
    expect(readingModeTarget("single", 3, 0).index).toBe(0);
    expect(readingModeTarget("double", 3, 0).index).toBe(0);
  });
});
