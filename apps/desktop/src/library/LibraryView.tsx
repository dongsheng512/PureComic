import { convertFileSrc } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useMemo, useState } from "react";
import type { Messages } from "../i18n";
import type { LibraryEntry, LibraryScanPreview } from "../types";
import { loadReaderPref } from "../reader/prefs";

type Props = {
  entries: LibraryEntry[];
  dragOver: boolean;
  scanning: boolean;
  i18n: Messages;
  onAddFile: () => void;
  onAddFolder: () => void;
  onScan: () => void;
  scanPreview: LibraryScanPreview | null;
  importing: boolean;
  onConfirmScan: (paths: string[]) => void;
  onCancelScan: () => void;
  onOpen: (entry: LibraryEntry) => void;
  onEnhance: (entry: LibraryEntry) => void;
  onRemove: (entry: LibraryEntry) => void;
};

function coverUrl(path?: string): string | null {
  if (!path) return null;
  try {
    return convertFileSrc(path);
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

export function LibraryView({
  entries,
  dragOver,
  scanning,
  i18n,
  onAddFile,
  onAddFolder,
  onScan,
  scanPreview,
  importing,
  onConfirmScan,
  onCancelScan,
  onOpen,
  onEnhance,
  onRemove,
}: Props) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) => e.title.toLowerCase().includes(q) || e.path.toLowerCase().includes(q),
    );
  }, [entries, query]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary !h-9 !px-3 text-xs" onClick={onAddFile}>
          {i18n.libraryAddFile}
        </button>
        <button type="button" className="btn-ghost !h-9 !px-3 text-xs" onClick={onAddFolder}>
          {i18n.libraryAddFolder}
        </button>
        <button type="button" className="btn-ghost !h-9 !px-3 text-xs" disabled={scanning} onClick={onScan}>
          {scanning ? i18n.libraryScanning : i18n.libraryScan}
        </button>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索书名或路径"
          className="h-9 min-w-[12rem] flex-1 rounded-xl border border-ink-200 bg-white px-3 text-sm text-ink-800 dark:border-white/10 dark:bg-ink-950 dark:text-ink-100"
        />
      </div>
      <p className="text-xs text-ink-500">{i18n.libraryHint}</p>

      {filtered.length === 0 ? (
        <button
          type="button"
          onClick={onAddFile}
          className={`flex min-h-[18rem] flex-1 flex-col items-center justify-center rounded-2xl border border-dashed px-6 text-center transition ${
            dragOver
              ? "border-accent bg-accent/10"
              : "border-ink-300 bg-ink-50/80 hover:border-accent/50 dark:border-white/15 dark:bg-ink-950/40"
          }`}
        >
          <p className="text-sm font-medium text-ink-800 dark:text-ink-100">{i18n.libraryEmpty}</p>
          <p className="mt-2 max-w-md text-xs text-ink-500">{i18n.libraryHint}</p>
        </button>
      ) : (
        <ul className="grid grid-cols-2 gap-3 overflow-auto pb-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((e) => {
            const cover = coverUrl(e.coverPath);
            const pref = loadReaderPref(e.path);
            const page = e.lastReadPage || pref.pageIndex;
            return (
              <li key={e.id}>
                <article
                  className={`card group relative overflow-hidden ${e.missing ? "opacity-70" : ""}`}
                >
                  <button
                    type="button"
                    className="block w-full text-left"
                    disabled={e.missing}
                    onClick={() => onOpen(e)}
                  >
                    <div className="relative aspect-[2/3] bg-ink-200 dark:bg-ink-950">
                      {cover ? (
                        <img src={cover} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <div className="grid h-full place-items-center text-xs text-ink-400">
                          {kindLabel(e.kind)}
                        </div>
                      )}
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-white/45 px-2.5 py-1.5 backdrop-blur-md backdrop-saturate-150 dark:bg-black/45">
                        <p
                          className="truncate text-[13px] font-medium leading-tight text-ink-950 dark:text-white"
                          title={e.path}
                        >
                          {e.title}
                        </p>
                        <p className="truncate text-[10px] leading-tight text-ink-700/85 dark:text-white/75">
                          {kindLabel(e.kind)}
                          {e.pageCount > 0 ? ` · ${e.pageCount} ${i18n.libraryPages}` : ""}
                          {page > 0 ? ` · ${page + 1}` : ""}
                          {e.missing ? ` · ${i18n.libraryMissing}` : ""}
                        </p>
                      </div>
                    </div>
                  </button>
                  <div className="absolute inset-x-0 top-0 flex justify-end gap-2 p-2 opacity-0 transition group-hover:opacity-100">
                    <button
                      type="button"
                      className="rounded-xl bg-white/60 px-3 py-1.5 text-sm font-medium text-ink-900 backdrop-blur-md hover:bg-white/85 dark:bg-black/50 dark:text-white dark:hover:bg-black/70"
                      disabled={e.missing}
                      onClick={() => onEnhance(e)}
                    >
                      {i18n.libraryEnhance}
                    </button>
                    <button
                      type="button"
                      title={i18n.libraryRemoveHint}
                      className="rounded-xl bg-white/60 px-3 py-1.5 text-sm font-medium text-ink-900 backdrop-blur-md hover:bg-rose-500/85 hover:text-white dark:bg-black/50 dark:text-white"
                      onClick={() => onRemove(e)}
                    >
                      {i18n.libraryRemove}
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
          onConfirm={onConfirmScan}
          onCancel={onCancelScan}
        />
      )}
    </div>
  );
}

function ScanPicker({
  preview,
  importing,
  i18n,
  onConfirm,
  onCancel,
}: {
  preview: LibraryScanPreview;
  importing: boolean;
  i18n: Messages;
  onConfirm: (paths: string[]) => void;
  onCancel: () => void;
}) {
  const fresh = preview.candidates.filter((c) => !c.alreadyInLibrary);
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
      <div className="relative flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border border-ink-200 bg-white shadow-panel dark:border-white/10 dark:bg-ink-900">
        <div className="border-b border-ink-100 px-4 py-3 dark:border-white/10">
          <p className="text-sm font-medium text-ink-900 dark:text-ink-50">{i18n.libraryScanTitle}</p>
          <p className="mt-0.5 truncate text-[11px] text-ink-500" title={preview.root}>
            {preview.root}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
          {preview.candidates.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-ink-500">{i18n.libraryScanNone}</p>
          )}
          {preview.candidates.map((c) => (
            <label
              key={c.path}
              className={`flex cursor-pointer items-start gap-2 rounded-xl px-2 py-2 text-sm ${
                c.alreadyInLibrary ? "opacity-50" : "hover:bg-ink-50 dark:hover:bg-white/5"
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
                <span className="block truncate font-medium text-ink-900 dark:text-ink-50">{c.title}</span>
                <span className="block truncate text-[11px] text-ink-500">{c.path}</span>
              </span>
              <span className="shrink-0 text-[11px] text-ink-400">
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
          <button
            type="button"
            className="btn-ghost !h-8 !px-2.5 text-xs"
            onClick={() => setPicked(new Set())}
          >
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

export async function pickComicFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [
      {
        name: "Comic / Ebook",
        extensions: ["cbz", "cbr", "zip", "rar", "epub", "mobi", "azw", "azw3"],
      },
    ],
  });
  return typeof selected === "string" ? selected : null;
}

export async function pickFolder(): Promise<string | null> {
  const selected = await open({ multiple: false, directory: true });
  return typeof selected === "string" ? selected : null;
}
