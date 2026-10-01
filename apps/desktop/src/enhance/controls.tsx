import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex min-h-4 items-center justify-between gap-3">
        <p className="label shrink-0">{label}</p>
        {hint && (
          <p className="field-hint min-w-0 truncate text-right" title={hint}>
            {hint}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onChange(opt.id)}
          className={`rounded-full px-3 py-2 text-sm border transition ${
            value === opt.id
              ? "border-ink-400 bg-ink-300 text-ink-800 dark:border-white/20 dark:bg-surface-high dark:text-fg"
              : "border-ink-300 bg-ink-200/80 text-ink-700 hover:bg-ink-300 dark:border-white/10 dark:bg-surface-raised dark:text-fg dark:hover:bg-surface-high"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** 下拉列表的估算高度：每项一行 + 列表内边距 + 与触发按钮之间的间距 */
const LIST_ITEM_H = 36;
const LIST_PAD = 8;
const LIST_GAP = 6;

/**
 * 下拉列表向上还是向下展开。
 * 下方放不下整个列表、且上方更宽敞时向上弹——否则最后一个选项会落到可视区之外，
 * 用户得先滚动页面才能点选。
 */
export function pickPlacement(args: {
  anchorTop: number;
  anchorBottom: number;
  boundsTop: number;
  boundsBottom: number;
  itemCount: number;
}): "up" | "down" {
  const need = args.itemCount * LIST_ITEM_H + LIST_PAD + LIST_GAP;
  const below = args.boundsBottom - args.anchorBottom;
  const above = args.anchorTop - args.boundsTop;
  return below < need && above > below ? "up" : "down";
}

/** 最近的可滚动祖先的可视范围；没有可滚动祖先时退回视口。 */
function scrollBounds(el: HTMLElement | null): { top: number; bottom: number } {
  let node = el?.parentElement ?? null;
  while (node) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) {
      const r = node.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    }
    node = node.parentElement;
  }
  const h = typeof window === "undefined" ? 0 : window.innerHeight;
  return { top: 0, bottom: h };
}

export function SelectBox<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
  /** 外部禁用（例如 PNG 无损格式下画质档位不生效） */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"up" | "down">("down");
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.id === value) ?? options[0];
  const locked = disabled || options.length <= 1;

  const place = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const b = scrollBounds(el);
    setPlacement(
      pickPlacement({
        anchorTop: r.top,
        anchorBottom: r.bottom,
        boundsTop: b.top,
        boundsBottom: b.bottom,
        itemCount: options.length,
      }),
    );
  }, [options.length]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 展开期间页面/容器滚动会改变可用空间，实时重算，避免列表又跑到屏幕外
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        disabled={locked}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (locked) return;
          if (!open) place();
          setOpen((v) => !v);
        }}
        className={`w-full h-10 flex items-center justify-between gap-2 rounded-full border px-3 text-sm text-left transition ${
          open
            ? "border-ink-950 bg-white text-ink-950 dark:border-fg dark:bg-surface-raised dark:text-fg"
            : "border-ink-300 bg-white text-ink-800 hover:border-ink-500 dark:border-white/10 dark:bg-surface-raised dark:text-fg dark:hover:border-white/20"
        } disabled:opacity-80 disabled:cursor-default`}
      >
        <span className="truncate">{selected?.label ?? "—"}</span>
        <svg
          viewBox="0 0 20 20"
          className={`h-4 w-4 shrink-0 text-ink-400 transition ${open ? "rotate-180 text-ink-950 dark:text-fg" : ""}`}
          aria-hidden="true"
        >
          <path
            fill="currentColor"
            d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.58l3.3-3.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.42Z"
          />
        </svg>
      </button>
      {open && !locked && (
        <ul
          role="listbox"
          className={`absolute z-30 max-h-72 w-full overflow-y-auto rounded-xl border border-ink-200 bg-white py-1 shadow-panel dark:border-white/10 dark:bg-surface-raised/95 dark:backdrop-blur-md ${
            placement === "up" ? "bottom-full mb-1.5" : "mt-1.5"
          }`}
        >
          {options.map((opt) => {
            const active = opt.id === value;
            return (
              <li key={opt.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`flex w-full items-center justify-between px-3 py-2 text-sm text-left transition ${
                    active
                      ? "bg-ink-200 text-ink-950 dark:bg-surface-high dark:text-fg"
                      : "text-ink-700 hover:bg-ink-100 hover:text-ink-950 dark:text-fg dark:hover:bg-surface-high dark:hover:text-fg"
                  }`}
                  onClick={() => {
                    onChange(opt.id);
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{opt.label}</span>
                  {active && (
                    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 shrink-0 text-ink-950 dark:text-fg" aria-hidden="true">
                      <path
                        fill="currentColor"
                        d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.2 7.2a1 1 0 0 1-1.4 0L3.3 9.1a1 1 0 1 1 1.4-1.4l4.1 4.08 6.5-6.48a1 1 0 0 1 1.4 0Z"
                      />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
