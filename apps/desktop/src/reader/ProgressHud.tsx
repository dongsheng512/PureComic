import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
} from "react";

export type ProgressPreview = { pct: number; label: string; page: number };

type Props = {
  total: number;
  progressHud: boolean;
  progressPct: number;
  pageLabel: string;
  /** 当前页（1-based），拖动时改用预览页 */
  pageNumber: number;
  /** 全屏或隐藏顶栏时才在底部显示页码；顶栏可见时页码已在 header 中央 */
  showPageLabel: boolean;
  /** 阅读器画布：深色用白条，浅色用黑条 */
  onDark: boolean;
  progressTimer: MutableRefObject<number | null>;
  setProgressHud: (v: boolean) => void;
  flashProgress: () => void;
  /** 拖动中的落点。只改预览，不翻页。 */
  previewProgress: (clientX: number, rect: DOMRect) => ProgressPreview | null;
  /** 松手时跳到该位置。点击是一次零位移的拖动。 */
  seekProgress: (clientX: number, rect: DOMRect) => void;
  /** 键盘步进：direction 为 ±1 页（Home/End 由组件内换算成首尾页） */
  go: (dir: 1 | -1) => void;
};

export function ProgressHud({
  total,
  progressHud,
  progressPct,
  pageLabel,
  pageNumber,
  showPageLabel,
  onDark,
  progressTimer,
  setProgressHud,
  flashProgress,
  previewProgress,
  seekProgress,
  go,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(false);
  const hoverRef = useRef(false);
  const [preview, setPreview] = useState<ProgressPreview | null>(null);
  const dragging = preview != null;

  useEffect(() => {
    if (!dragging) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = "ew-resize";
    return () => {
      document.body.style.cursor = prev;
    };
  }, [dragging]);

  // 拖动中换书（total 归零提前 return null）时 preview 不再被流程清空，
  // 光标会滞留在 ew-resize——total 失效视为拖动终止
  useEffect(() => {
    if (total <= 0 && preview) {
      dragRef.current = false;
      setPreview(null);
    }
  }, [total, preview]);

  if (total <= 0) return null;

  const pct = preview?.pct ?? progressPct;
  const label = preview?.label ?? pageLabel;
  const labelClass = `pointer-events-none select-none text-center text-[11px] tabular-nums ${
    onDark ? "text-white/45" : "text-black/40"
  }`;

  const holdOpen = () => {
    setProgressHud(true);
    if (progressTimer.current != null) window.clearTimeout(progressTimer.current);
  };

  const readPreview = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return null;
    return previewProgress(clientX, track.getBoundingClientRect());
  };

  const finishDrag = (clientX: number) => {
    if (!dragRef.current) return;
    dragRef.current = false;
    setPreview(null);
    const track = trackRef.current;
    if (track) seekProgress(clientX, track.getBoundingClientRect());
    // 指针已离开热区时 mouseleave 被拖动抑制过，这里补上自动淡出
    if (!hoverRef.current) flashProgress();
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // 细条按下易变成拖选（WebKit 选区）；捕获指针后移出热区仍能继续拖拉
    e.preventDefault();
    e.stopPropagation();
    const hit = readPreview(e.clientX);
    if (!hit) return;
    dragRef.current = true;
    holdOpen();
    setPreview(hit);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const hit = readPreview(e.clientX);
    if (hit) setPreview(hit);
  };

  // ARIA slider 角色：必须可聚焦并响应方向键（底部 HUD 是键盘用户
  // 在全屏/藏栏下唯一的进度条入口；顶栏 range 不可见时尤其如此）
  const onTrackKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (total <= 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      holdOpen();
      go(1);
      flashProgress();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      holdOpen();
      go(-1);
      flashProgress();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      holdOpen();
      const track = trackRef.current;
      if (track) {
        const rect = track.getBoundingClientRect();
        seekProgress(e.key === "Home" ? rect.left + 1 : rect.right - 1, rect);
      }
      flashProgress();
    }
  };

  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-0 z-20 select-none transition-opacity duration-300 ${
        progressHud ? "opacity-100" : "opacity-0"
      }`}
    >
      {/* pointer-events 只挂 track 一层：容器 padding 不进热区，避免条上下方误触 seek */}
      <div
        className={`pointer-events-none relative bg-transparent px-4 pt-2 touch-none ${
          showPageLabel ? "pb-3" : "pb-1"
        }`}
      >
        {preview && !showPageLabel && (
          <p className={`absolute bottom-full left-0 right-0 mb-1 ${labelClass}`}>{label}</p>
        )}
        <div
          ref={trackRef}
          role="slider"
          tabIndex={progressHud ? 0 : -1}
          aria-label={pageLabel}
          aria-valuemin={1}
          aria-valuemax={total}
          aria-valuenow={preview?.page ?? pageNumber}
          aria-valuetext={label}
          onKeyDown={onTrackKeyDown}
          onMouseEnter={() => {
            hoverRef.current = true;
            holdOpen();
          }}
          onMouseLeave={() => {
            hoverRef.current = false;
            if (!dragRef.current) flashProgress();
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => finishDrag(e.clientX)}
          onPointerCancel={(e) => finishDrag(e.clientX)}
          onLostPointerCapture={(e) => finishDrag(e.clientX)}
          className={`flex h-3 w-full items-center touch-none ${
            preview ? "cursor-ew-resize" : "cursor-pointer"
          } ${
            progressHud ? "pointer-events-auto" : "pointer-events-none"
          } focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:rounded-full`}
        >
          <span
            className={`relative block h-1.5 w-full rounded-full ${
              onDark ? "bg-white/10" : "bg-black/10"
            }`}
          >
            <span
              className={`block h-full rounded-full bg-[#b0b0b0] ${
                preview ? "" : "transition-[width] duration-200"
              }`}
              style={{ width: `${pct}%` }}
            />
            {preview && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#d4d4d4] shadow-sm"
                style={{ left: `${pct}%` }}
              />
            )}
          </span>
        </div>
        {showPageLabel && <p className={`mt-1.5 ${labelClass}`}>{label}</p>}
      </div>
    </div>
  );
}
