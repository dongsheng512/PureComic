import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";

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

type EngineProps = Props & {
  layoutWidth: number;
  metricRef: MutableRefObject<{ index: number; ratio: number } | null>;
};

function StripEngine({
  pageCount,
  pageIndex,
  pages,
  maxWidth,
  canvasHex,
  sourceKey,
  contentWidth,
  layoutWidth,
  viewportRef,
  jumpRequest,
  estimateSize,
  onImageLoad,
  onVisibleIndexes,
  onPageChange,
  metricRef,
}: EngineProps) {
  const jumpingRef = useRef(false);
  const lastJumpSeqRef = useRef<number | null>(null);
  const lastPageRef = useRef(pageIndex);
  const jumpClearTimer = useRef<number | null>(null);
  const [decoded, setDecoded] = useState<Set<number>>(() => new Set());
  // TanStack Virtual owns scroll state and intentionally exposes non-memoizable methods.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: pageCount,
    getScrollElement: () => viewportRef.current,
    estimateSize,
    overscan: 3,
    getItemKey: (index) => index,
    paddingStart: 0,
    paddingEnd: 0,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const visibleKey = virtualItems.map((item) => item.index).join(",");

  useEffect(() => {
    onVisibleIndexes(visibleKey ? visibleKey.split(",").map(Number) : []);
  }, [onVisibleIndexes, visibleKey]);

  useLayoutEffect(() => {
    const metric = metricRef.current;
    const el = viewportRef.current;
    if (!el || pageCount <= 0) return;
    if (metric) {
      const placed = virtualizer.getOffsetForIndex(metric.index, "start");
      if (placed) {
        jumpingRef.current = true;
        el.scrollTop = placed[0] + metric.ratio * estimateSize(metric.index);
        lastPageRef.current = metric.index;
        requestAnimationFrame(() => {
          jumpingRef.current = false;
        });
        return;
      }
    }
    if (pageIndex > 0) {
      jumpingRef.current = true;
      virtualizer.scrollToIndex(pageIndex, { align: "start" });
      lastPageRef.current = pageIndex;
      requestAnimationFrame(() => {
        jumpingRef.current = false;
      });
    }
    // Restore once when this layout-width engine mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let frame = 0;
    const syncFromScroll = () => {
      if (jumpingRef.current) return;
      const offset = el.scrollTop;
      const midpoint = offset + el.clientHeight / 2;
      const found = virtualizer.getVirtualItemForOffset(midpoint);
      const hit = found?.index ?? lastPageRef.current;
      if (found && found.size > 0) {
        metricRef.current = {
          index: hit,
          ratio: Math.max(0, Math.min(1, (offset - found.start) / found.size)),
        };
      }
      if (hit === lastPageRef.current) return;
      lastPageRef.current = hit;
      onPageChange(hit, { fromScroll: true });
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        syncFromScroll();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [metricRef, onPageChange, virtualizer, viewportRef]);

  useLayoutEffect(() => {
    if (!jumpRequest || jumpRequest.seq === lastJumpSeqRef.current) return;
    lastJumpSeqRef.current = jumpRequest.seq;
    jumpingRef.current = true;
    lastPageRef.current = jumpRequest.index;
    virtualizer.scrollToIndex(jumpRequest.index, { align: jumpRequest.align });
    const frame = requestAnimationFrame(() => {
      virtualizer.scrollToIndex(jumpRequest.index, { align: jumpRequest.align });
      if (jumpClearTimer.current != null) window.clearTimeout(jumpClearTimer.current);
      jumpClearTimer.current = window.setTimeout(() => {
        jumpingRef.current = false;
        jumpClearTimer.current = null;
      }, 90);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (jumpClearTimer.current != null) window.clearTimeout(jumpClearTimer.current);
    };
  }, [jumpRequest, virtualizer]);

  useEffect(() => {
    setDecoded(new Set());
  }, [sourceKey]);

  return (
    <div
      className="reader-strip relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
      data-strip-source={sourceKey}
    >
      {virtualItems.map((item) => {
        const page = pages[item.index];
        const measured = decoded.has(item.index);
        const near = Math.abs(item.index - pageIndex) <= 1;
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
              minHeight: measured ? undefined : estimateSize(item.index),
              transform: `translate(-50%, ${item.start}px)`,
            }}
          >
            {page ? (
              <img
                src={page.url}
                alt={page.name}
                decoding="async"
                fetchPriority={near ? "high" : "low"}
                draggable={false}
                className="reader-page-img block h-auto w-full min-w-0 max-w-full select-none"
                onLoad={(event) => {
                  const image = event.currentTarget;
                  const naturalWidth = Math.max(1, image.naturalWidth);
                  const naturalHeight = Math.max(1, image.naturalHeight);
                  const aspect = naturalHeight / naturalWidth;
                  onImageLoad(item.index, image);
                  const width = Math.min(
                    Math.max(1, image.getBoundingClientRect().width || contentWidth || layoutWidth),
                    maxWidth,
                  );
                  const height = Number.isFinite(aspect) && aspect > 0 ? Math.round(width * aspect) : Math.round(image.getBoundingClientRect().height);
                  if (height > 0) virtualizer.resizeItem(item.index, height);
                  setDecoded((prev) => {
                    if (prev.has(item.index)) return prev;
                    const next = new Set(prev);
                    next.add(item.index);
                    return next;
                  });
                  if (jumpingRef.current && jumpRequest?.index === item.index) {
                    virtualizer.scrollToIndex(item.index, { align: jumpRequest.align });
                  }
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

export function WebtoonStrip(props: Props) {
  const metricRef = useRef<{ index: number; ratio: number } | null>(null);
  const [layoutWidth, setLayoutWidth] = useState(props.contentWidth);

  useEffect(() => {
    if (props.contentWidth <= 0) return;
    if (Math.abs(props.contentWidth - layoutWidth) < 1) return;
    const timer = window.setTimeout(() => setLayoutWidth(props.contentWidth), 64);
    return () => window.clearTimeout(timer);
  }, [layoutWidth, props.contentWidth]);

  useEffect(() => {
    setLayoutWidth(props.contentWidth);
  }, [props.sourceKey]);

  return (
    <StripEngine
      key={`${props.sourceKey}:${layoutWidth}`}
      {...props}
      layoutWidth={layoutWidth > 0 ? layoutWidth : props.contentWidth}
      metricRef={metricRef}
    />
  );
}
