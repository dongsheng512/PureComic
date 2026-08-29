import { useCallback, useEffect, useRef, useState } from "react";
import { listJobs, onJobProgress } from "./api";
import type { JobState, JobStatus } from "./types";

/** 进度事件节流窗口：洪峰期间每窗口最多一次 listJobs，窗口结束必补一次 */
const REFRESH_THROTTLE_MS = 200;

/** 进行中的任务状态（空闲时轮询退避，避免常驻全量重渲染） */
export const ACTIVE_JOB_STATES: readonly JobState[] = [
  "pending",
  "validating",
  "extracting",
  "running",
  "finalizing",
  "cancelling",
];

/** error 是每次 IPC 重新反序列化的对象，必须按内容比较，否则引用恒不等使轮询去重失效 */
function errKey(e: JobStatus["error"] | undefined): string {
  return e ? `${e.code}|${e.message}` : "";
}

/** jobs 列表浅比较：仅关注影响 UI 的字段 */
export function jobsEqual(a: JobStatus[], b: JobStatus[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.jobId !== y.jobId ||
      x.state !== y.state ||
      x.pagesDone !== y.pagesDone ||
      x.pagesTotal !== y.pagesTotal ||
      x.stage !== y.stage ||
      errKey(x.error) !== errKey(y.error) ||
      x.outputPath !== y.outputPath ||
      x.message !== y.message ||
      x.etaSec !== y.etaSec
    ) {
      return false;
    }
  }
  return true;
}

export function useJobs() {
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const lastFireRef = useRef(0);
  const tailTimerRef = useRef<number | null>(null);

  const refreshJobs = useCallback(async () => {
    try {
      const list = await listJobs();
      // 浅比较：无变化时不触发 setState，避免空闲状态 1.5s 一次全量重渲染
      setJobs((prev) => (jobsEqual(prev, list) ? prev : list));
    } catch {
      /* backend not ready */
    }
  }, []);

  /** leading + trailing 节流：窗口首拍立即执行，窗口内后续触发合并为尾帧一拍 */
  const scheduleRefresh = useCallback(() => {
    const elapsed = Date.now() - lastFireRef.current;
    if (elapsed >= REFRESH_THROTTLE_MS) {
      lastFireRef.current = Date.now();
      void refreshJobs();
      return;
    }
    if (tailTimerRef.current != null) return;
    tailTimerRef.current = window.setTimeout(
      () => {
        tailTimerRef.current = null;
        lastFireRef.current = Date.now();
        void refreshJobs();
      },
      REFRESH_THROTTLE_MS - elapsed,
    );
  }, [refreshJobs]);

  const jobsActive = jobs.some((j) => ACTIVE_JOB_STATES.includes(j.state));

  useEffect(() => {
    void refreshJobs();
    const timer = setInterval(
      scheduleRefresh,
      jobsActive ? 1500 : 15000, // 空闲时低频兜底轮询
    );
    let unlisten: (() => void) | undefined;
    onJobProgress(() => {
      scheduleRefresh();
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      clearInterval(timer);
      if (tailTimerRef.current != null) window.clearTimeout(tailTimerRef.current);
      tailTimerRef.current = null;
      unlisten?.();
    };
  }, [refreshJobs, scheduleRefresh, jobsActive]);

  return { jobs, setJobs, refreshJobs, jobsActive };
}
