import { describe, expect, it } from "vitest";
import { jobsEqual } from "./useJobs";
import type { JobStatus } from "./types";

function job(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    jobId: "job-1",
    state: "running",
    source: "/comics/book.cbz",
    pagesDone: 3,
    pagesTotal: 10,
    ...overrides,
  };
}

describe("jobsEqual", () => {
  it("same fields are equal", () => {
    expect(jobsEqual([job()], [job()])).toBe(true);
  });

  it("different length is not equal", () => {
    expect(jobsEqual([], [job()])).toBe(false);
  });

  it("only message changed is not equal", () => {
    const a = [job({ message: "目录批处理 · 线程 -j 2:8:4" })];
    const b = [job({ message: "参数已按模型包归一化：2× / n0" })];
    expect(jobsEqual(a, b)).toBe(false);
  });

  it("message undefined vs set is not equal", () => {
    expect(jobsEqual([job()], [job({ message: "打包完成" })])).toBe(false);
  });

  it("only etaSec changed is not equal", () => {
    expect(jobsEqual([job()], [job({ etaSec: 12 })])).toBe(false);
  });
});
