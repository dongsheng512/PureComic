import { useEffect, useState } from "react";
import { formatBytes } from "../enhance/enhanceViewModel";
import { t } from "../i18n";
import type {
  BookCacheEntry,
  CacheEntry,
  CacheGroupId,
  CacheGroupStats,
  CacheOverview,
} from "../types";
import { PanelCloseButton, PanelFeedback } from "./Drawer";

type Props = {
  i18n: ReturnType<typeof t>;
  errorMessage: string | null;
  onDismissError: () => void;
  overview: CacheOverview | null;
  scanning: boolean;
  /** 正在清理的组 id；"all" = 全部清理进行中 */
  busyId: CacheGroupId | "all" | null;
  /** 上一次清理实际回收的字节数 */
  lastFreed: number | null;

  /** 当前看的是哪个轴；两个视图共用同一个列表区，由顶部的切换控件决定 */
  view: CacheView;
  onChangeView: (v: CacheView) => void;

  // ---- 按漫画 ----
  /** 一行 = 一本漫画占用的全部缓存；null = 还没加载出来 */
  bookEntries: BookCacheEntry[] | null;
  booksLoading: boolean;
  /** 正在整本清理的那一行；null = 没有 */
  busyBookKey: string | null;
  /** 当前展开的那本漫画（同时只展开一行，侧边栏很窄） */
  expandedBookKey: string | null;
  onToggleBook: (key: string) => void;
  onClearBook: (row: BookCacheEntry) => void;

  // ---- 按存储类型 ----
  /** 展开的分组（同时只展开一个） */
  expandedId: CacheGroupId | null;
  /** 展开分组的明细；null = 还没加载出来 */
  entries: CacheEntry[] | null;
  entriesLoading: boolean;
  /** 正在单清的行（`${group}:${key}` 复合键集合）；空集 = 没有 */
  busyEntryKeys: Set<string>;
  onClear: (id: CacheGroupId) => void;
  onToggleGroup: (id: CacheGroupId) => void;
  onClearEntry: (id: CacheGroupId, key: string) => void;

  onRefresh: () => void;
  onClearAll: () => void;
  onClose: () => void;
};

/** 缓存页的两个轴。两边的取数是同一份磁盘事实（见后端 `collect_one_group`），只是呈现方式不同。 */
export type CacheView = "book" | "type";
type CacheSort = "size" | "reclaimable" | "recent";
type CacheFilter = "all" | "reclaimable" | "missing";

/** 穷举 switch 而非 `i18n[key]` —— 让 TS 在新增缓存组时直接报错漏配文案。 */
function groupLabel(i18n: ReturnType<typeof t>, id: CacheGroupId): string {
  switch (id) {
    case "mobi":
      return i18n.cacheGroupMobi;
    case "reader":
      return i18n.cacheGroupReader;
    case "readerEnhance":
      return i18n.cacheGroupReaderEnhance;
    case "covers":
      return i18n.cacheGroupCovers;
    case "jobs":
      return i18n.cacheGroupJobs;
  }
}

function groupHint(i18n: ReturnType<typeof t>, id: CacheGroupId): string {
  switch (id) {
    case "mobi":
      return i18n.cacheHintMobi;
    case "reader":
      return i18n.cacheHintReader;
    case "readerEnhance":
      return i18n.cacheHintReaderEnhance;
    case "covers":
      return i18n.cacheHintCovers;
    case "jobs":
      return i18n.cacheHintJobs;
  }
}

function groupUnit(i18n: ReturnType<typeof t>, id: CacheGroupId): string {
  switch (id) {
    case "mobi":
    case "reader":
      return i18n.cacheUnitBook;
    case "readerEnhance":
    case "covers":
      return i18n.cacheUnitFile;
    case "jobs":
      return i18n.cacheUnitJob;
  }
}

function clearTitle(
  i18n: ReturnType<typeof t>,
  g: CacheGroupStats,
): string | undefined {
  if (g.busy) return i18n.cacheBusy;
  if (g.reclaimBytes === 0) return i18n.cacheNothingToClear;
  return undefined;
}

