import { useEffect, useRef, useState } from "react";
import { errorMessage, prepareReaderPages } from "../api";
import { fileUrl, type LoadedPage } from "./readerNav";

const LOADED_WINDOW = 120;
const LOADED_HALF_WINDOW = 60;

type Args = {
  jobId: string | null;
  source: string | null;
  stateSource?: string;
  stateJobId?: string | null;
  statePagesDone?: number;
  visibleIndexes: number[];
  webtoonVisibleIndexes: number[];
  prefetchIndexes: number[];
  webtoon: boolean;
  pageIndex: number;
  onError: (msg: string | null) => void;
};

export function usePagePreload(args: Args) {
  const {
    jobId,
    source,
    stateSource,
    stateJobId,
    statePagesDone,
    visibleIndexes,
    webtoonVisibleIndexes,
    prefetchIndexes,
    webtoon,
    pageIndex,
    onError,
  } = args;

  const [loaded, setLoaded] = useState<Record<number, LoadedPage>>({});
  const [busy, setBusy] = useState(false);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const pageIndexRef = useRef(pageIndex);
  pageIndexRef.current = pageIndex;
  const inflightPagesRef = useRef<Set<number>>(new Set());
  const prepareBookEpochRef = useRef(0);

  const resetForNewBook = () => {
    setLoaded({});
    inflightPagesRef.current.clear();
    prepareBookEpochRef.current += 1;
  };

  useEffect(() => {
    const bookEpoch = prepareBookEpochRef.current;
    const stillThisBook = () => bookEpoch === prepareBookEpochRef.current;
    const jid = stateJobId ?? jobId;
    const src = stateSource ?? source;
    if (!src && !jid) return;

    const need = (idx: number) => {
      if (inflightPagesRef.current.has(idx)) return false;
      const existing = loadedRef.current[idx];
      return !existing || existing.kind !== "original";
    };

    const apply = (files: { index: number; name: string; kind: string; path: string }[]) => {
      if (!stillThisBook() || files.length === 0) return;
      setLoaded((prev) => {
        const next = { ...prev };
        for (const file of files) {
          next[file.index] = { ...file, url: fileUrl(file.path, file.kind) };
        }
        const keys = Object.keys(next).map(Number);
        const center = pageIndexRef.current;
        const visible = webtoonVisibleIndexes.length;
        const limit = webtoon ? Math.max(28, visible + 12) : LOADED_WINDOW;
        const half = webtoon ? Math.max(8, Math.ceil(visible / 2) + 6) : LOADED_HALF_WINDOW;
        if (keys.length > limit) {
          for (const k of keys) {
            if (Math.abs(k - center) > half) delete next[k];
          }
        }
        return next;
      });
    };

    const mark = (indexes: number[], on: boolean) => {
      for (const index of indexes) {
        if (on) inflightPagesRef.current.add(index);
        else inflightPagesRef.current.delete(index);
      }
    };

    (async () => {
      const urgent = (webtoon ? webtoonVisibleIndexes : visibleIndexes).filter(need);
      const rest = prefetchIndexes.filter((i) => !urgent.includes(i) && need(i));
      try {
        if (urgent.length > 0) {
          if (!webtoon) setBusy(true);
          mark(urgent, true);
          try {
            const files = await prepareReaderPages({
              jobId: jid,
              source: src,
              pageIndexes: urgent,
              preferOriginal: true,
            });
            apply(files);
          } finally {
            mark(urgent, false);
          }
        }
      } catch (e) {
        if (stillThisBook()) onError(errorMessage(e));
      } finally {
        if (stillThisBook() && !webtoon) setBusy(false);
      }
      if (!stillThisBook() || rest.length === 0) return;
      mark(rest, true);
      try {
        const files = await prepareReaderPages({
          jobId: jid,
          source: src,
          pageIndexes: rest,
          preferOriginal: true,
        });
        apply(files);
      } catch {
        /* prefetch is best-effort */
      } finally {
        mark(rest, false);
      }
    })();
    // Sliding the strip must not abort in-flight extracts: cancelled applies
    // left holes that remounted as placeholders and flashed the canvas.
  }, [
    visibleIndexes,
    webtoonVisibleIndexes,
    prefetchIndexes,
    stateSource,
    stateJobId,
    statePagesDone,
    jobId,
    source,
    onError,
    webtoon,
  ]);

  return { loaded, busy, resetForNewBook, loadedRef, pageIndexRef };
}
