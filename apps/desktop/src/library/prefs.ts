export type LibrarySort = "recent" | "added" | "title" | "progress";
export type LibraryFilter = "all" | "reading" | "unread" | "missing";
export type LibraryViewMode = "grid" | "list";

export type LibraryImportSettings = {
  /** 扫描时包含子文件夹 */
  includeSubfolders: boolean;
  /** 允许的扩展（小写，无点）；空表示全部支持格式 */
  extensions: string[];
  /** 监控目录：进入书库时自动扫描并导入新书 */
  watchFolders: string[];
};

const SORT_KEY = "comic.library.sort";
const FILTER_KEY = "comic.library.filter";
const VIEW_KEY = "comic.library.view";
const IMPORT_KEY = "comic.library.import";

import { COMIC_EXTENSIONS } from "../formats";

export const DEFAULT_EXTENSIONS = [...COMIC_EXTENSIONS];

const DEFAULT_IMPORT: LibraryImportSettings = {
  includeSubfolders: true,
  extensions: [...DEFAULT_EXTENSIONS],
  watchFolders: [],
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as T) };
  } catch {
    return fallback;
  }
}

export function loadLibrarySort(): LibrarySort {
  try {
    const v = localStorage.getItem(SORT_KEY);
    if (v === "recent" || v === "added" || v === "title" || v === "progress") return v;
  } catch {
    /* ignore */
  }
  return "recent";
}

export function saveLibrarySort(v: LibrarySort) {
  try {
    localStorage.setItem(SORT_KEY, v);
  } catch {
    /* ignore */
  }
}

export function loadLibraryFilter(): LibraryFilter {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    if (v === "all" || v === "reading" || v === "unread" || v === "missing") return v;
  } catch {
    /* ignore */
  }
  return "all";
}

export function saveLibraryFilter(v: LibraryFilter) {
  try {
    localStorage.setItem(FILTER_KEY, v);
  } catch {
    /* ignore */
  }
}

export function loadLibraryView(): LibraryViewMode {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "grid" || v === "list") return v;
  } catch {
    /* ignore */
  }
  return "grid";
}

export function saveLibraryView(v: LibraryViewMode) {
  try {
    localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* ignore */
  }
}

export function loadImportSettings(): LibraryImportSettings {
  const s = readJson(IMPORT_KEY, DEFAULT_IMPORT);
  return {
    includeSubfolders: s.includeSubfolders !== false,
    extensions: Array.isArray(s.extensions) && s.extensions.length > 0 ? s.extensions : [...DEFAULT_EXTENSIONS],
    watchFolders: Array.isArray(s.watchFolders) ? s.watchFolders : [],
  };
}

export function saveImportSettings(s: LibraryImportSettings) {
  try {
    localStorage.setItem(IMPORT_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
