export type SpreadMode = "single" | "double";
export type ReadDirection = "ltr" | "rtl";
export type FitMode = "screen" | "smart";
export type ReaderViewMode = "page" | "webtoon";

export type ReaderPref = {
  pageIndex: number;
  spread: SpreadMode;
  direction: ReadDirection;
  fit: FitMode;
  view?: ReaderViewMode;
};

const KEY = "comic.reader.prefs";

const DEFAULT_PREF: ReaderPref = {
  pageIndex: 0,
  spread: "single",
  direction: "ltr",
  fit: "screen",
  view: "page",
};

function loadAll(): Record<string, ReaderPref> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, ReaderPref>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function prefKey(source: string): string {
  return source.replace(/\\/g, "/");
}

export function loadReaderPref(source: string): ReaderPref {
  const all = loadAll();
  const saved = all[prefKey(source)];
  if (!saved) return { ...DEFAULT_PREF };
  return {
    pageIndex: Number.isFinite(saved.pageIndex) ? Math.max(0, saved.pageIndex) : 0,
    spread: saved.spread === "double" ? "double" : "single",
    direction: saved.direction === "rtl" ? "rtl" : "ltr",
    fit: saved.fit === "smart" ? "smart" : "screen",
    view: saved.view === "webtoon" ? "webtoon" : "page",
  };
}

/** 一次性读取全部阅读偏好（只解析一次 JSON，供书库排序/过滤等批量场景使用） */
export function loadAllReaderPrefs(): Map<string, ReaderPref> {
  const all = loadAll();
  const map = new Map<string, ReaderPref>();
  for (const [k, v] of Object.entries(all)) {
    map.set(k, {
      pageIndex: Number.isFinite(v.pageIndex) ? Math.max(0, v.pageIndex) : 0,
      spread: v.spread === "double" ? "double" : "single",
      direction: v.direction === "rtl" ? "rtl" : "ltr",
      fit: v.fit === "smart" ? "smart" : "screen",
      view: v.view === "webtoon" ? "webtoon" : "page",
    });
  }
  return map;
}

export function saveReaderPref(
  source: string,
  pref: ReaderPref,
  options: { persistView?: boolean } = {},
) {
  try {
    const all = loadAll();
    const next: ReaderPref = {
      pageIndex: pref.pageIndex,
      spread: pref.spread,
      direction: pref.direction,
      fit: pref.fit,
    };
    if (options.persistView || prefHasExplicitView(source) || pref.view === "webtoon") {
      next.view = pref.view === "webtoon" ? "webtoon" : "page";
    }
    all[prefKey(source)] = next;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* ignore quota */
  }
}

/** Whether this book has an explicit view choice; old records have no view key. */
export function prefHasExplicitView(source: string): boolean {
  const saved = loadAll()[prefKey(source)];
  return !!saved && Object.prototype.hasOwnProperty.call(saved, "view");
}

const READER_ENGINE_KEY = "comic.reader.engine";

/** 阅读器可用的引擎（仅用于类型收窄） */
export type ReaderEngineId = "waifu2x-coreml" | "realesrgan-coreml";

export function isReaderEngine(id: string): id is ReaderEngineId {
  return id === "waifu2x-coreml" || id === "realesrgan-coreml";
}

export function loadReaderEngine(): ReaderEngineId {
  try {
    const saved = localStorage.getItem(READER_ENGINE_KEY);
    if (saved && isReaderEngine(saved)) return saved;
    // 旧版和整本增强共用 comic.engine，仅当它是 Core ML 时迁移
    const legacy = localStorage.getItem("comic.engine");
    if (legacy && isReaderEngine(legacy)) return legacy;
  } catch {
    /* ignore */
  }
  return "waifu2x-coreml";
}

export function saveReaderEngine(engineId: ReaderEngineId) {
  try {
    localStorage.setItem(READER_ENGINE_KEY, engineId);
  } catch {
    /* ignore */
  }
}

const NOISE_KEY = "comic.enhanceNoise";

export function loadEnhanceNoise(): 0 | 1 | 2 | 3 {
  try {
    const n = Number(localStorage.getItem(NOISE_KEY));
    if (n === 0 || n === 1 || n === 2 || n === 3) return n;
  } catch {
    /* ignore */
  }
  return 3;
}

export function saveEnhanceNoise(noise: 0 | 1 | 2 | 3) {
  try {
    localStorage.setItem(NOISE_KEY, String(noise));
  } catch {
    /* ignore */
  }
}

export type ReaderBgId = "black" | "dark" | "white" | "sepia";

export type ReaderBgPreset = {
  id: ReaderBgId;
  hex: string;
  /** true: canvas is dark and overlays should use light text */
  onDark: boolean;
};

export const READER_BG_PRESETS: readonly ReaderBgPreset[] = [
  { id: "black", hex: "#000000", onDark: true },
  { id: "dark", hex: "#212121", onDark: true },
  { id: "white", hex: "#FFFFFF", onDark: false },
  { id: "sepia", hex: "#F3E6C8", onDark: false },
] as const;

export const DEFAULT_READER_BG: ReaderBgId = "black";
const READER_BG_KEY = "comic.reader.bg";

export function isReaderBgId(value: string): value is ReaderBgId {
  return READER_BG_PRESETS.some((preset) => preset.id === value);
}

export function loadReaderBg(): ReaderBgId {
  try {
    const saved = localStorage.getItem(READER_BG_KEY);
    return saved && isReaderBgId(saved) ? saved : DEFAULT_READER_BG;
  } catch {
    return DEFAULT_READER_BG;
  }
}

export function saveReaderBg(id: ReaderBgId): void {
  try {
    localStorage.setItem(READER_BG_KEY, id);
  } catch {
    /* ignore storage quota / privacy errors */
  }
}

export function readerBgPreset(id: ReaderBgId = loadReaderBg()): ReaderBgPreset {
  return READER_BG_PRESETS.find((preset) => preset.id === id) ?? READER_BG_PRESETS[0];
}
