import type { LibraryCollection, LibraryEntry } from "../types";
import type { LibraryFilter, LibrarySort } from "./prefs";

export type ShelfItem =
  | { kind: "book"; entry: LibraryEntry }
  | {
      kind: "collection";
      collection: LibraryCollection;
      volumes: LibraryEntry[];
    };

function finished(entry: LibraryEntry, page: number): boolean {
  return page > 0 && entry.pageCount > 0 && page >= entry.pageCount - 1;
}

export function continueVolume(volumes: LibraryEntry[]): LibraryEntry | null {
  const present = volumes.filter((v) => !v.missing);
  if (present.length === 0) return volumes[0] ?? null;
  return [...present].sort((a, b) => stamp(b).localeCompare(stamp(a)))[0] ?? null;
}

function collectionMatches(
  collection: LibraryCollection,
  volumes: LibraryEntry[],
  query: string,
): boolean {
  if (!query) return true;
  if (collection.title.toLowerCase().includes(query)) return true;
  return volumes.some(
    (v) => v.title.toLowerCase().includes(query) || v.path.toLowerCase().includes(query),
  );
}

type Status = "missing" | "reading" | "unread" | "finished";

function bookStatus(entry: LibraryEntry, page: number): Status {
  if (entry.missing) return "missing";
  if (finished(entry, page)) return "finished";
  if (page > 0) return "reading";
  return "unread";
}

function collectionStatus(volumes: LibraryEntry[], progressOf: (e: LibraryEntry) => number): Status {
  if (volumes.length === 0 || volumes.every((v) => v.missing)) return "missing";
  const live = volumes.filter((v) => !v.missing).map((v) => bookStatus(v, progressOf(v)));
  if (live.some((s) => s === "reading")) return "reading";
  if (live.some((s) => s === "finished") && live.some((s) => s === "unread")) return "reading";
  if (live.every((s) => s === "finished")) return "finished";
  return "unread";
}

function keep(status: Status, filter: LibraryFilter): boolean {
  if (filter === "all") return true;
  if (filter === "missing") return status === "missing";
  if (filter === "reading") return status === "reading";
  if (filter === "unread") return status === "unread";
  if (filter === "finished") return status === "finished";
  return true;
}

export function buildShelf(opts: {
  entries: LibraryEntry[];
  collections: LibraryCollection[];
  query: string;
  filter: LibraryFilter;
  sort: LibrarySort;
  progressOf: (entry: LibraryEntry) => number;
}): ShelfItem[] {
  const q = opts.query.trim().toLowerCase();
  const byId = new Map(opts.entries.map((e) => [e.id, e]));
  const grouped = new Set<string>();
  const items: ShelfItem[] = [];

  for (const collection of opts.collections) {
    const volumes = collection.entryIds
      .map((id) => byId.get(id))
      .filter((e): e is LibraryEntry => Boolean(e));
    for (const volume of volumes) grouped.add(volume.id);
    if (!collectionMatches(collection, volumes, q)) continue;
    if (!keep(collectionStatus(volumes, opts.progressOf), opts.filter)) continue;
    items.push({ kind: "collection", collection, volumes });
  }

  for (const entry of opts.entries) {
    if (grouped.has(entry.id)) continue;
    if (q && !entry.title.toLowerCase().includes(q) && !entry.path.toLowerCase().includes(q)) {
      continue;
    }
    if (!keep(bookStatus(entry, opts.progressOf(entry)), opts.filter)) continue;
    items.push({ kind: "book", entry });
  }

  items.sort((a, b) => compareShelf(a, b, opts.sort, opts.progressOf));
  return items;
}

function compareShelf(
  a: ShelfItem,
  b: ShelfItem,
  sort: LibrarySort,
  progressOf: (entry: LibraryEntry) => number,
): number {
  if (sort === "title") return titleOf(a).localeCompare(titleOf(b), "zh");
  if (sort === "added") return addedOf(b).localeCompare(addedOf(a));
  if (sort === "progress") return progressRatio(b, progressOf) - progressRatio(a, progressOf);
  return recentOf(b).localeCompare(recentOf(a));
}

function titleOf(item: ShelfItem): string {
  return item.kind === "book" ? item.entry.title : item.collection.title;
}

function addedOf(item: ShelfItem): string {
  const list = item.kind === "book" ? [item.entry] : item.volumes;
  return list.reduce((max, e) => ((e.addedAt || "") > max ? e.addedAt || "" : max), "");
}

function recentOf(item: ShelfItem): string {
  const list = item.kind === "book" ? [item.entry] : item.volumes;
  return list.reduce((max, e) => (stamp(e) > max ? stamp(e) : max), "");
}

function stamp(entry: LibraryEntry): string {
  return entry.lastOpenedAt || entry.addedAt || "";
}

function progressRatio(item: ShelfItem, progressOf: (entry: LibraryEntry) => number): number {
  const list = (item.kind === "book" ? [item.entry] : item.volumes).filter((e) => !e.missing);
  if (list.length === 0) return 0;
  const sum = list.reduce((acc, e) => {
    if (e.pageCount <= 0) return acc;
    return acc + progressOf(e) / e.pageCount;
  }, 0);
  return sum / list.length;
}

export function coverVolume(item: Extract<ShelfItem, { kind: "collection" }>): LibraryEntry | undefined {
  const picked = item.collection.coverEntryId
    ? item.volumes.find((v) => v.id === item.collection.coverEntryId)
    : undefined;
  return picked ?? item.volumes[0];
}
