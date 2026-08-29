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

  it("error with identical content but new object reference is equal", () => {
    // 每次 listJobs 返回全新反序列化对象，引用比较会使轮询去重永久失效
    const a = [job({ error: { code: "PROCESS_FAIL", message: "引擎退出码 1" } })];
    const b = [job({ error: { code: "PROCESS_FAIL", message: "引擎退出码 1" } })];
    expect(a[0].error).not.toBe(b[0].error);
    expect(jobsEqual(a, b)).toBe(true);
  });

  it("error content changed is not equal", () => {
    const a = [job({ error: { code: "PROCESS_FAIL", message: "引擎退出码 1" } })];
    const b = [job({ error: { code: "OOM", message: "显存不足" } })];
    expect(jobsEqual(a, b)).toBe(false);
  });

  it("error set vs undefined is not equal", () => {
    const a = [job({ error: { code: "OOM", message: "显存不足" } })];
    expect(jobsEqual(a, [job()])).toBe(false);
  });
});
