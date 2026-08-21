import type { MutableRefObject } from "react";

type Props = {
  total: number;
  progressHud: boolean;
  progressPct: number;
  pageLabel: string;
  /** 全屏或隐藏顶栏时才在底部显示页码；顶栏可见时页码已在 header 中央 */
  showPageLabel: boolean;
  /** 阅读器画布：深色用白条，浅色用黑条 */
  onDark: boolean;
  progressTimer: MutableRefObject<number | null>;
  setProgressHud: (v: boolean) => void;
  flashProgress: () => void;
  seekProgress: (clientX: number, rect: DOMRect) => void;
};

export function ProgressHud({
  total,
  progressHud,
  progressPct,
  pageLabel,
  showPageLabel,
  onDark,
  progressTimer,
  setProgressHud,
  flashProgress,
  seekProgress,
}: Props) {
  if (total <= 0) return null;
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-0 z-20 select-none transition-opacity duration-300 ${
        progressHud ? "opacity-100" : "opacity-0"
      }`}
    >
      <div
        className={`pointer-events-auto bg-transparent px-4 pt-2 ${
          showPageLabel ? "pb-3" : "pb-1"
        }`}
        onMouseEnter={() => {
          setProgressHud(true);
          if (progressTimer.current != null) window.clearTimeout(progressTimer.current);
        }}
        onMouseLeave={flashProgress}
      >
        {/* mousedown preventDefault：细条按下易变成拖选（WebKit 选区），禁止从进度条启动选区 */}
        <button
          type="button"
          aria-label={pageLabel}
          className={`block h-3 w-full cursor-pointer ${
            progressHud ? "pointer-events-auto" : "pointer-events-none"
          }`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            seekProgress(e.clientX, e.currentTarget.getBoundingClientRect());
          }}
        >
          <span
            className={`flex h-1.5 items-center rounded-full ${
              onDark ? "bg-white/12" : "bg-black/8"
            }`}
          >
            <span
              className="h-1.5 rounded-full bg-[#b0b0b0] transition-[width] duration-200"
              style={{ width: `${progressPct}%` }}
            />
          </span>
        </button>
        {showPageLabel && (
          <p
            className={`pointer-events-none mt-1.5 select-none text-center text-[11px] tabular-nums ${
              onDark ? "text-white/45" : "text-black/40"
            }`}
          >
            {pageLabel}
          </p>
        )}
      </div>
    </div>
  );
}
