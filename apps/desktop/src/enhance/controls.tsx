import { useEffect, useRef, useState, type ReactNode } from "react";

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
      <div className="mb-2 flex min-h-4 items-center justify-between gap-3">
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
              : "border-ink-300 bg-ink-200/80 text-ink-700 hover:bg-ink-300 dark:border-white/[0.08] dark:bg-surface-raised dark:text-fg dark:hover:bg-surface-high"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function SelectBox<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.id === value) ?? options[0];
  const single = options.length <= 1;

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

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        disabled={single}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!single) setOpen((v) => !v);
        }}
        className={`w-full h-10 flex items-center justify-between gap-2 rounded-full border px-3 text-sm text-left transition ${
          open
            ? "border-ink-950 bg-white text-ink-950 dark:border-fg dark:bg-surface-raised dark:text-fg"
            : "border-ink-300 bg-white text-ink-800 hover:border-ink-500 dark:border-white/[0.08] dark:bg-surface-raised dark:text-fg dark:hover:border-white/20"
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
      {open && !single && (
        <ul
          role="listbox"
          className="absolute z-30 mt-1.5 w-full overflow-hidden rounded-xl border border-ink-200 bg-white py-1 shadow-panel dark:border-white/[0.08] dark:bg-surface-raised/95 dark:backdrop-blur-md"
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
