import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { comicFileFilter } from "../formats";
import type { Messages } from "../i18n";
import type { LibraryEntry, LibraryScanPreview } from "../types";
import { loadAllReaderPrefs, prefKey } from "../reader/prefs";
import {
  loadImportSettings,
  loadLibraryFilter,
  loadLibrarySort,
  loadLibraryView,
  saveImportSettings,
  saveLibraryFilter,
  saveLibrarySort,
  saveLibraryView,
  type LibraryFilter,
  type LibraryImportSettings,
  type LibrarySort,
  type LibraryViewMode,
} from "./prefs";

type Props = {
  entries: LibraryEntry[];
  dragOver: boolean;
  scanning: boolean;
  i18n: Messages;
  onAddFile: () => void;
  onAddFolder: () => void;
  onScan: (opts?: { addToWatch?: boolean }) => void;
  scanPreview: LibraryScanPreview | null;
  importing: boolean;
  importProgress?: { done: number; total: number } | null;
  onConfirmScan: (paths: string[]) => void;
  onCancelScan: () => void;
  onOpen: (entry: LibraryEntry) => void;
  onEnhance: (entry: LibraryEntry) => void;
  onRemove: (entry: LibraryEntry) => void;
  onImportSettingsChange?: (s: LibraryImportSettings) => void;
  /** 阅读器关闭或偏好变更时递增，避免进度 memo 只跟 entries 走 */
  prefsRev?: number;
};

function coverUrl(path?: string, cacheKey?: string): string | null {
  if (!path) return null;
  try {
    // 空格等字符由 convertFileSrc 处理；附加 cacheKey 避免重生成后仍用旧缓存
    const src = convertFileSrc(path);
    const bust = cacheKey ? encodeURIComponent(cacheKey) : encodeURIComponent(path);
    return `${src}${src.includes("?") ? "&" : "?"}v=${bust}`;
  } catch {
    return null;
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "cbz":
      return "CBZ";
    case "zip":
      return "ZIP";
    case "cbr":
      return "CBR";
    case "epub":
      return "EPUB";
    case "mobi":
      return "MOBI";
    case "folder":
      return "文件夹";
    default:
      return kind;
  }
}

