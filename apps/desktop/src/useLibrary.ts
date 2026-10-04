import { useCallback, useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  addLibraryCollectionEntries,
  addLibraryPath,
  createLibraryCollection,
  dissolveLibraryCollection,
  errorMessage,
  importLibraryPaths,
  listLibrary,
  moveLibraryCollectionEntry,
  removeLibraryCollectionEntry,
  renameLibraryCollection,
  previewLibraryScan,
  removeLibraryEntry,
} from "./api";
import type { Messages } from "./i18n";
import { pickComicFiles, pickFolder } from "./library/LibraryView";
import { loadImportSettings, saveImportSettings } from "./library/prefs";
import type { LibraryCollection, LibraryEntry, LibraryScanPreview } from "./types";

export type AppTab = "library" | "enhance" | "doctor";

function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function fillMsg(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}

export function findLibraryByPath(list: LibraryEntry[], path: string): LibraryEntry | undefined {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const n = norm(path);
  return list.find((e) => norm(e.path) === n);
}

function noticeForUpsert(i18n: Messages, before: LibraryEntry | undefined, entry: LibraryEntry): string {
  if (!before) {
    return fillMsg(i18n.libraryNoticeAdded, { title: entry.title, pages: entry.pageCount });
  }
  if (before.pageCount !== entry.pageCount) {
    return fillMsg(i18n.libraryNoticeUpdated, {
      title: entry.title,
      from: before.pageCount,
      to: entry.pageCount,
    });
  }
  return fillMsg(i18n.libraryNoticeExists, { title: entry.title, pages: entry.pageCount });
}

function errMsg(e: unknown): string {
  return errorMessage(e);
}

