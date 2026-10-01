import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_QUALITY,
  JPEG_QUALITY_OF,
  jpegQualityOf,
  parseAccelInfo,
  qualityAppliesTo,
} from "./enhanceViewModel";
import type { EngineStatus } from "../types";

describe("parseAccelInfo", () => {
  it("prefers structured mode and threads over detail text", () => {
    const fallback: EngineStatus = {
      id: "realcugan-coreml",
      available: true,
      detail: "逐页并行 线程 -j 1:1:1",
      mode: "Core ML",
      threads: "2:2:2",
    };
    const info = parseAccelInfo([], "realcugan-coreml", "se", fallback);
    expect(info.mode).toBe("Core ML");
    expect(info.threads).toBe("2:2:2");
    expect(info.gpu).toBe(true);
  });

  it("does not mark mock as GPU", () => {
    const fallback: EngineStatus = {
      id: "mock",
      available: true,
      detail: "Core ML GPU",
      isMock: true,
      mode: "mock",
    };
    const info = parseAccelInfo([], "mock", "", fallback);
    expect(info.gpu).toBe(false);
  });
});

describe("export quality tiers", () => {
  it("maps every tier to a valid libjpeg quality, ordered small to large", () => {
    const values = Object.values(JPEG_QUALITY_OF);
    for (const q of values) {
      expect(q).toBeGreaterThanOrEqual(1);
      expect(q).toBeLessThanOrEqual(100);
    }
    expect(JPEG_QUALITY_OF.minimal).toBeLessThan(JPEG_QUALITY_OF.compact);
    expect(JPEG_QUALITY_OF.compact).toBeLessThan(JPEG_QUALITY_OF.balanced);
    expect(JPEG_QUALITY_OF.balanced).toBeLessThan(JPEG_QUALITY_OF.high);
  });

  it("default tier is the one labelled recommended", () => {
    expect(DEFAULT_EXPORT_QUALITY).toBe("balanced");
    expect(jpegQualityOf(DEFAULT_EXPORT_QUALITY)).toBe(JPEG_QUALITY_OF.balanced);
  });

  it("falls back to the default for an unknown tier", () => {
    expect(jpegQualityOf("nonsense" as never)).toBe(JPEG_QUALITY_OF[DEFAULT_EXPORT_QUALITY]);
  });

  it("quality only applies where the encoder is lossy", () => {
    expect(qualityAppliesTo("jpeg")).toBe(true);
    expect(qualityAppliesTo("same")).toBe(true);
    // PNG is always lossless; WebP is lossless-only with image 0.25
    expect(qualityAppliesTo("png")).toBe(false);
    expect(qualityAppliesTo("webp")).toBe(false);
  });
});