function LibraryView({
  entries,
  dragOver,
  scanning,
  i18n,
  onAddFile,
  onAddFolder,
  onScan,
  scanPreview,
  importing,
  importProgress,
  onConfirmScan,
  onCancelScan,
  onOpen,
  onEnhance,
  onRemove,
  onImportSettingsChange,
  prefsRev = 0,
}: Props) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySort>(loadLibrarySort);
  const [filter, setFilter] = useState<LibraryFilter>(loadLibraryFilter);
  const [view, setView] = useState<LibraryViewMode>(loadLibraryView);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [importSettings, setImportSettings] = useState(loadImportSettings);
  const addRef = useRef<HTMLDivElement>(null);
  const sortRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const addTipTimer = useRef<number | null>(null);
  const [addTip, setAddTip] = useState<{ text: string; x: number; y: number } | null>(null);

  const showAddTip = (e: React.MouseEvent | React.FocusEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (addTipTimer.current != null) window.clearTimeout(addTipTimer.current);
    addTipTimer.current = window.setTimeout(() => {
      setAddTip({
        text: i18n.libraryHint,
        x: Math.min(Math.max(rect.left + rect.width / 2, 140), window.innerWidth - 140),
        y: rect.bottom,
      });
    }, 120);
  };
  const hideAddTip = () => {
    if (addTipTimer.current != null) window.clearTimeout(addTipTimer.current);
    setAddTip(null);
  };

  useEffect(() => {
    return () => {
      if (addTipTimer.current != null) window.clearTimeout(addTipTimer.current);
    };
  }, []);

  useEffect(() => {
    saveLibrarySort(sort);
  }, [sort]);
  useEffect(() => {
    saveLibraryFilter(filter);
  }, [filter]);
  useEffect(() => {
    saveLibraryView(view);
  }, [view]);

  useEffect(() => {
    if (!addOpen && !settingsOpen && !sortOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (addRef.current && !addRef.current.contains(t)) {
        setAddOpen(false);
        setSettingsOpen(false);
      }
      if (sortRef.current && !sortRef.current.contains(t)) setSortOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAddOpen(false);
        setSettingsOpen(false);
        setSortOpen(false);
      }
    };
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", onDoc);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [addOpen, settingsOpen, sortOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const patchImport = (partial: Partial<LibraryImportSettings>) => {
    setImportSettings((prev) => {
      const next = { ...prev, ...partial };
      saveImportSettings(next);
      onImportSettingsChange?.(next);
      return next;
    });
  };

  /** 一次性解析全部阅读偏好，避免排序比较器/过滤/渲染中反复 JSON.parse */
  const progressMap = useMemo(() => {
    void prefsRev;
    const all = loadAllReaderPrefs();
    const map = new Map<string, number>();
    for (const e of entries) {
      map.set(e.path, e.lastReadPage || all.get(prefKey(e.path))?.pageIndex || 0);
    }
    return map;
  }, [entries, prefsRev]);
  const progressOf = (e: LibraryEntry): number => progressMap.get(e.path) ?? 0;

  const processed = useMemo(() => {
    let list = [...entries];
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((e) => e.title.toLowerCase().includes(q) || e.path.toLowerCase().includes(q));
    }
    if (filter === "reading") {
      list = list.filter((e) => progressOf(e) > 0 && !e.missing);
    } else if (filter === "unread") {
      list = list.filter((e) => progressOf(e) <= 0 && !e.missing);
    } else if (filter === "missing") {
      list = list.filter((e) => e.missing);
    }
    list.sort((a, b) => {
      if (sort === "title") return a.title.localeCompare(b.title, "zh");
      if (sort === "added") return (b.addedAt || "").localeCompare(a.addedAt || "");
      if (sort === "progress") return progressOf(b) - progressOf(a);
      // recent: lastOpenedAt then addedAt
      const ao = a.lastOpenedAt || a.addedAt || "";
      const bo = b.lastOpenedAt || b.addedAt || "";
      return bo.localeCompare(ao);
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, query, filter, sort, progressMap]);

  const hasBooks = entries.length > 0;
  const emptyFiltered = processed.length === 0;

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-3">
      {/* 工具栏：左添加 · 中搜索 · 右排序/过滤/视图 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative shrink-0" ref={addRef}>
          <div className="btn-add-books-group">
            <button
              type="button"
              className="btn-add-books"
              onMouseEnter={showAddTip}
              onMouseLeave={hideAddTip}
              onFocus={showAddTip}
              onBlur={hideAddTip}
              onClick={() => {
                hideAddTip();
                onAddFile();
              }}
            >
              <span aria-hidden="true">＋</span>
              {i18n.libraryAdd}
            </button>
            <button
              type="button"
              className="btn-add-books-caret"
              aria-expanded={addOpen}
              aria-haspopup="menu"
              title={i18n.libraryAddMenu}
              aria-label={i18n.libraryAddMenu}
              onClick={() => {
                setAddOpen((v) => !v);
                setSettingsOpen(false);
              }}
            >
              <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
                <path d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.58l3.3-3.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.42Z" />
              </svg>
            </button>
          </div>
          {addOpen && (
            <div className="absolute left-0 z-40 mt-1.5 min-w-[15rem] overflow-hidden rounded-xl border border-ink-200 bg-white py-1 shadow-panel dark:border-white/[0.08] dark:bg-surface-raised" role="menu">
              <MenuItem
                icon="📄"
                label={i18n.libraryAddFile}
                onClick={() => {
                  setAddOpen(false);
                  onAddFile();
                }}
              />
              <MenuItem
                icon="📁"
                label={i18n.libraryAddFolder}
                onClick={() => {
                  setAddOpen(false);
                  onAddFolder();
                }}
              />
              <MenuItem
                icon="🔄"
                label={scanning ? i18n.libraryScanning : i18n.libraryScan}
                disabled={scanning}
                onClick={() => {
                  setAddOpen(false);
                  onScan();
                }}
              />
              <MenuItem
                icon="👁"
                label={i18n.libraryScanWatch}
                disabled={scanning}
                onClick={() => {
                  setAddOpen(false);
                  onScan({ addToWatch: true });
                }}
              />
              <div className="my-1 border-t border-ink-100 dark:border-white/[0.08]" />
              <MenuItem
                icon="⚙️"
                label={i18n.libraryImportSettings}
                onClick={() => setSettingsOpen((v) => !v)}
              />
              {settingsOpen && (
                <div className="border-t border-ink-100 px-3 py-2 dark:border-white/[0.08]">
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-700 dark:text-fg">
                    <input
                      type="checkbox"
                      checked={importSettings.includeSubfolders}
                      onChange={(e) => patchImport({ includeSubfolders: e.target.checked })}
                    />
                    {i18n.libraryIncludeSubfolders}
                  </label>
                  {importSettings.watchFolders.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-ink-400">
                        {i18n.libraryWatchFolders}
                      </p>
                      {importSettings.watchFolders.map((p) => (
                        <div key={p} className="flex items-center gap-1 text-[11px] text-ink-500">
                          <span className="min-w-0 flex-1 truncate" title={p}>
                            {p}
                          </span>
                          <button
                            type="button"
                            className="shrink-0 text-rose-500 hover:underline"
                            onClick={() =>
                              patchImport({
                                watchFolders: importSettings.watchFolders.filter((x) => x !== p),
                              })
                            }
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>


        <div className="relative mx-auto w-full max-w-[360px] min-w-[12rem] flex-1 sm:flex-none sm:w-[320px]">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" aria-hidden="true">
            ⌕
          </span>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={i18n.librarySearch}
            className="field h-9 w-full pl-8 pr-14 text-sm placeholder:text-ink-400 dark:placeholder:text-fg-muted"
          />
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-ink-200 px-1.5 py-0.5 text-[10px] text-ink-400 dark:border-white/10 dark:text-fg-muted">
            ⌘K
          </span>
        </div>

        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
          {/* 排序：自定义下拉，避免系统 select 蓝框与双箭头 */}
          <div className="relative" ref={sortRef}>
            <button
              type="button"
              className="lib-toolbar-chip"
              title={i18n.librarySort}
              aria-expanded={sortOpen}
              aria-haspopup="listbox"
              onClick={() => setSortOpen((v) => !v)}
            >
              <span className="max-w-[5.5rem] truncate">
                {sort === "recent"
                  ? i18n.librarySortRecent
                  : sort === "added"
                    ? i18n.librarySortAdded
                    : sort === "title"
                      ? i18n.librarySortTitle
                      : i18n.librarySortProgress}
              </span>
              <svg
                viewBox="0 0 20 20"
                className={`h-3.5 w-3.5 shrink-0 text-ink-400 transition ${sortOpen ? "rotate-180" : ""}`}
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.58l3.3-3.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.42Z" />
              </svg>
            </button>
            {sortOpen && (
              <ul className="lib-sort-menu" role="listbox">
                {(
                  [
                    { id: "recent" as const, label: i18n.librarySortRecent },
                    { id: "added" as const, label: i18n.librarySortAdded },
                    { id: "title" as const, label: i18n.librarySortTitle },
                    { id: "progress" as const, label: i18n.librarySortProgress },
                  ] as const
                ).map((opt) => (
                  <li key={opt.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={sort === opt.id}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition ${
                        sort === opt.id
                          ? "bg-ink-100 font-medium text-ink-900 dark:bg-surface-high dark:text-fg"
                          : "text-ink-700 hover:bg-ink-50 dark:text-fg dark:hover:bg-white/[0.06]"
                      }`}
                      onClick={() => {
                        setSort(opt.id);
                        setSortOpen(false);
                      }}
                    >
                      {opt.label}
                      {sort === opt.id && (
                        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 shrink-0 text-accent" fill="currentColor" aria-hidden="true">
                          <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.2 7.2a1 1 0 0 1-1.4 0L3.3 9.1a1 1 0 1 1 1.4-1.4l4.1 4.08 6.5-6.48a1 1 0 0 1 1.4 0Z" />
                        </svg>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 过滤：浅底分段，选中为白片而非纯黑 */}
          <div className="lib-toolbar-seg" role="group" aria-label={i18n.libraryFilterAll}>
            {(
              [
                { id: "all" as const, label: i18n.libraryFilterAll },
                { id: "reading" as const, label: i18n.libraryFilterReading },
                { id: "unread" as const, label: i18n.libraryFilterUnread },
              ] as const
            ).map((f) => (
              <button
                key={f.id}
                type="button"
                className={`lib-toolbar-seg-item ${filter === f.id ? "is-active" : ""}`}
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* 视图：同风格分段，选中不抢眼 */}
          <div className="lib-toolbar-seg" role="group" aria-label={i18n.libraryViewGrid}>
            <button
              type="button"
              className={`lib-toolbar-seg-item lib-toolbar-seg-item-icon ${view === "grid" ? "is-active" : ""}`}
              title={i18n.libraryViewGrid}
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
            >
              <IconGrid />
            </button>
            <button
              type="button"
              className={`lib-toolbar-seg-item lib-toolbar-seg-item-icon ${view === "list" ? "is-active" : ""}`}
              title={i18n.libraryViewList}
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            >
              <IconList />
            </button>
          </div>
        </div>
      </div>

      {/* 扫描 / 导入轻量进度 */}
      {(scanning || importing) && (
        <div className="pointer-events-none fixed bottom-5 right-5 z-50">
          <div className="pointer-events-auto rounded-full border border-ink-200 bg-white/95 px-4 py-2 text-xs font-medium text-ink-800 shadow-panel backdrop-blur dark:border-white/10 dark:bg-surface-raised dark:text-fg">
            {scanning && i18n.libraryScanning}
            {importing &&
              (importProgress
                ? i18n.libraryImportProgress
                    .replace("{done}", String(importProgress.done))
                    .replace("{total}", String(importProgress.total))
                : i18n.libraryImporting)}
          </div>
        </div>
      )}

      {/* 全屏拖拽遮罩 */}
      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center bg-ink-900/40 p-8 backdrop-blur-[2px] dark:bg-black/50">
          <div className="flex min-h-[12rem] w-full max-w-xl flex-col items-center justify-center rounded-3xl border-2 border-dashed border-white/80 bg-white/10 px-8 text-center text-white shadow-lg">
            <p className="text-lg font-semibold">{i18n.libraryDropTitle}</p>
            <p className="mt-2 text-sm text-white/80">{i18n.libraryDropHint}</p>
          </div>
        </div>
      )}

      {emptyFiltered ? (
        <button
          type="button"
          onClick={onAddFile}
          className={`flex min-h-[18rem] flex-1 flex-col items-center justify-center rounded-2xl border border-dashed px-6 text-center transition ${
            dragOver
              ? "border-accent bg-accent/5"
              : "border-ink-300 bg-white shadow-panel hover:border-ink-500 dark:border-white/[0.08] dark:bg-surface-panel dark:shadow-none"
          }`}
        >
          <p className="text-sm font-medium text-ink-900 dark:text-fg">
            {hasBooks ? i18n.libraryNoMatch : i18n.libraryEmpty}
          </p>
          <p className="mt-2 max-w-md text-xs text-ink-500 dark:text-fg-muted">{i18n.libraryHint}</p>
        </button>
      ) : view === "list" ? (
        <ul className="min-h-0 flex-1 space-y-1 overflow-auto pb-4">
          {processed.map((e) => {
            const cover = coverUrl(e.coverPath, e.id);
            const page = progressOf(e);
            return (
              <li key={e.id}>
                <div
                  className={`card flex items-center gap-3 p-2 ${e.missing ? "opacity-70" : ""}`}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    disabled={e.missing}
                    onClick={() => onOpen(e)}
                  >
                    <div className="cover-frame h-14 w-10 shrink-0 overflow-hidden rounded-md">
                      {cover ? (
                        <img
                          src={cover}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover"
                          onError={(ev) => {
                            (ev.target as HTMLImageElement).style.display = "none";
                          }}
                        />
                      ) : (
                        <div className="grid h-full place-items-center text-[9px] text-ink-400">{kindLabel(e.kind)}</div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink-900 dark:text-fg">{e.title}</p>
                      <p className="truncate text-[11px] text-ink-500 dark:text-fg-muted">
                        {kindLabel(e.kind)}
                        {e.pageCount > 0 ? ` · ${e.pageCount} ${i18n.libraryPages}` : ""}
                        {page > 0 ? ` · ${page + 1}` : ""}
                        {e.missing ? ` · ${i18n.libraryMissing}` : ""}
                      </p>
                    </div>
                  </button>
                  <button type="button" className="btn-card-enhance !opacity-100" disabled={e.missing} onClick={() => onEnhance(e)}>
                    {i18n.libraryEnhance}
                  </button>
                  <button
                    type="button"
                    className="btn-card-remove !opacity-100"
                    title={i18n.libraryRemoveHint}
                    aria-label={i18n.libraryRemove}
                    onClick={() => onRemove(e)}
                  >
                    <TrashIcon />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="grid grid-cols-3 gap-3 overflow-auto pb-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
          {processed.map((e) => {
            const cover = coverUrl(e.coverPath, e.id);
            const page = progressOf(e);
            return (
              <li key={e.id}>
                <article className={`card group relative overflow-hidden ${e.missing ? "opacity-70" : ""}`}>
                  <button
                    type="button"
                    className="block w-full text-left"
                    disabled={e.missing}
                    onClick={() => onOpen(e)}
                  >
                    <div className="cover-frame aspect-[2/3]">
                      {cover ? (
                        <img
                          src={cover}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="h-full w-full object-cover"
                          onError={(ev) => {
                            const el = ev.target as HTMLImageElement;
                            el.style.display = "none";
                          }}
                        />
                      ) : (
                        <div className="grid h-full place-items-center text-[10px] text-ink-400">{kindLabel(e.kind)}</div>
                      )}
                      <div className="cover-scrim">
                        <p className="truncate text-[11px] font-medium leading-tight text-ink-900 dark:text-fg" title={e.path}>
                          {e.title}
                        </p>
                        <p className="truncate text-[9px] leading-tight text-ink-500 dark:text-fg-muted">
                          {kindLabel(e.kind)}
                          {e.pageCount > 0 ? ` · ${e.pageCount} ${i18n.libraryPages}` : ""}
                          {page > 0 ? ` · ${page + 1}` : ""}
                          {e.missing ? ` · ${i18n.libraryMissing}` : ""}
                        </p>
                      </div>
                    </div>
                  </button>
                  <div className="card-action-scrim" aria-hidden="true" />
                  <div className="card-action-bar">
                    <button
                      type="button"
                      className="btn-card-enhance"
                      disabled={e.missing}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onEnhance(e);
                      }}
                    >
                      {i18n.libraryEnhance}
                    </button>
                    <button
                      type="button"
                      className="btn-card-remove"
                      title={i18n.libraryRemoveHint}
                      aria-label={i18n.libraryRemove}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onRemove(e);
                      }}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </article>
              </li>
            );
          })}
        </ul>
      )}

      {scanPreview && (
        <ScanPicker
          preview={scanPreview}
          importing={importing}
          i18n={i18n}
          includeSubfolders={importSettings.includeSubfolders}
          onConfirm={onConfirmScan}
          onCancel={onCancelScan}
        />
      )}
      {addTip && (
        <div
          className="reader-tip library-tip"
          role="tooltip"
          style={{ left: addTip.x, top: addTip.y }}
        >
          {addTip.text}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink-800 hover:bg-ink-50 disabled:opacity-40 dark:text-fg dark:hover:bg-white/[0.06]"
      onClick={onClick}
    >
      <span className="w-5 text-center" aria-hidden="true">
        {icon}
      </span>
      {label}
    </button>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M7.5 4.5V3.75A1.25 1.25 0 0 1 8.75 2.5h2.5a1.25 1.25 0 0 1 1.25 1.25V4.5m-7.5 0h11m-9.5 0 .6 10.2a1.25 1.25 0 0 0 1.25 1.17h4.3a1.25 1.25 0 0 0 1.25-1.17L13.75 4.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconGrid() {
  return (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
      <rect x="3.5" y="3.5" width="5" height="5" rx="1" />
      <rect x="11.5" y="3.5" width="5" height="5" rx="1" />
      <rect x="3.5" y="11.5" width="5" height="5" rx="1" />
      <rect x="11.5" y="11.5" width="5" height="5" rx="1" />
    </svg>
  );
}

function IconList() {
  return (
    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
      <path d="M4 5.5h12M4 10h12M4 14.5h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ScanPicker({
  preview,
  importing,
  i18n,
  includeSubfolders,
  onConfirm,
  onCancel,
}: {
  preview: LibraryScanPreview;
  importing: boolean;
  i18n: Messages;
  includeSubfolders: boolean;
  onConfirm: (paths: string[]) => void;
  onCancel: () => void;
}) {
  const candidates = useMemo(() => {
    if (includeSubfolders) return preview.candidates;
    const root = preview.root.replace(/\\/g, "/").replace(/\/+$/, "");
    return preview.candidates.filter((c) => {
      const p = c.path.replace(/\\/g, "/");
      const rel = p.startsWith(root + "/") ? p.slice(root.length + 1) : p;
      // 仅一层：无额外 /
      return !rel.includes("/");
    });
  }, [preview, includeSubfolders]);

  const fresh = candidates.filter((c) => !c.alreadyInLibrary);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());

  const toggle = (path: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/50" aria-label={i18n.libraryScanCancel} onClick={onCancel} />
      <div className="relative flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border border-ink-200 bg-white shadow-panel dark:border-white/[0.08] dark:bg-surface-raised">
        <div className="border-b border-ink-100 px-4 py-3 dark:border-white/[0.08]">
          <p className="text-sm font-medium text-ink-900 dark:text-fg">{i18n.libraryScanTitle}</p>
          <p className="mt-0.5 truncate text-[11px] text-ink-500" title={preview.root}>
            {preview.root}
            {!includeSubfolders ? ` · ${i18n.libraryTopLevelOnly}` : ""}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
          {candidates.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-ink-500">{i18n.libraryScanNone}</p>
          )}
          {candidates.map((c) => (
            <label
              key={c.path}
              className={`flex cursor-pointer items-start gap-2 rounded-xl px-2 py-2 text-sm ${
                c.alreadyInLibrary ? "opacity-50" : "hover:bg-ink-50 dark:hover:bg-surface-raised"
              }`}
            >
              <input
                type="checkbox"
                className="mt-1"
                disabled={c.alreadyInLibrary}
                checked={c.alreadyInLibrary || picked.has(c.path)}
                onChange={() => {
                  if (!c.alreadyInLibrary) toggle(c.path);
                }}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink-900 dark:text-fg">{c.title}</span>
                <span className="block truncate text-[11px] text-ink-500">{c.path}</span>
              </span>
              <span className="shrink-0 text-[11px] text-ink-400">
                {c.alreadyInLibrary ? i18n.libraryAlready : c.kind.toUpperCase()}
              </span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 px-4 py-3 dark:border-white/[0.08]">
          <button
            type="button"
            className="btn-ghost !h-8 !px-2.5 text-xs"
            disabled={fresh.length === 0}
            onClick={() => setPicked(new Set(fresh.map((c) => c.path)))}
          >
            {i18n.librarySelectAll}
          </button>
          <button type="button" className="btn-ghost !h-8 !px-2.5 text-xs" onClick={() => setPicked(new Set())}>
            {i18n.librarySelectNone}
          </button>
          <div className="ml-auto flex gap-2">
            <button type="button" className="btn-ghost !h-8 !px-3 text-xs" onClick={onCancel}>
              {i18n.libraryScanCancel}
            </button>
            <button
              type="button"
              className="btn-primary !h-8 !px-3 text-xs"
              disabled={importing || picked.size === 0}
              onClick={() => onConfirm([...picked])}
            >
              {importing ? i18n.libraryScanning : `${i18n.libraryImportSelected} (${picked.size})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** memo：App 侧回调保持引用稳定时，轮询刷新不再导致整屏书库重渲染 */
const LibraryViewMemo = memo(LibraryView);
export { LibraryViewMemo as LibraryView };

export async function pickComicFile(): Promise<string | null> {
  const files = await pickComicFiles();
  return files[0] ?? null;
}

export async function pickComicFiles(): Promise<string[]> {
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [comicFileFilter("Comic / Ebook")],
  });
  if (Array.isArray(selected)) return selected.filter((p): p is string => typeof p === "string");
  if (typeof selected === "string") return [selected];
  return [];
}

export async function pickFolder(): Promise<string | null> {
  const selected = await open({ multiple: false, directory: true });
  return typeof selected === "string" ? selected : null;
}
