export type SpreadMode = "single" | "double";
export type ReadDirection = "ltr" | "rtl";
export type FitMode = "screen" | "smart";

export type ReaderPref = {
  pageIndex: number;
  spread: SpreadMode;
  direction: ReadDirection;
  fit: FitMode;
};

const KEY = "comic.reader.prefs";

const DEFAULT_PREF: ReaderPref = {
  pageIndex: 0,
  spread: "single",
  direction: "ltr",
  fit: "screen",
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
  };
}

export function saveReaderPref(source: string, pref: ReaderPref) {
  try {
    const all = loadAll();
    all[prefKey(source)] = pref;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* ignore quota */
  }
}

const READER_ENGINE_KEY = "comic.reader.engine";

const READER_ENGINES = ["waifu2x-coreml", "realesrgan-coreml"] as const;
export type ReaderEngineId = (typeof READER_ENGINES)[number];

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
