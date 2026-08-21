import { describe, expect, it } from "vitest";
import { alignIndex, stepIndex } from "./readerNav";

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