/** 绝对日期，不做"几天前"—— 相对时间要额外的 i18n 分支，不值当。 */
function lastUsedText(secs: number | null | undefined): string | null {
  if (!secs) return null;
  const d = new Date(secs * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 小箭头，展开/收起共用。 */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={`h-3 w-3 shrink-0 text-ink-400 transition-transform dark:text-fg-muted ${
        open ? "rotate-90" : ""
      }`}
      aria-hidden="true"
    >
      <path
        d="M4.5 2.5L8 6l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export function CachePanel({
  i18n,
  errorMessage,
  onDismissError,
  overview,
  scanning,
  busyId,
  lastFreed,
  view,
  onChangeView,
  bookEntries,
  booksLoading,
  busyBookKey,
  expandedBookKey,
  onToggleBook,
  onClearBook,
  expandedId,
  entries,
  entriesLoading,
  busyEntryKeys,
  onClear,
  onToggleGroup,
  onClearEntry,
  onRefresh,
  onClearAll,
  onClose,
}: Props) {
  const groups = overview?.groups ?? [];
  // 单条清理也计入全局忙：进行中不允许再触发组级/整本/单条并发删除
  const anyBusy =
    busyId !== null || busyBookKey !== null || busyEntryKeys.size > 0;
  const canClearAll = !anyBusy && (overview?.reclaimableBytes ?? 0) > 0;
  // 破坏性操作两段式确认：第一击进入待确认态，再击或失焦/超时复位
  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmBookKey, setConfirmBookKey] = useState<string | null>(null);
  const [confirmGroupId, setConfirmGroupId] = useState<CacheGroupId | null>(null);
  const [confirmEntryKey, setConfirmEntryKey] = useState<string | null>(null);
  const [bookQuery, setBookQuery] = useState("");
  const [bookSort, setBookSort] = useState<CacheSort>("size");
  const [bookFilter, setBookFilter] = useState<CacheFilter>("all");
  useEffect(() => {
    if (
      !confirmAll &&
      confirmBookKey == null &&
      confirmGroupId == null &&
      confirmEntryKey == null
    ) return;
    const timer = window.setTimeout(() => {
      setConfirmAll(false);
      setConfirmBookKey(null);
      setConfirmGroupId(null);
      setConfirmEntryKey(null);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [confirmAll, confirmBookKey, confirmGroupId, confirmEntryKey]);
  // 条形长度按"占本列表最大组"的比例 —— 绝对字节数在 0 和 1.4 GB 之间无法同屏比较
  const maxBytes = groups.reduce((m, g) => Math.max(m, g.bytes), 0);

  const rows = bookEntries ?? [];
  const query = bookQuery.trim().toLocaleLowerCase();
  const visibleRows = rows
    .filter((row) => {
      if (bookFilter === "reclaimable" && row.reclaimBytes <= 0) return false;
      if (bookFilter === "missing" && !row.sourceMissing) return false;
      if (!query) return true;
      return [row.title, row.source, row.key]
        .some((value) => value?.toLocaleLowerCase().includes(query));
    })
    .sort((a, b) => {
      if (bookSort === "reclaimable" && b.reclaimBytes !== a.reclaimBytes) {
        return b.reclaimBytes - a.reclaimBytes;
      }
      if (bookSort === "recent" && b.lastUsed !== a.lastUsed) {
        return (b.lastUsed ?? 0) - (a.lastUsed ?? 0);
      }
      if (bookSort !== "recent" && b.bytes !== a.bytes) return b.bytes - a.bytes;
      return (a.title ?? a.key).localeCompare(b.title ?? b.key);
    });
  // 后端把未归属的项排在最后，这里只负责找断点插一条分隔说明
  const firstUnknown = visibleRows.findIndex((r) => r.bookId === null);

  return (
    <div className="h-full min-h-0 flex flex-col p-4">
      <div className="flex items-center justify-between mb-4 gap-2">
        <p className="label">{i18n.cacheTitle}</p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={`rounded-lg px-2 py-1 text-xs transition disabled:pointer-events-none disabled:opacity-40 ${
              confirmAll
                ? "border border-rose-500/50 bg-rose-500/10 font-medium text-rose-700 dark:border-rose-400/50 dark:bg-rose-500/15 dark:text-rose-200"
                : "border border-amber-500/40 text-amber-800 hover:bg-amber-500/10 dark:border-warning-border dark:text-warning-fg dark:hover:bg-warning-soft"
            }`}
            onClick={() => {
              if (confirmAll) {
                setConfirmAll(false);
                onClearAll();
              } else {
                setConfirmAll(true);
              }
            }}
            disabled={!canClearAll}
            title={!canClearAll ? i18n.cacheNothingToClear : undefined}
          >
            {busyId === "all"
              ? i18n.cacheClearing
              : confirmAll
                ? i18n.cacheConfirmClear
                : i18n.cacheClearSafe}
          </button>
          <button
            type="button"
            className="text-xs text-ink-500 hover:text-ink-950 disabled:opacity-50 dark:text-fg-muted dark:hover:text-fg"
            onClick={onRefresh}
            disabled={scanning}
          >
            {scanning ? i18n.cacheScanning : i18n.cacheRefresh}
          </button>
          <PanelCloseButton onClick={onClose} label={i18n.cacheHide} />
        </div>
      </div>

      <PanelFeedback
        message={errorMessage}
        dismissLabel={i18n.dismiss}
        onDismiss={onDismissError}
      />

      {overview && (
        <div className="mb-3 grid grid-cols-3 gap-2">
          {(
            [
              [i18n.cacheTotal, formatBytes(overview.totalBytes)],
              [i18n.cacheBulkReclaimable, formatBytes(overview.reclaimableBytes)],
              [
                i18n.cacheFree,
                overview.freeBytes != null ? formatBytes(overview.freeBytes) : "—",
              ],
            ] as const
          ).map(([label, value]) => (
            <div
              key={label}
              className="rounded-xl border border-ink-200 bg-ink-50 px-2.5 py-2 dark:border-white/10 dark:bg-surface-raised"
            >
              <p className="text-[10px] uppercase tracking-wider text-ink-500 dark:text-fg-muted">
                {label}
              </p>
              <p className="mt-0.5 text-sm font-medium tabular-nums text-ink-900 dark:text-fg">
                {value}
              </p>
            </div>
          ))}
        </div>
      )}

      {lastFreed != null && lastFreed > 0 && (
        <p className="mb-3 rounded-lg border border-success/30 bg-success-soft px-2.5 py-1.5 text-xs text-success dark:border-ok-border dark:bg-ok-soft dark:text-ok-fg">
          {i18n.cacheFreed} {formatBytes(lastFreed)}
        </p>
      )}

      {/* 轴切换：两个视图共用下面同一个列表区，取的是同一份磁盘事实（后端 collect_one_group），
          所以 Σ(按漫画) 恒等于 Σ(按存储类型)，切换只换呈现方式、不重新取数。
          这里用面板自己的 token 而不是复用 .reader-seg —— 后者的 --rb-track/--rb-pill
          只定义在阅读器画布作用域里，拿到面板上会是空值。
          颜色是算过对比度的：浅色未选 ink-700 on ink-200 = 7.98:1（ink-500 只有 4.05:1，不够）；
          深色轨道若用 surface-high，fg-muted 只有 3.75:1，所以轨道下沉一档到 surface-panel。 */}
      <div className="cache-seg" role="group" aria-label={i18n.cacheViewLabel}>
        <span
          className="cache-seg-thumb"
          aria-hidden="true"
          style={{ transform: view === "type" ? "translateX(100%)" : "translateX(0)" }}
        />
        {(
          [
            ["book", i18n.cacheByComic],
            ["type", i18n.cacheByType],
          ] as const
        ).map(([id, label]) => {
          const active = view === id;
          return (
            <button
              key={id}
              type="button"
              className={`cache-seg-item ${active ? "is-active" : ""}`}
              onClick={() => onChangeView(id)}
              aria-pressed={active}
            >
              {label}
            </button>
          );
        })}
      </div>

      {view === "book" && (
        <div className="mb-2 space-y-2">
          <input
            type="search"
            value={bookQuery}
            onChange={(event) => setBookQuery(event.target.value)}
            placeholder={i18n.cacheSearch}
            aria-label={i18n.cacheSearch}
            className="h-9 w-full rounded-lg border border-ink-200 bg-white px-3 text-xs text-ink-900 placeholder:text-ink-400 focus:border-accent focus:outline-none dark:border-white/10 dark:bg-surface-raised dark:text-fg dark:placeholder:text-fg-muted"
          />
          <div className="grid grid-cols-2 gap-2">
            <select
              value={bookSort}
              onChange={(event) => setBookSort(event.target.value as CacheSort)}
              aria-label={i18n.cacheSortLabel}
              className="h-8 min-w-0 rounded-lg border border-ink-200 bg-white px-2 text-xs text-ink-700 dark:border-white/10 dark:bg-surface-raised dark:text-fg"
            >
              <option value="size">{i18n.cacheSortLargest}</option>
              <option value="reclaimable">{i18n.cacheSortReclaimable}</option>
              <option value="recent">{i18n.cacheSortRecent}</option>
            </select>
            <select
              value={bookFilter}
              onChange={(event) => setBookFilter(event.target.value as CacheFilter)}
              aria-label={i18n.cacheFilterLabel}
              className="h-8 min-w-0 rounded-lg border border-ink-200 bg-white px-2 text-xs text-ink-700 dark:border-white/10 dark:bg-surface-raised dark:text-fg"
            >
              <option value="all">{i18n.cacheFilterAll}</option>
              <option value="reclaimable">{i18n.cacheFilterReclaimable}</option>
              <option value="missing">{i18n.cacheFilterMissing}</option>
            </select>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto pr-1">
        {/* ---------- 按漫画：一行 = 一本漫画的全部缓存，清理直接挂在行上 ---------- */}
        {view === "book" ? (
          <>
            {booksLoading && rows.length === 0 ? (
              <p className="px-1 py-3 text-xs text-ink-500 dark:text-fg-muted">
                {i18n.cacheScanning}
              </p>
            ) : rows.length === 0 ? (
              <p className="px-1 py-3 text-xs text-ink-500 dark:text-fg-muted">
                {scanning ? i18n.cacheScanning : i18n.cacheBookEmpty}
              </p>
            ) : visibleRows.length === 0 ? (
              <p className="px-1 py-3 text-xs text-ink-500 dark:text-fg-muted">
                {i18n.cacheNoResults}
              </p>
            ) : (
              <ul className="space-y-2">
                {visibleRows.map((row, i) => {
                  // 行标识由后端给出，前端不自己拼（否则展开状态与高亮会两处漂）
                  const key = row.key;
                  const expanded = expandedBookKey === key;
                  const unknown = row.bookId === null;
                  // 未归属的项不是"一本书"，用它的原始目录名当标题，并在下面打标记
                  const title = row.title ?? (unknown ? row.parts[0].key : null);
                  const used = lastUsedText(row.lastUsed);
                  const partial = row.reclaimBytes !== row.bytes;
                  const rowDisabled = row.busy || row.reclaimBytes === 0 || anyBusy;
                  const busy = busyBookKey === key;
                  return (
                    <li key={key}>
                      {/* 未归属的项排在最后，插一条分隔说明 —— 它们不是漫画 */}
                      {i === firstUnknown && firstUnknown !== -1 && (
                        <div className="mb-2 mt-1 border-t border-ink-200 pt-2 dark:border-white/10">
                          <p className="text-[10px] uppercase tracking-wider text-ink-500 dark:text-fg-muted">
                            {i18n.cacheUnattributed}
                          </p>
                        </div>
                      )}
                      <div className="rounded-xl border border-ink-200 bg-ink-50 p-3 dark:border-white/10 dark:bg-surface-panel">
                        <div className="flex items-baseline justify-between gap-2">
                          <button
                            type="button"
                            className="min-w-0 flex items-center gap-1.5 text-left"
                            onClick={() => onToggleBook(key)}
                            title={expanded ? i18n.cacheCollapse : i18n.cacheExpand}
                            aria-expanded={expanded}
                          >
                            <Chevron open={expanded} />
                            <span
                              className={`truncate text-sm font-medium ${
                                unknown
                                  ? "italic text-ink-600 dark:text-fg-muted"
                                  : "text-ink-900 dark:text-fg"
                              }`}
                              title={row.source ?? title ?? key}
                            >
                              {title ?? i18n.cacheUnattributed}
                            </span>
                          </button>
                          <p className="shrink-0 text-base font-medium tabular-nums leading-none text-ink-950 dark:text-fg">
                            {formatBytes(row.bytes)}
                          </p>
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-xs text-ink-600 dark:text-fg-muted">
                            {row.parts.length} {i18n.cacheBookParts} · {row.files}{" "}
                            {i18n.cacheEntryFiles}
                            {used ? ` · ${i18n.cacheLastUsed} ${used}` : ""}
                            {row.sourceMissing ? ` · ${i18n.cacheSourceMissing}` : ""}
                            {partial && row.reclaimBytes > 0
                              ? ` · ${i18n.cacheReclaimable} ${formatBytes(row.reclaimBytes)}`
                              : ""}
                          </span>
                          <span className="ml-auto">
                            <button
                              type="button"
                              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition disabled:pointer-events-none disabled:opacity-40 ${
                                confirmBookKey === row.key
                                  ? "border border-rose-500/50 bg-rose-500/10 text-rose-700 dark:border-rose-400/50 dark:bg-rose-500/15 dark:text-rose-200"
                                  : "border border-ink-300 bg-ink-200 text-ink-800 hover:bg-ink-300 dark:border-white/10 dark:bg-surface-high dark:text-fg"
                              }`}
                              onClick={() => {
                                if (confirmBookKey === row.key) {
                                  setConfirmBookKey(null);
                                  onClearBook(row);
                                } else {
                                  setConfirmBookKey(row.key);
                                }
                              }}
                              disabled={rowDisabled}
                              title={
                                row.busy
                                  ? i18n.cacheBookJobBusy
                                  : row.reclaimBytes === 0
                                    ? i18n.cacheEntryInUse
                                    : i18n.cacheClearBookTitle
                              }
                            >
                              {busy
                                ? i18n.cacheClearing
                                : confirmBookKey === row.key
                                  ? row.parts.some((p) => p.group === "jobs")
                                    ? i18n.cacheConfirmClearJob
                                    : i18n.cacheConfirmClear
                                  : i18n.cacheClear}
                            </button>
                          </span>
                        </div>

                        {row.busy && (
                          <p className="mt-1.5 text-xs text-amber-800 dark:text-warning-fg">
                            {i18n.cacheBookJobBusy}
                          </p>
                        )}

                        {expanded && (
                          <ul className="mt-2.5 space-y-0.5 border-t border-ink-200 pt-2 dark:border-white/10">
                            {row.parts.map((p) => {
                              const partDisabled =
                                p.reclaimBytes === 0 || p.busy || anyBusy;
                              return (
                                <li
                                  key={`${p.group}:${p.key}`}
                                  className="flex items-start gap-2 rounded-lg px-1.5 py-1"
                                >
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-xs text-ink-900 dark:text-fg">
                                      {groupLabel(i18n, p.group)}
                                    </span>
                                    <span
                                      className="mt-0.5 block truncate text-[10px] text-ink-500 dark:text-fg-muted"
                                      title={p.key}
                                    >
                                      {p.files} {i18n.cacheEntryFiles}
                                      {p.busy ? ` · ${i18n.cacheBookJobBusy}` : ""}
                                      {!p.busy && p.reclaimBytes === 0
                                        ? ` · ${i18n.cacheEntryInUse}`
                                        : ""}
                                      {p.reclaimBytes > 0 &&
                                      p.reclaimBytes !== p.bytes
                                        ? ` · ${i18n.cacheReclaimable} ${formatBytes(
                                            p.reclaimBytes,
                                          )}`
                                        : ""}
                                    </span>
                                  </span>
                                  <span className="shrink-0 pt-0.5 text-xs tabular-nums text-ink-600 dark:text-fg-muted">
                                    {formatBytes(p.bytes)}
                                  </span>
                                  <button
                                    type="button"
                                    className="shrink-0 rounded-md border border-ink-300 bg-ink-200 px-1.5 py-0.5 text-[11px] text-ink-800 transition hover:bg-ink-300 disabled:pointer-events-none disabled:opacity-40 dark:border-white/10 dark:bg-surface-high dark:text-fg"
                                    onClick={() => onClearEntry(p.group, p.key)}
                                    disabled={partDisabled}
                                    title={
                                      p.busy
                                        ? i18n.cacheBookJobBusy
                                        : p.reclaimBytes === 0
                                          ? i18n.cacheEntryInUse
                                          : undefined
                                    }
                                  >
                                    {busyEntryKeys.has(`${p.group}:${p.key}`)
                                      ? i18n.cacheScanning
                                      : i18n.cacheClear}
                                  </button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        ) : (
          groups.length === 0 ? (
            <p className="px-1 py-3 text-xs text-ink-500 dark:text-fg-muted">
              {scanning ? i18n.cacheScanning : i18n.cacheEmpty}
            </p>
          ) : (
          <ul className="space-y-3">
            {groups.map((g) => {
              const disabled = g.busy || g.reclaimBytes === 0 || anyBusy;
              const pctWidth =
                maxBytes > 0 ? Math.max(2, (g.bytes / maxBytes) * 100) : 0;
              const expanded = expandedId === g.id;
              return (
                <li
                  key={g.id}
                  className="rounded-xl border border-ink-200 bg-ink-50 p-3.5 dark:border-white/10 dark:bg-surface-panel"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <button
                      type="button"
                      className="min-w-0 flex items-center gap-1.5 text-left"
                      onClick={() => onToggleGroup(g.id)}
                      title={expanded ? i18n.cacheCollapse : i18n.cacheExpand}
                      aria-expanded={expanded}
                    >
                      <Chevron open={expanded} />
                      <span className="truncate text-sm font-medium text-ink-900 dark:text-fg">
                        {groupLabel(i18n, g.id)}
                      </span>
                    </button>
                    <p className="shrink-0 text-base font-medium tabular-nums leading-none text-ink-950 dark:text-fg">
                      {formatBytes(g.bytes)}
                    </p>
                  </div>

                  <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-ink-200 dark:bg-surface-high">
                    <div
                      className={`h-full rounded-full ${
                        g.kind === "pure"
                          ? "bg-accent dark:bg-accent-fg"
                          : "bg-ink-400 dark:bg-fg-muted"
                      }`}
                      style={{ width: `${pctWidth}%` }}
                    />
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span
                      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${
                        g.kind === "pure"
                          ? "border-success/35 bg-success-soft text-success dark:border-ok-border dark:bg-ok-soft dark:text-ok-fg"
                          : "border-amber-500/35 bg-amber-500/10 text-amber-800 dark:border-warning-border dark:bg-warning-soft dark:text-warning-fg"
                      }`}
                    >
                      {g.kind === "pure"
                        ? i18n.cacheKindPure
                        : i18n.cacheKindMixed}
                    </span>
                    <span className="text-xs text-ink-600 dark:text-fg-muted">
                      {g.reclaimBytes > 0
                        ? `${i18n.cacheReclaimable} ${formatBytes(g.reclaimBytes)} · `
                        : ""}
                      {g.entries} {groupUnit(i18n, g.id)}
                      {g.capBytes != null
                        ? ` · ${i18n.cacheCap} ${formatBytes(g.capBytes)}`
                        : ""}
                    </span>
                    <span className="ml-auto">
                      <button
                        type="button"
                        className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition disabled:pointer-events-none disabled:opacity-40 ${
                          confirmGroupId === g.id
                            ? "border-rose-500/50 bg-rose-500/10 text-rose-700 dark:border-danger-border dark:bg-danger-soft dark:text-danger-fg"
                            : "border-ink-300 bg-ink-200 text-ink-800 hover:bg-ink-300 dark:border-white/10 dark:bg-surface-high dark:text-fg"
                        }`}
                        onClick={() => {
                          if (g.id === "jobs" && confirmGroupId !== g.id) {
                            setConfirmGroupId(g.id);
                            return;
                          }
                          setConfirmGroupId(null);
                          onClear(g.id);
                        }}
                        disabled={disabled}
                        title={clearTitle(i18n, g)}
                      >
                        {busyId === g.id
                          ? i18n.cacheClearing
                          : confirmGroupId === g.id
                            ? i18n.cacheConfirmClearJob
                            : i18n.cacheClear}
                      </button>
                    </span>
                  </div>

                  <p className="mt-1.5 text-xs leading-relaxed text-ink-500 dark:text-fg-muted">
                    {groupHint(i18n, g.id)}
                  </p>

                  {expanded && (
                    <div className="mt-3 border-t border-ink-200 pt-2.5 dark:border-white/10">
                      {entriesLoading ? (
                        <p className="px-1 text-xs text-ink-500 dark:text-fg-muted">
                          {i18n.cacheScanning}
                        </p>
                      ) : !entries || entries.length === 0 ? (
                        <p className="px-1 text-xs text-ink-500 dark:text-fg-muted">
                          {i18n.cacheEntryEmpty}
                        </p>
                      ) : (
                        <ul className="space-y-0.5">
                          {entries.map((e) => {
                            const label = e.title ?? i18n.cacheUnknownEntry;
                            const used = lastUsedText(e.lastUsed);
                            const partial = e.reclaimBytes !== e.bytes;
                            const rowDisabled =
                              e.reclaimBytes === 0 || anyBusy;
                            return (
                              <li
                                key={e.key}
                                className="flex items-start gap-2 rounded-lg px-1.5 py-1"
                              >
                                <span className="min-w-0 flex-1">
                                  <span
                                    className={`block truncate text-xs ${
                                      e.title
                                        ? "text-ink-900 dark:text-fg"
                                        : "italic text-ink-500 dark:text-fg-muted"
                                    }`}
                                    title={e.source ?? e.key}
                                  >
                                    {label}
                                  </span>
                                  <span className="mt-0.5 block truncate text-[10px] text-ink-500 dark:text-fg-muted">
                                    {e.files} {i18n.cacheEntryFiles}
                                    {used
                                      ? ` · ${i18n.cacheLastUsed} ${used}`
                                      : ""}
                                    {e.sourceMissing
                                      ? ` · ${i18n.cacheSourceMissing}`
                                      : ""}
                                    {partial
                                      ? ` · ${
                                          i18n.cacheReclaimable
                                        } ${formatBytes(e.reclaimBytes)}`
                                      : ""}
                                  </span>
                                </span>
                                <span className="shrink-0 pt-0.5 text-xs tabular-nums text-ink-600 dark:text-fg-muted">
                                  {formatBytes(e.bytes)}
                                </span>
                                <button
                                  type="button"
                                  className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] transition disabled:pointer-events-none disabled:opacity-40 ${
                                    confirmEntryKey === `${g.id}:${e.key}`
                                      ? "border-rose-500/50 bg-rose-500/10 text-rose-700 dark:border-danger-border dark:bg-danger-soft dark:text-danger-fg"
                                      : "border-ink-300 bg-ink-200 text-ink-800 hover:bg-ink-300 dark:border-white/10 dark:bg-surface-high dark:text-fg"
                                  }`}
                                  onClick={() => {
                                    const entryKey = `${g.id}:${e.key}`;
                                    if (g.id === "jobs" && confirmEntryKey !== entryKey) {
                                      setConfirmEntryKey(entryKey);
                                      return;
                                    }
                                    setConfirmEntryKey(null);
                                    onClearEntry(g.id, e.key);
                                  }}
                                  disabled={rowDisabled}
                                  title={
                                    e.reclaimBytes === 0
                                      ? i18n.cacheEntryInUse
                                      : undefined
                                  }
                                >
                                  {busyEntryKeys.has(`${g.id}:${e.key}`)
                                    ? i18n.cacheClearing
                                    : confirmEntryKey === `${g.id}:${e.key}`
                                      ? i18n.cacheConfirmClearJob
                                      : i18n.cacheClear}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          )
        )}
      </div>
    </div>
  );
}
