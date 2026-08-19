import { describe, expect, it } from "vitest";
import {
  DEFAULT_ASPECT,
  displayHeight,
  estimatedHeight,
  expandStripPrefetch,
  medianAspect,
  pageIndexAtOffset,
  stripContentWidth,
  stripIndexes,
} from "./webtoonStripHelpers";

describe("webtoon strip helpers", () => {
  it.each([
    [0, 10, [0, 1, 2]],
    [5, 10, [4, 5, 6, 7]],
    [9, 10, [8, 9]],
    [0, 0, []],
  ])("stripIndexes(%i, %i)", (pageIndex, pageCount, expected) => {
    expect(stripIndexes(pageIndex, pageCount)).toEqual(expected);
  });

  it("estimates height from the default aspect", () => {
    expect(estimatedHeight(2000, 960)).toBe(Math.round(960 * DEFAULT_ASPECT));
    expect(estimatedHeight(400, 960)).toBe(Math.round(400 * DEFAULT_ASPECT));
  });

  it("supports a page-specific aspect ratio", () => {
    expect(displayHeight(2000, 960, 2.07)).toBe(Math.round(960 * 2.07));
  });

  it("shrinks reserved height with the viewport so strip pages stay flush", () => {
    expect(displayHeight(400, 960, 1.45) * 2).toBe(displayHeight(800, 960, 1.45));
  });

  it("expands prefetch around the rendered virtual window", () => {
    expect(expandStripPrefetch([4, 5, 6, 7], 20, 2)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(expandStripPrefetch([0, 1, 2], 5, 2)).toEqual([0, 1, 2, 3, 4]);
    expect(expandStripPrefetch([], 10, 2)).toEqual([]);
  });

  it("returns a median aspect only after three samples", () => {
    expect(medianAspect([1.4, 1.5])).toBeNull();
    expect(medianAspect([2.07, 1.4, 1.45])).toBe(1.45);
    expect(medianAspect([1.4, 1.42, 1.46, 1.5])).toBe(1.44);
  });

  it("fits strip content width without upscaling past the cap", () => {
    expect(stripContentWidth(2000, 960)).toBe(960);
    expect(stripContentWidth(400, 960)).toBe(400);
  });

  it("maps a scroll offset onto a page index", () => {
    const heightOf = () => 100;
    expect(pageIndexAtOffset(0, 200, heightOf)).toBe(0);
    expect(pageIndexAtOffset(250, 200, heightOf)).toBe(2);
    expect(pageIndexAtOffset(999_999, 200, heightOf)).toBe(199);
  });
});
