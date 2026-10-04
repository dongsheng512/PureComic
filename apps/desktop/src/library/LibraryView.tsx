import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { comicFileFilter } from "../formats";
import type { Messages } from "../i18n";
import type { LibraryCollection, LibraryEntry, LibraryScanPreview } from "../types";
import { buildShelf, continueVolume, coverVolume } from "./collections";
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
  collections: LibraryCollection[];
  onCreateCollection: (title: string, entryIds: string[]) => Promise<unknown>;
  onAddToCollection: (id: string, entryIds: string[]) => Promise<unknown>;
  onRemoveFromCollection: (id: string, entryId: string) => Promise<unknown>;
  onMoveInCollection: (id: string, entryId: string, delta: number) => Promise<unknown>;
  onRenameCollection: (id: string, title: string) => Promise<unknown>;
  onDissolveCollection: (id: string) => Promise<unknown>;
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
    const bust = cacheKey
      ? encodeURIComponent(cacheKey)
      : encodeURIComponent(path);
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

/**
 * 标题清洗：「[谷围南亭]001-005」→ 主标题「谷围南亭 001-005」。
 * 只剥离首个成对括号组并拼接余部；无括号则原样返回。
 */
function splitTitle(title: string): string {
  const m = title.trim().match(/^\s*[[【(（]\s*([^\]】)）]*)\s*[\]】)）]\s*(.*)$/);
  if (m && m[1].trim()) {
    const rest = m[2].trim();
    return rest ? `${m[1].trim()} ${rest}` : m[1].trim();
  }
  return title.trim();
}

/** 已增强：有导出产物，或增强状态非初始值 */
function isEnhanced(e: LibraryEntry): boolean {
  return Boolean(e.outputPath) || !["", "none"].includes(e.enhanceState || "");
}

