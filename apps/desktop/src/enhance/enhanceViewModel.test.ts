import { describe, expect, it } from "vitest";
import { parseAccelInfo } from "./enhanceViewModel";
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
