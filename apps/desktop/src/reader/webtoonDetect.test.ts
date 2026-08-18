import { describe, expect, it } from "vitest";
import { chapterIndexFromName, shouldDefaultWebtoon } from "./webtoonDetect";

describe("chapterIndexFromName", () => {
  it("parses chapter directories and filename markers", () => {
    expect(chapterIndexFromName("绍宋/Chapter_000/1.jpg")).toBe(0);
    expect(chapterIndexFromName("绍宋/Chapter_002/1.jpg")).toBe(2);
    expect(chapterIndexFromName("第12话_上.jpg")).toBe(12);
  });

  it("does not infer a chapter from a flat page name", () => {
    expect(chapterIndexFromName("001.jpg")).toBeNull();
  });
});

describe("shouldDefaultWebtoon", () => {
  it("recognizes a chapter-organized strip book", () => {
    const pages = Array.from({ length: 30 }, (_, index) => ({
      name: `绍宋/Chapter_${String(Math.floor(index / 10)).padStart(3, "0")}/${index}.jpg`,
    }));
    expect(shouldDefaultWebtoon(pages)).toBe(true);
  });

  it("does not infer a flat CBZ or a short book", () => {
    const flat = Array.from({ length: 20 }, (_, index) => ({ name: `${index + 1}.jpg` }));
    const short = Array.from({ length: 7 }, (_, index) => ({ name: `Chapter_000/${index}.jpg` }));
    expect(shouldDefaultWebtoon(flat)).toBe(false);
    expect(shouldDefaultWebtoon(short)).toBe(false);
  });
});
