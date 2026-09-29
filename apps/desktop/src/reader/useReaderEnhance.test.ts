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
  clearReaderEnhanceCache: vi.fn(async () => undefined),
  readerEnhanceCacheStats: vi.fn(async () => ({ bytes: 0, files: 0 })),
  errorMessage: (e: unknown) => String(e),
  isCancelledError: () => false,
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
    api.cancelReaderEnhance.mockClear();
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
});