export function useLibrary(opts: {
  i18n: Messages;
  setError: (msg: string | null) => void;
  setTab: (tab: AppTab) => void;
}) {
  const { i18n, setError, setTab } = opts;
  const libraryRef = useRef<LibraryEntry[]>([]);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [collections, setCollections] = useState<LibraryCollection[]>([]);
  const [libraryScan, setLibraryScan] = useState(false);
  const [libraryImporting, setLibraryImporting] = useState(false);
  const [libraryImportProgress, setLibraryImportProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null);
  const [scanPreview, setScanPreview] = useState<LibraryScanPreview | null>(null);

  useEffect(() => {
    if (!libraryNotice || libraryImporting) return;
    const timer = window.setTimeout(() => setLibraryNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [libraryNotice, libraryImporting]);

  const refreshLibrary = useCallback(async () => {
    try {
      const list = await listLibrary();
      setLibrary(list.entries);
      setCollections(list.collections ?? []);
      libraryRef.current = list.entries;
    } catch {
      /* backend not ready */
    }
  }, []);

  useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  // 监控目录：首帧后空闲时轻量自动扫描并导入新书（不挡首屏库列表）
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const { watchFolders } = loadImportSettings();
        if (watchFolders.length === 0) return;
        let failed = 0;
        for (const root of watchFolders) {
          if (cancelled) return;
          try {
            const preview = await previewLibraryScan(root);
            const fresh = preview.candidates
              .filter((c) => !c.alreadyInLibrary)
              .map((c) => c.path);
            if (fresh.length === 0) continue;
            const r = await importLibraryPaths(fresh);
            if (!cancelled && r.added > 0) {
              setLibraryNotice(r.message);
              await refreshLibrary();
            }
          } catch {
            failed += 1;
          }
        }
        if (!cancelled && failed > 0) {
          setLibraryNotice(
            fillMsg(i18n.libraryWatchUnavailable, { count: failed }),
          );
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [refreshLibrary, i18n]);

  const ingestPath = useCallback(
    async (path: string): Promise<LibraryEntry | null> => {
      setError(null);
      setLibraryImporting(true);
      setLibraryImportProgress(null);
      await yieldToPaint();
      try {
        const before = findLibraryByPath(libraryRef.current, path);
        const entry = await addLibraryPath(path);
        await refreshLibrary();
        setLibraryNotice(noticeForUpsert(i18n, before, entry));
        return entry;
      } catch {
        try {
          setLibraryScan(true);
          const preview = await previewLibraryScan(path);
          setScanPreview(preview);
          setTab("library");
        } catch (e) {
          setError(errMsg(e));
        } finally {
          setLibraryScan(false);
        }
        return null;
      } finally {
        setLibraryImporting(false);
      }
    },
    [i18n, refreshLibrary, setError, setTab],
  );

  const onLibAddFile = useCallback(async () => {
    const paths = await pickComicFiles();
    if (paths.length === 0) return;
    setLibraryImporting(true);
    setLibraryImportProgress({ done: 0, total: paths.length });
    setError(null);
    await yieldToPaint();
    try {
      let done = 0;
      let failed = 0;
      let lastNotice: string | null = null;
      const prior = libraryRef.current;
      for (const p of paths) {
        try {
          const before = findLibraryByPath(prior, p);
          const entry = await addLibraryPath(p);
          lastNotice = noticeForUpsert(i18n, before, entry);
        } catch {
          /* 单个失败继续，但**计入失败数**：旧实现静默吞掉，
             多选 5 个失败 2 个时用户只看到"已处理 5 个文件"，不知道少了书 */
          failed += 1;
        }
        done += 1;
        setLibraryImportProgress({ done, total: paths.length });
      }
      await refreshLibrary();
      if (paths.length === 1) {
        setLibraryNotice(lastNotice ?? fillMsg(i18n.libraryImportFailedOne, {}));
      } else {
        setLibraryNotice(
          failed === 0
            ? `已导入 ${paths.length} 个文件`
            : fillMsg(i18n.libraryImportPartialFail, {
                ok: paths.length - failed,
                total: paths.length,
                failed,
              }),
        );
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLibraryImporting(false);
      setLibraryImportProgress(null);
    }
  }, [i18n, refreshLibrary, setError]);

  const onLibAddFolder = useCallback(async () => {
    const p = await pickFolder();
    if (p) await ingestPath(p);
  }, [ingestPath]);

  const onLibScan = useCallback(
    async (opts?: { addToWatch?: boolean }) => {
      const p = await pickFolder();
      if (!p) return;
      if (opts?.addToWatch) {
        const settings = loadImportSettings();
        if (!settings.watchFolders.includes(p)) {
          saveImportSettings({ ...settings, watchFolders: [...settings.watchFolders, p] });
        }
      }
      setLibraryScan(true);
      setError(null);
      try {
        setScanPreview(await previewLibraryScan(p));
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setLibraryScan(false);
      }
    },
    [setError],
  );

  const onLibCancelScan = useCallback(() => setScanPreview(null), []);

  const onLibConfirmScan = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setLibraryImporting(true);
      setLibraryImportProgress({ done: 0, total: paths.length });
      setError(null);
      try {
        const batch = 8;
        let lastMsg = "";
        for (let i = 0; i < paths.length; i += batch) {
          const slice = paths.slice(i, i + batch);
          const r = await importLibraryPaths(slice);
          lastMsg = r.message;
          setLibraryImportProgress({
            done: Math.min(paths.length, i + slice.length),
            total: paths.length,
          });
        }
        setLibraryNotice(lastMsg || `已导入 ${paths.length} 本`);
        setScanPreview(null);
        await refreshLibrary();
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setLibraryImporting(false);
        setLibraryImportProgress(null);
      }
    },
    [refreshLibrary, setError],
  );

  const onLibRemove = useCallback(
    async (e: LibraryEntry) => {
      // 破坏性操作二次确认；hover 直删易误触
      let ok: boolean;
      try {
        ok = await ask(fillMsg(i18n.libraryRemoveConfirm, { title: e.title }), {
          title: i18n.libraryRemove,
          kind: "warning",
        });
      } catch {
        return;
      }
      if (!ok) return;
      void removeLibraryEntry(e.id)
        .then(refreshLibrary)
        .catch((err) => setError(errMsg(err)));
    },
    [i18n, refreshLibrary, setError],
  );

  const changeCollection = useCallback(
    async (op: () => Promise<unknown>) => {
      try {
        await op();
        await refreshLibrary();
      } catch (e) {
        setError(errMsg(e));
      }
    },
    [refreshLibrary, setError],
  );
  const onCreateCollection = useCallback(
    (title: string, entryIds: string[]) =>
      changeCollection(() => createLibraryCollection(title, entryIds)),
    [changeCollection],
  );
  const onAddToCollection = useCallback(
    (id: string, entryIds: string[]) =>
      changeCollection(() => addLibraryCollectionEntries(id, entryIds)),
    [changeCollection],
  );
  const onRemoveFromCollection = useCallback(
    (id: string, entryId: string) =>
      changeCollection(() => removeLibraryCollectionEntry(id, entryId)),
    [changeCollection],
  );
  const onMoveInCollection = useCallback(
    (id: string, entryId: string, delta: number) =>
      changeCollection(() => moveLibraryCollectionEntry(id, entryId, delta)),
    [changeCollection],
  );
  const onRenameCollection = useCallback(
    (id: string, title: string) => changeCollection(() => renameLibraryCollection(id, title)),
    [changeCollection],
  );
  const onDissolveCollection = useCallback(
    async (id: string) => {
      // 解散会丢掉用户手动排的卷顺序（书籍本体保留），与删除单本同级风险 → 同样二次确认
      const title = collections.find((c) => c.id === id)?.title ?? "";
      let ok: boolean;
      try {
        ok = await ask(
          fillMsg(i18n.libraryCollectionDissolveConfirm, { title }),
          { title: i18n.libraryCollectionDissolve, kind: "warning" },
        );
      } catch {
        return;
      }
      if (!ok) return;
      await changeCollection(() => dissolveLibraryCollection(id));
    },
    [changeCollection, collections, i18n],
  );

  return {
    library,
    collections,
    libraryRef,
    libraryScan,
    libraryImporting,
    libraryImportProgress,
    libraryNotice,
    setLibraryNotice,
    scanPreview,
    refreshLibrary,
    ingestPath,
    onLibAddFile,
    onLibAddFolder,
    onLibScan,
    onLibCancelScan,
    onLibConfirmScan,
    onLibRemove,
    onCreateCollection,
    onAddToCollection,
    onRemoveFromCollection,
    onMoveInCollection,
    onRenameCollection,
    onDissolveCollection,
  };
}
