import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

type StripPage = { url: string; name: string } | undefined;

export type WebtoonJumpRequest = {
  seq: number;
  index: number;
  align: "start" | "end";
};

type Props = {
  pageCount: number;
  pageIndex: number;
  pages: Record<number, StripPage>;
  maxWidth: number;
  canvasHex: string;
  sourceKey: string;
  contentWidth: number;
  viewportRef: RefObject<HTMLDivElement | null>;
  jumpRequest: WebtoonJumpRequest | null;
  estimateSize: (index: number) => number;
  onImageLoad: (index: number, image: HTMLImageElement) => void;
  onVisibleIndexes: (indexes: number[]) => void;
  onPageChange: (index: number, meta: { fromScroll: boolean }) => void;
};

function findMidpointIndex(items: VirtualItem[], midpoint: number, fallback: number): number {
  let closest = fallback;
  let distance = Number.POSITIVE_INFINITY;
  for (const item of items) {
    if (item.start <= midpoint && midpoint < item.end) return item.index;
    const nextDistance = midpoint < item.start ? item.start - midpoint : midpoint - item.end;
    if (nextDistance < distance) {
      distance = nextDistance;
      closest = item.index;
    }
  }
  return closest;
}

export function WebtoonStrip({
  pageCount,
  pageIndex,
  pages,
  maxWidth,
  canvasHex,
  sourceKey,
  contentWidth,
  viewportRef,
  jumpRequest,
  estimateSize,
  onImageLoad,
  onVisibleIndexes,
  onPageChange,
}: Props) {
  const jumpingRef = useRef(false);
  const lastJumpSeqRef = useRef<number | null>(null);
  const lastPageRef = useRef(pageIndex);
  const metricRef = useRef<{ index: number; ratio: number } | null>(null);
  const lastWidthRef = useRef(0);
  // TanStack Virtual owns scroll state and intentionally exposes non-memoizable methods.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: pageCount,
    getScrollElement: () => viewportRef.current,
    estimateSize,
    overscan: 4,
    getItemKey: (index) => index,
    paddingStart: 0,
    paddingEnd: 0,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const visibleKey = virtualItems.map((item) => item.index).join(",");

  useEffect(() => {
    onVisibleIndexes(visibleKey ? visibleKey.split(",").map(Number) : []);
  }, [onVisibleIndexes, visibleKey]);

  useEffect(() => {
    if (jumpingRef.current || virtualItems.length === 0) return;
    const scrollElement = viewportRef.current;
    if (!scrollElement) return;
    const offset = virtualizer.scrollOffset ?? 0;
    const midpoint = offset + scrollElement.clientHeight / 2;
    const hit = findMidpointIndex(virtualItems, midpoint, pageIndex);
    const item = virtualItems.find((entry) => entry.index === hit);
    if (item && item.size > 0) {
      metricRef.current = {
        index: hit,
        ratio: Math.max(0, Math.min(1, (offset - item.start) / item.size)),
      };
    }
    if (hit === lastPageRef.current) return;
    lastPageRef.current = hit;
    onPageChange(hit, { fromScroll: true });
  }, [onPageChange, pageIndex, virtualItems, virtualizer, viewportRef]);

  useLayoutEffect(() => {
    if (!jumpRequest || jumpRequest.seq === lastJumpSeqRef.current) return;
    lastJumpSeqRef.current = jumpRequest.seq;
    jumpingRef.current = true;
    lastPageRef.current = jumpRequest.index;
    virtualizer.scrollToIndex(jumpRequest.index, { align: jumpRequest.align });
    let attempts = 0;
    const settle = () => {
      attempts += 1;
      const scrollElement = viewportRef.current;
      const item =
        virtualizer.getVirtualItems().find((entry) => entry.index === jumpRequest.index) ??
        virtualizer.measurementsCache[jumpRequest.index];
      const offset = virtualizer.scrollOffset ?? 0;
      const clientHeight = scrollElement?.clientHeight ?? 0;
      const target =
        item == null
          ? offset
          : jumpRequest.align === "end"
            ? Math.max(0, item.end - clientHeight)
            : item.start;
      if (item && Math.abs(target - offset) < 4) {
        jumpingRef.current = false;
        return;
      }
      if (attempts === 2 || attempts === 5) {
        virtualizer.scrollToIndex(jumpRequest.index, { align: jumpRequest.align });
      }
      if (attempts >= 12) {
        jumpingRef.current = false;
        return;
      }
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }, [jumpRequest, virtualizer, viewportRef]);

  useLayoutEffect(() => {
    virtualizer.measure();
    const el = viewportRef.current;
    const metric = metricRef.current;
    const prevWidth = lastWidthRef.current;
    lastWidthRef.current = contentWidth;
    if (!el || !metric || prevWidth <= 0 || contentWidth <= 0 || prevWidth === contentWidth) return;
    const placed = virtualizer.getOffsetForIndex(metric.index, "start");
    if (!placed) return;
    const measured = virtualizer.measurementsCache[metric.index];
    const size = measured?.size ?? estimateSize(metric.index);
    jumpingRef.current = true;
    el.scrollTop = placed[0] + metric.ratio * size;
    requestAnimationFrame(() => {
      jumpingRef.current = false;
    });
  }, [contentWidth, estimateSize, sourceKey, virtualizer, viewportRef]);

  return (
    <div
      className="reader-strip relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
      data-strip-source={sourceKey}
    >
      {virtualItems.map((item) => {
        const page = pages[item.index];
        return (
          <div
            key={item.key}
            data-index={item.index}
            data-strip-page={item.index}
            ref={virtualizer.measureElement}
            className="reader-strip-page absolute left-1/2 w-full min-w-0"
            style={{
              top: 0,
              maxWidth,
              minHeight: estimateSize(item.index),
              transform: `translate(-50%, ${item.start}px)`,
            }}
          >
            {page ? (
              <img
                src={page.url}
                alt={page.name}
                decoding="async"
                draggable={false}
                className="reader-page-img block h-auto w-full min-w-0 max-w-full select-none"
                onLoad={(event) => {
                  const image = event.currentTarget;
                  const box = image.parentElement;
                  onImageLoad(item.index, image);
                  requestAnimationFrame(() => {
                    if (box) virtualizer.measureElement(box);
                    if (jumpingRef.current && jumpRequest?.index === item.index) {
                      virtualizer.scrollToIndex(item.index, { align: jumpRequest.align });
                    }
                  });
                }}
              />
            ) : (
              <div
                className="w-full"
                style={{ height: estimateSize(item.index), backgroundColor: canvasHex }}
                aria-hidden="true"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
