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

const ENGINE_KEY = "comic.engine";
const CUGAN_KEY = "comic.cuganModel";

export function loadEnhanceEngine(): { engineId: string; cuganModel: string } {
  try {
    return {
      engineId: localStorage.getItem(ENGINE_KEY) || "realcugan",
      cuganModel: localStorage.getItem(CUGAN_KEY) || "nose",
    };
  } catch {
    return { engineId: "realcugan", cuganModel: "nose" };
  }
}

export function saveEnhanceEngine(engineId: string, cuganModel: string) {
  try {
    localStorage.setItem(ENGINE_KEY, engineId);
    localStorage.setItem(CUGAN_KEY, cuganModel);
  } catch {
    /* ignore */
  }
}