function LibraryView({
  entries,
  collections,
  onCreateCollection,
  onAddToCollection,
  onRemoveFromCollection,
  onMoveInCollection,
  onRenameCollection,
  onDissolveCollection,
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

  const [sheetId, setSheetId] = useState<string | null>(null);
  const [menuEntryId, setMenuEntryId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  /* Esc 关闭顺序：菜单类最浅、弹窗类在其上（menuEntryId 挂在合集卡上，
     sheetId 打开的是合集详情）。一次只关最上面一层，与阅读器的 Esc 语义一致。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menuEntryId) {
        e.preventDefault();
        setMenuEntryId(null);
        return;
      }
      if (sheetId) {
        e.preventDefault();
        setSheetId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuEntryId, sheetId]);
  const shelf = useMemo(
    () =>
      buildShelf({
        entries,
        collections,
        query,
        filter,
        sort,
        progressOf,
      }),
    // progressOf closes over progressMap
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, collections, query, filter, sort, progressMap],
  );

  const hasBooks = entries.length > 0;
  const emptyFiltered = shelf.length === 0;
  const openCollection = collections.find((c) => c.id === sheetId) ?? null;
  const openVolumes = openCollection
    ? openCollection.entryIds
        .map((id) => entries.find((e) => e.id === id))
        .filter((e): e is LibraryEntry => Boolean(e))
    : [];
  const resume = continueVolume(openVolumes);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* 与顶栏同一页眉：左添加 · 中搜索 · 右排序/过滤/视图 */}
      <div className="app-page-toolbar flex items-center gap-2 pb-3 pt-2">
        <div className="relative shrink-0" ref={addRef}>
          <div className="btn-add-books-group">
            <button
              type="button"
              className="btn-add-books"
              aria-describedby={addTip ? "library-add-tip" : undefined}
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
            <div className="absolute left-0 z-40 mt-1.5 min-w-[15rem] overflow-hidden rounded-xl border border-ink-200 bg-white py-1 shadow-panel dark:border-white/10 dark:bg-surface-raised" role="menu">
              <MenuItem
                icon={<IconFile />}
                label={i18n.libraryAddFile}
                onClick={() => {
                  setAddOpen(false);
                  onAddFile();
                }}
              />
              <MenuItem
                icon={<IconFolder />}
                label={i18n.libraryAddFolder}
                onClick={() => {
                  setAddOpen(false);
                  onAddFolder();
                }}
              />
              <MenuItem
                icon={<IconScan />}
                label={scanning ? i18n.libraryScanning : i18n.libraryScan}
                disabled={scanning}
                onClick={() => {
                  setAddOpen(false);
                  onScan();
                }}
              />
              <MenuItem
                icon={<IconWatch />}
                label={i18n.libraryScanWatch}
                disabled={scanning}
                onClick={() => {
                  setAddOpen(false);
                  onScan({ addToWatch: true });
                }}
              />
              <div className="my-1 border-t border-ink-100 dark:border-white/10" />
              <MenuItem
                icon={<IconGear />}
                label={i18n.libraryImportSettings}
                onClick={() => setSettingsOpen((v) => !v)}
              />
              {settingsOpen && (
                <div className="border-t border-ink-100 px-3 py-2 dark:border-white/10">
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


        {hasBooks && (
          <>
            <div className="relative min-w-0 max-w-[360px] flex-1">
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

            <div className="hidden h-6 w-px shrink-0 bg-ink-200 sm:block dark:bg-white/10" aria-hidden="true" />
            <div className="ml-auto flex min-w-0 items-center gap-2">
          {/* 排序：自定义下拉，避免系统 select 蓝框与双箭头 */}
          <div className="relative shrink-0" ref={sortRef}>
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
          <div className="lib-toolbar-seg min-w-0 overflow-x-auto" role="group" aria-label={i18n.libraryFilterAll}>
            {(
              [
                { id: "all" as const, label: i18n.libraryFilterAll },
                { id: "reading" as const, label: i18n.libraryFilterReading },
                { id: "unread" as const, label: i18n.libraryFilterUnread },
                { id: "finished" as const, label: i18n.libraryFinished },
                /* 丢失：文件失效的书只能靠 opacity-70 混在列表里找，
                   prefs/collections 的数据层本来就支持 "missing"（keep() 有分支）。 */
                { id: "missing" as const, label: i18n.libraryFilterMissing },
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
          <div className="lib-toolbar-seg shrink-0" role="group" aria-label={i18n.libraryViewGrid}>
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
          </>
        )}
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
        hasBooks ? (
          /* 有书但被搜索/筛掉：**不能**复用"整块 = 添加文件按钮"的空态。
             旧写法把「没有符合条件的书籍」做成 onAddFile 大按钮，用户想清
             筛选时点下去却弹文件选择器；界面上也没有任何清除筛选的入口。 */
          <div className="mt-3 flex min-h-[18rem] flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-ink-300 px-6 text-center dark:border-white/10">
            <p className="text-sm font-medium text-ink-900 dark:text-fg">{i18n.libraryNoMatch}</p>
            <p className="mt-2 max-w-md text-xs text-ink-500 dark:text-fg-muted">{i18n.libraryHint}</p>
            <button
              type="button"
              className="btn-soft mt-4 px-3 py-1.5 text-xs"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
            >
              {i18n.libraryClearFilters}
            </button>
          </div>
        ) : (
          /* 空库引导：一个入口不够用——文件夹/扫描才是批量导入的主路径；
             工具栏此时隐藏（搜索/筛选没有可作用的对象），引导集中在这里。 */
          <div
            className={`mt-3 flex min-h-[18rem] flex-1 flex-col items-center justify-center rounded-2xl border border-dashed px-6 text-center transition ${
              dragOver
                ? "border-accent bg-accent/5"
                : "border-ink-300 bg-white shadow-panel hover:border-ink-500 dark:border-white/10 dark:bg-surface-panel dark:shadow-none"
            }`}
          >
            <p className="text-sm font-medium text-ink-900 dark:text-fg">{i18n.libraryEmpty}</p>
            <p className="mt-2 max-w-md text-xs text-ink-500 dark:text-fg-muted">{i18n.libraryHint}</p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <button type="button" className="btn-primary px-3.5 py-1.5 text-xs" onClick={onAddFile}>
                {i18n.libraryAdd}
              </button>
              <button type="button" className="btn-soft px-3.5 py-1.5 text-xs" onClick={onAddFolder}>
                {i18n.libraryAddFolder}
              </button>
              <button type="button" className="btn-soft px-3.5 py-1.5 text-xs" onClick={() => onScan()}>
                {i18n.libraryScan}
              </button>
            </div>
          </div>
        )
      ) : view === "list" ? (
        <ul className="lib-scroll mt-3 min-h-0 flex-1 space-y-1 pb-4">
          {shelf.map((item) => {
            if (item.kind === "collection") {
              const coverEntry = coverVolume(item);
              const cover = coverUrl(
                coverEntry?.coverPath,
                `${item.collection.id}:${item.volumes.length}`,
              );
              const next = continueVolume(item.volumes);
              return (
                <li key={item.collection.id}>
                  <button
                    type="button"
                    className="card flex w-full items-center gap-3 p-2 text-left"
                    onClick={() => setSheetId(item.collection.id)}
                  >
                    <div className="cover-frame h-14 w-10 shrink-0 overflow-hidden rounded-md">
                      {cover ? (
                        <img src={cover} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="grid h-full place-items-center text-[9px] text-ink-400">
                          {i18n.libraryCollection}
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{item.collection.title}</p>
                      <p className="truncate text-[11px] text-ink-500">
                        {i18n.libraryCollectionVolumes.replace("{count}", String(item.volumes.length))}
                        {next ? ` · ${splitTitle(next.title)}` : ""}
                      </p>
                    </div>
                  </button>
                </li>
              );
            }
            const e = item.entry;
            const cover = coverUrl(e.coverPath, `${e.id}:${e.pageCount}:${e.coverPath ?? ""}`);
            const page = progressOf(e);
            return (
              <li key={e.id}>
                <div
                  /* group：card-action-bar 的 hover 浮出依赖 `.group:hover`（与网格卡片一致） */
                  className={`card group relative flex items-center gap-3 p-2 ${e.missing ? "opacity-70" : ""}`}
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
                      <p className="truncate text-sm font-medium text-ink-900 dark:text-fg" title={e.title}>
                        {splitTitle(e.title)}
                      </p>
                      <p className="truncate text-[11px] text-ink-500 dark:text-fg-muted">
                        <span className="lib-badge">{kindLabel(e.kind)}</span>
                        {isEnhanced(e) && <span className="lib-badge lib-badge-enhanced">{i18n.libraryEnhancedBadge}</span>}
                        {e.pageCount > 0 ? ` · ${e.pageCount} ${i18n.libraryPages}` : ""}
                        {page > 0 ? ` · ${page + 1}/${e.pageCount || "?"}` : ""}
                        {e.missing ? ` · ${i18n.libraryMissing}` : ""}
                      </p>
                      {page > 0 && !e.missing && e.pageCount > 0 && (
                        <ProgressBar value={page} total={e.pageCount} />
                      )}
                    </div>
                  </button>
                  {/* 悬浮操作：与网格卡片同一套 hover 浮出（card-action-bar），不再常驻。
                      常驻三个胶囊既吵又挤压标题宽度，且「合集」文案语义不明（实际是加入）。 */}
                  <div className="card-action-bar relative left-0 top-0">
                    <button
                      type="button"
                      className="btn-card-enhance"
                      title={i18n.libraryCollectionAddMenu}
                      onClick={() => {
                        setDraftName("");
                        setMenuEntryId((id) => (id === e.id ? null : e.id));
                      }}
                    >
                      {i18n.libraryCollectionAddTo}
                    </button>
                    <button
                      type="button"
                      className="btn-card-enhance"
                      title={i18n.libraryEnhance}
                      disabled={e.missing}
                      onClick={() => onEnhance(e)}
                    >
                      {i18n.libraryEnhance}
                    </button>
                    <button
                      type="button"
                      className="btn-card-remove"
                      title={i18n.libraryRemoveHint}
                      aria-label={i18n.libraryRemove}
                      onClick={() => onRemove(e)}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <ul className="lib-scroll mt-3 grid min-h-0 flex-1 grid-cols-3 gap-3 pb-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
          {shelf.map((item) => {
            if (item.kind === "collection") {
              const coverEntry = coverVolume(item);
              const cover = coverUrl(
                coverEntry?.coverPath,
                `${item.collection.id}:${coverEntry?.pageCount ?? 0}:${coverEntry?.coverPath ?? ""}`,
              );
              const next = continueVolume(item.volumes);
              const page = next ? progressOf(next) : 0;
              return (
                <li key={item.collection.id}>
                  <article className="card group relative overflow-hidden">
                    <button
                      type="button"
                      className="block w-full text-left"
                      onClick={() => setSheetId(item.collection.id)}
                    >
                      <div className="cover-frame aspect-[2/3]">
                        {cover ? (
                          <img src={cover} alt="" loading="lazy" className="h-full w-full object-cover" />
                        ) : (
                          <div className="grid h-full place-items-center text-[10px] text-ink-400">
                            {i18n.libraryCollection}
                          </div>
                        )}
                        <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[10px] text-white">
                          {i18n.libraryCollectionVolumes.replace("{count}", String(item.volumes.length))}
                        </span>
                        <div className="cover-scrim">
                          <p className="truncate text-[11px] font-medium leading-tight">{item.collection.title}</p>
                          <p className="truncate text-[9px] text-ink-500">
                            {next
                              ? `${splitTitle(next.title)}${page > 0 ? ` · ${page + 1}/${next.pageCount || "?"}` : ""}`
                              : i18n.libraryCollection}
                          </p>
                        </div>
                      </div>
                    </button>
                  </article>
                </li>
              );
            }
            const e = item.entry;
            const cover = coverUrl(e.coverPath, `${e.id}:${e.pageCount}:${e.coverPath ?? ""}`);
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
                        <p className="truncate text-[9px] leading-tight text-ink-500 dark:text-fg-muted">
                          <span className="lib-badge">{kindLabel(e.kind)}</span>
                          {isEnhanced(e) && <span className="lib-badge lib-badge-enhanced">{i18n.libraryEnhancedBadge}</span>}
                          {e.missing ? ` · ${i18n.libraryMissing}` : ""}
                        </p>
                      </div>
                    </div>
                  </button>
                  {/* 标题/进度移出遮罩：封面窄时遮罩文字会截断到不可读，
                      固定在封面下方不受图片密度影响 */}
                  <div className="px-1.5 pb-2 pt-1.5">
                    <p className="truncate text-[11px] font-medium leading-tight text-ink-900 dark:text-fg" title={e.title}>
                      {splitTitle(e.title)}
                    </p>
                    <p className="truncate text-[9px] leading-tight text-ink-500 dark:text-fg-muted">
                      {e.pageCount > 0 ? `${e.pageCount} ${i18n.libraryPages}` : ""}
                      {page > 0 ? ` · ${page + 1}/${e.pageCount || "?"}` : ""}
                    </p>
                    {page > 0 && !e.missing && e.pageCount > 0 && (
                      <ProgressBar value={page} total={e.pageCount} />
                    )}
                  </div>
                  {/* 悬浮操作：左上角黑玻璃组，hover 展开 */}
                  <div className="card-action-bar">
                    <button
                      type="button"
                      className="btn-card-enhance"
                      title={i18n.libraryCollection}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setDraftName("");
                        setMenuEntryId((id) => (id === e.id ? null : e.id));
                      }}
                    >
                      {i18n.libraryCollection}
                    </button>
                    <button
                      type="button"
                      className="btn-card-enhance"
                      title={i18n.libraryEnhance}
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

      {menuEntryId && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4"
          onClick={() => setMenuEntryId(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-4 shadow-panel dark:bg-surface-panel"
            onClick={(ev) => ev.stopPropagation()}
          >
            <form
              className="flex gap-2"
              onSubmit={(ev) => {
                ev.preventDefault();
                const title = draftName.trim();
                if (!title) return;
                void onCreateCollection(title, [menuEntryId]);
                setMenuEntryId(null);
              }}
            >
              <input
                value={draftName}
                onChange={(ev) => setDraftName(ev.target.value)}
                placeholder={i18n.libraryCollectionName}
                className="min-w-0 flex-1 rounded-lg border border-ink-200 px-2 py-1.5 text-sm dark:border-white/10 dark:bg-transparent"
                autoFocus
              />
              <button type="submit" className="btn-primary px-3 py-1.5 text-sm">
                {i18n.libraryCollectionNew}
              </button>
            </form>
            <div className="mt-3 max-h-48 space-y-1 overflow-auto">
              {collections.length === 0 && (
                <p className="text-xs text-ink-500">{i18n.libraryCollectionEmpty}</p>
              )}
              {collections.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="block w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-ink-50 dark:hover:bg-white/5"
                  onClick={() => {
                    void onAddToCollection(c.id, [menuEntryId]);
                    setMenuEntryId(null);
                  }}
                >
                  {i18n.libraryCollectionAdd} · {c.title}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {openCollection && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4"
          onClick={() => setSheetId(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-4 shadow-panel dark:bg-surface-panel"
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <input
                defaultValue={openCollection.title}
                key={openCollection.id}
                className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 -mx-1.5 text-base font-medium outline-none transition hover:border-ink-200 hover:bg-ink-50 focus:border-accent focus:bg-white dark:hover:border-white/10 dark:hover:bg-surface-high dark:focus:bg-surface-raised"
                aria-label={i18n.libraryCollectionRename}
                /* Enter 直接提交：只挂 onBlur 时，输入框内按 Enter 什么都不发生
                   （输入框不会因此失焦），用户只能去点别处才能保存。 */
                onKeyDown={(ev) => {
                  if (ev.key === "Enter") {
                    ev.preventDefault();
                    ev.currentTarget.blur();
                  }
                }}
                onBlur={(ev) => {
                  const title = ev.target.value.trim();
                  if (title && title !== openCollection.title) {
                    void onRenameCollection(openCollection.id, title);
                  }
                }}
              />
              <button type="button" className="text-sm text-ink-500" onClick={() => setSheetId(null)}>
                {i18n.dismiss}
              </button>
            </div>
            {resume && !resume.missing && (
              <button
                type="button"
                className="btn-primary mt-3 w-full py-2 text-sm"
                onClick={() => {
                  setSheetId(null);
                  onOpen(resume);
                }}
              >
                {i18n.libraryCollectionContinue} · {splitTitle(resume.title)}
              </button>
            )}
            <ul className="mt-3 max-h-80 space-y-1 overflow-auto">
              {openVolumes.map((volume, index) => (
                <li key={volume.id} className="flex items-center gap-2 rounded-lg px-1 py-1">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{splitTitle(volume.title)}</p>
                    <p className="text-[11px] text-ink-500">
                      {progressOf(volume) > 0
                        ? `${progressOf(volume) + 1}/${volume.pageCount || "?"}`
                        : `${volume.pageCount || "?"} ${i18n.libraryPages}`}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="text-xs"
                    disabled={volume.missing}
                    onClick={() => {
                      setSheetId(null);
                      onOpen(volume);
                    }}
                  >
                    {i18n.libraryCollectionOpen}
                  </button>
                  <details className="relative">
                    <summary
                      className="grid h-6 w-6 cursor-pointer list-none place-items-center rounded-md text-sm leading-none text-ink-500 hover:bg-ink-100 hover:text-ink-900 dark:text-fg-muted dark:hover:bg-surface-high dark:hover:text-fg"
                      title={i18n.libraryVolumeActions}
                      aria-label={`${splitTitle(volume.title)} · ${i18n.libraryVolumeActions}`}
                    >
                      ⋯
                    </summary>
                    <div className="absolute right-0 top-full z-20 mt-1 flex min-w-36 flex-col rounded-lg border border-ink-200 bg-white p-1 shadow-panel dark:border-white/10 dark:bg-surface-raised">
                      <button
                        type="button"
                        className="rounded-md px-2.5 py-1.5 text-left text-xs text-ink-700 hover:bg-ink-100 dark:text-fg dark:hover:bg-surface-high"
                        disabled={index === 0}
                        onClick={() => void onMoveInCollection(openCollection.id, volume.id, -1)}
                      >
                        ↑ {i18n.libraryCollectionMoveUp}
                      </button>
                      <button
                        type="button"
                        className="rounded-md px-2.5 py-1.5 text-left text-xs text-ink-700 hover:bg-ink-100 dark:text-fg dark:hover:bg-surface-high"
                        disabled={index === openVolumes.length - 1}
                        onClick={() => void onMoveInCollection(openCollection.id, volume.id, 1)}
                      >
                        ↓ {i18n.libraryCollectionMoveDown}
                      </button>
                      <button
                        type="button"
                        className="rounded-md px-2.5 py-1.5 text-left text-xs text-ink-700 hover:bg-ink-100 disabled:opacity-40 dark:text-fg dark:hover:bg-surface-high"
                        disabled={volume.missing}
                        onClick={() => {
                          setSheetId(null);
                          onEnhance(volume);
                        }}
                      >
                        {i18n.libraryEnhance}
                      </button>
                      <button
                        type="button"
                        className="rounded-md px-2.5 py-1.5 text-left text-xs text-rose-700 hover:bg-rose-500/10 dark:text-danger-fg"
                        onClick={() => void onRemoveFromCollection(openCollection.id, volume.id)}
                      >
                        {i18n.libraryCollectionRemoveVolume}
                      </button>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex justify-end border-t border-ink-100 pt-2.5 dark:border-white/10">
              <button
                type="button"
                className="text-xs text-rose-700 hover:text-rose-800 dark:text-danger-fg"
                onClick={() => {
                  void onDissolveCollection(openCollection.id);
                  setSheetId(null);
                }}
              >
                {i18n.libraryCollectionDissolve}
              </button>
            </div>
          </div>
        </div>
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
          id="library-add-tip"
          role="tooltip"
          style={{ left: addTip.x, top: addTip.y }}
        >
          {addTip.text}
        </div>
      )}
    </div>
  );
}

/** 细进度条：value 为 0 基已读页 */
function ProgressBar({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.max(0, Math.round(((value + 1) / total) * 100))) : 0;
  return (
    <div className="lib-progress" aria-hidden="true">
      <div className="lib-progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
}: {
  /* 与全局图标语言一致的单色 SVG（16px 视框），替代 emoji：彩色、跨平台渲染
     不一致，且与应用其它工具栏图标风格脱节。 */
  icon: ReactNode;
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
      <span className="flex h-4 w-4 items-center justify-center text-ink-400" aria-hidden="true">
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

/* 「添加」菜单的四个动作图标：单色 1.5 线宽，与顶栏/工具栏图标语言一致 */
function IconFile() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden="true">
      <path
        d="M6 2.5h5l4 4v9.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 5 16V4a1.5 1.5 0 0 1 1-1.42Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M11 2.5V7h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function IconFolder() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden="true">
      <path
        d="M2.5 5A1.5 1.5 0 0 1 4 3.5h3.6l2 2.5H16A1.5 1.5 0 0 1 17.5 7.5V15A1.5 1.5 0 0 1 16 16.5H4A1.5 1.5 0 0 1 2.5 15V5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconScan() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden="true">
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8m4 0h2.5A1.5 1.5 0 0 1 16 5.5V8m0 4v2.5a1.5 1.5 0 0 1-1.5 1.5H12M8 16H5.5A1.5 1.5 0 0 1 4 14.5V12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3.5 10h13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconWatch() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden="true">
      <path d="M2.5 10S5 5.5 10 5.5 17.5 10 17.5 10 15 14.5 10 14.5 2.5 10 2.5 10Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="10" cy="10" r="2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="2.4" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 3v1.6M10 15.4V17M4.1 6.5l1.4.8m8.9-.8-1.4.8M4.1 13.5l1.4-.8m8.9.8 1.4-.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

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
      <div className="relative flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border border-ink-200 bg-white shadow-panel dark:border-white/10 dark:bg-surface-raised">
        <div className="border-b border-ink-100 px-4 py-3 dark:border-white/10">
          <p className="text-sm font-medium text-ink-900 dark:text-fg">{i18n.libraryScanTitle}</p>
          <p className="mt-0.5 truncate text-[11px] text-ink-500" title={preview.root}>
            {preview.root}
            {!includeSubfolders ? ` · ${i18n.libraryTopLevelOnly}` : ""}
          </p>
          {candidates.some((c) => c.alreadyInLibrary) && (
            <p className="mt-1 text-[11px] text-ink-400">{i18n.libraryAlreadyHint}</p>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
          {candidates.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-ink-500">{i18n.libraryScanNone}</p>
          )}
          {candidates.map((c) => (
            <label
              key={c.path}
              className="flex cursor-pointer items-start gap-2 rounded-xl px-2 py-2 text-sm hover:bg-ink-50 dark:hover:bg-surface-raised"
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={picked.has(c.path)}
                onChange={() => toggle(c.path)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink-900 dark:text-fg">{c.title}</span>
                <span className="block truncate text-[11px] text-ink-500">{c.path}</span>
              </span>
              <span
                className="shrink-0 text-[11px] text-ink-400"
                title={c.alreadyInLibrary ? i18n.libraryAlreadyHint : undefined}
              >
                {c.alreadyInLibrary ? i18n.libraryAlready : c.kind.toUpperCase()}
              </span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 px-4 py-3 dark:border-white/10">
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
              {importing ? i18n.libraryImporting : `${i18n.libraryImportSelected} (${picked.size})`}
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
