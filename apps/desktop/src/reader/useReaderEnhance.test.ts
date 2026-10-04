import { Window } from "happy-dom";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
});

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Messages } from "../i18n";
import type { ReaderPageFile } from "../types";

const api = vi.hoisted(() => ({
  listEngines: vi.fn(async () => []),
  lookupReaderEnhancePages: vi.fn(async () => [] as ReaderPageFile[]),
  enhanceReaderPages: vi.fn(),
  cancelReaderEnhance: vi.fn(async () => undefined),
  preheatReaderEngine: vi.fn(async () => undefined),
  clearReaderEnhanceCache: vi.fn(async () => undefined),
  readerEnhanceCacheStats: vi.fn(async () => ({ bytes: 0, files: 0 })),
  errorMessage: (e: unknown) => String(e),
  isCancelledError: (e: unknown) =>
    typeof e === "object" && e !== null && (e as { code?: string }).code === "CANCELLED",
}));

vi.mock("../api", () => api);

import { useReaderEnhance } from "./useReaderEnhance";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const i18n = {} as Messages;

function args(visible: number[], pageIndex = 0) {
  return {
    i18n,
    source: "/book",
    jobId: null,
    stateSource: "/book",
    stateJobId: null,
    statePageCount: 8,
    pageIndex,
    visibleIndexes: visible,
    prefetchRtl: false,
    webtoon: false,
    onError: vi.fn(),
  };
}

describe("useReaderEnhance", () => {
  beforeEach(() => {
    localStorage.clear();
    api.enhanceReaderPages.mockReset();
    api.cancelReaderEnhance.mockReset();
    api.cancelReaderEnhance.mockImplementation(async () => undefined);
    api.preheatReaderEngine.mockClear();
    api.lookupReaderEnhancePages.mockReset();
    api.lookupReaderEnhancePages.mockResolvedValue([]);
  });

  it("keeps busy when an older page finishes after a turn", async () => {
    const first = deferred<ReaderPageFile[]>();
    const second = deferred<ReaderPageFile[]>();
    api.enhanceReaderPages.mockImplementationOnce(() => first.promise);
    api.enhanceReaderPages.mockImplementationOnce(() => second.promise);

    const { result, rerender } = renderHook(
      (props: ReturnType<typeof args>) => useReaderEnhance(props),
      { initialProps: args([0]) },
    );
    act(() => result.current.toggleAi());

    await waitFor(() => expect(api.enhanceReaderPages).toHaveBeenCalledTimes(1));
    rerender(args([1], 1));
    await waitFor(() => expect(api.enhanceReaderPages).toHaveBeenCalledTimes(2));

    await act(async () => {
      first.resolve([]);
    });
    expect(result.current.enhanceBusy).toBe(true);

    await act(async () => {
      second.resolve([]);
    });
    await waitFor(() => expect(result.current.enhanceBusy).toBe(false));
  });

  it("does not cancel again while AI stays off", async () => {
    const { result, rerender } = renderHook(
      (props: ReturnType<typeof args>) => useReaderEnhance(props),
      { initialProps: args([0]) },
    );
    act(() => result.current.toggleAi());
    await waitFor(() => expect(api.enhanceReaderPages).toHaveBeenCalled());
    const calls = api.cancelReaderEnhance.mock.calls.length;
    act(() => result.current.toggleAi());
    await waitFor(() => expect(api.cancelReaderEnhance.mock.calls.length).toBeGreaterThan(calls));
    const afterOff = api.cancelReaderEnhance.mock.calls.length;
    rerender(args([2], 2));
    expect(api.cancelReaderEnhance.mock.calls.length).toBe(afterOff);
  });

  it("cancels a disjoint in-flight batch before requesting the jumped page", async () => {
    const prefetch = deferred<ReaderPageFile[]>();
    const jumped = deferred<ReaderPageFile[]>();
    const cancelGate = deferred<undefined>();
    let calls = 0;
    api.enhanceReaderPages.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve([] as ReaderPageFile[]);
      if (calls === 2) return prefetch.promise;
      return jumped.promise;
    });
    api.cancelReaderEnhance.mockImplementationOnce(() => cancelGate.promise);

    const { result, rerender } = renderHook(
      (props: ReturnType<typeof args>) => useReaderEnhance(props),
      { initialProps: args([0]) },
    );
    act(() => result.current.toggleAi());
    await waitFor(() => expect(api.enhanceReaderPages).toHaveBeenCalledTimes(2));

    rerender(args([6], 6));
    await waitFor(() => expect(api.cancelReaderEnhance).toHaveBeenCalledTimes(1));
    expect(api.enhanceReaderPages).toHaveBeenCalledTimes(2);

    await act(async () => {
      cancelGate.resolve(undefined);
    });
    await waitFor(() => expect(api.enhanceReaderPages).toHaveBeenCalledTimes(3));
    expect(api.enhanceReaderPages.mock.calls[2]?.[0]?.pageIndexes).toEqual([6]);
  });

  it("keeps an in-flight batch that already covers the new page", async () => {
    const prefetch = deferred<ReaderPageFile[]>();
    let calls = 0;
    api.enhanceReaderPages.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve([] as ReaderPageFile[]);
      return prefetch.promise;
    });

    const { result, rerender } = renderHook(
      (props: ReturnType<typeof args>) => useReaderEnhance(props),
      { initialProps: args([0]) },
    );
    act(() => result.current.toggleAi());
    await waitFor(() => expect(api.enhanceReaderPages).toHaveBeenCalledTimes(2));
    expect(api.enhanceReaderPages.mock.calls[1]?.[0]?.pageIndexes).toEqual([1, 2]);

    rerender(args([1], 1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.cancelReaderEnhance).not.toHaveBeenCalled();
  });

  it("preheats when AI turns on, not when the panel is merely closed", async () => {
    const { result } = renderHook(
      (props: ReturnType<typeof args>) => useReaderEnhance(props),
      { initialProps: args([0]) },
    );
    expect(api.preheatReaderEngine).not.toHaveBeenCalled();
    act(() => result.current.toggleAi());
    await waitFor(() => expect(api.preheatReaderEngine).toHaveBeenCalledTimes(1));
    act(() => result.current.toggleAi());
    expect(api.preheatReaderEngine).toHaveBeenCalledTimes(1);
  });

  it("does not submit a prefetch that resolves after the page changed", async () => {
    const prefLookup = deferred<ReaderPageFile[]>();
    let lookups = 0;
    api.lookupReaderEnhancePages.mockImplementation(() => {
      lookups += 1;
      if (lookups === 2) return prefLookup.promise;
      return Promise.resolve([] as ReaderPageFile[]);
    });
    api.enhanceReaderPages.mockResolvedValue([] as ReaderPageFile[]);

    const { result, rerender } = renderHook(
      (props: ReturnType<typeof args>) => useReaderEnhance(props),
      { initialProps: args([0]) },
    );
    act(() => result.current.toggleAi());
    await waitFor(() => expect(api.lookupReaderEnhancePages).toHaveBeenCalledTimes(2));
    expect(api.enhanceReaderPages).toHaveBeenCalledTimes(1);
    expect(api.enhanceReaderPages.mock.calls[0]?.[0]?.pageIndexes).toEqual([0]);

    rerender(args([6], 6));
    await waitFor(() =>
      expect(
        api.enhanceReaderPages.mock.calls.some((call) => call[0]?.pageIndexes?.includes(6)),
      ).toBe(true),
    );

    await act(async () => {
      prefLookup.resolve([]);
      await Promise.resolve();
    });
    const indexes = api.enhanceReaderPages.mock.calls.map(
      (call) => call[0]?.pageIndexes as number[],
    );
    expect(indexes.some((pages) => pages?.includes(1) || pages?.includes(2))).toBe(false);
  });

  it("retries the page that an older cancel clears", async () => {
    const prefetch = deferred<ReaderPageFile[]>();
    const cancelGate = deferred<undefined>();
    let calls = 0;
    api.enhanceReaderPages.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve([] as ReaderPageFile[]);
      if (calls === 2) return prefetch.promise;
      if (calls === 3) return Promise.reject({ code: "CANCELLED" });
      return Promise.resolve([] as ReaderPageFile[]);
    });
    api.cancelReaderEnhance.mockImplementationOnce(() => cancelGate.promise);

    const { result, rerender } = renderHook(
      (props: ReturnType<typeof args>) => useReaderEnhance(props),
      { initialProps: args([0]) },
    );
    act(() => result.current.toggleAi());
    await waitFor(() => expect(api.enhanceReaderPages).toHaveBeenCalledTimes(2));

    rerender(args([6], 6));
    await waitFor(() => expect(api.cancelReaderEnhance).toHaveBeenCalledTimes(1));
    rerender(args([1], 1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.enhanceReaderPages).toHaveBeenCalledTimes(2);

    await act(async () => {
      cancelGate.resolve(undefined);
    });
    await waitFor(() => {
      const pages = api.enhanceReaderPages.mock.calls.filter(
        (call) => JSON.stringify(call[0]?.pageIndexes) === "[1]",
      );
      expect(pages).toHaveLength(2);
    });
  });

  it("preheats the newest engine and noise after a failed cancel", async () => {
    api.cancelReaderEnhance.mockRejectedValueOnce(new Error("ipc down"));
    const { result } = renderHook(
      (props: ReturnType<typeof args>) => useReaderEnhance(props),
      { initialProps: args([0]) },
    );
    act(() => result.current.toggleAi());
    await waitFor(() => expect(api.preheatReaderEngine).toHaveBeenCalledTimes(1));
    api.preheatReaderEngine.mockClear();

    act(() => {
      result.current.persistEngine("waifu2x-coreml");
      result.current.persistNoise(2);
    });
    await waitFor(() => expect(result.current.engineId).toBe("waifu2x-coreml"));
    await waitFor(() => expect(result.current.noiseLevel).toBe(2));
    await waitFor(() => expect(api.preheatReaderEngine.mock.calls.length).toBeGreaterThan(0));
    for (const call of api.preheatReaderEngine.mock.calls) {
      expect(call[0]?.engine).toBe("waifu2x-coreml");
      expect(call[0]?.noiseLevel).toBe(2);
    }
  });
});
