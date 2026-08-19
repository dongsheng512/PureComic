export const STRIP_BEHIND = 1;
export const STRIP_AHEAD = 2;
export const DEFAULT_ASPECT = 1735 / 1200;
const ASPECT_STORE_PREFIX = "comic.reader.aspect:";

/** Return the small fallback window used before the virtualizer reports items. */
export function stripIndexes(pageIndex: number, pageCount: number): number[] {
  const out: number[] = [];
  for (let i = pageIndex - STRIP_BEHIND; i <= pageIndex + STRIP_AHEAD; i += 1) {
    if (i >= 0 && i < pageCount) out.push(i);
  }
  return out;
}

/** Prefetch the rendered virtual window plus `extra` pages on each end. */
export function expandStripPrefetch(
  indexes: readonly number[],
  pageCount: number,
  extra = 2,
): number[] {
  if (indexes.length === 0 || pageCount <= 0) return [];
  const first = indexes[0];
  const last = indexes[indexes.length - 1];
  const out = new Set(indexes);
  for (let d = 1; d <= extra; d += 1) {
    if (first - d >= 0) out.add(first - d);
    if (last + d < pageCount) out.add(last + d);
  }
  return Array.from(out).sort((a, b) => a - b);
}

/** Median of known page aspects; null until at least 3 samples exist. */
export function medianAspect(aspects: readonly number[]): number | null {
  const known = aspects
    .filter((aspect) => Number.isFinite(aspect) && aspect > 0)
    .sort((a, b) => a - b);
  if (known.length < 3) return null;
  const middle = Math.floor(known.length / 2);
  return known.length % 2 === 0
    ? (known[middle - 1] + known[middle]) / 2
    : known[middle];
}

/** Fit-width used by the strip (never upscale past maxWidth). */
export function stripContentWidth(viewportWidth: number, maxWidth: number): number {
  return Math.max(1, Math.min(viewportWidth, maxWidth));
}

/** Convert a natural image aspect ratio into the displayed height. */
export function displayHeight(
  viewportWidth: number,
  maxWidth: number,
  aspect: number,
): number {
  return Math.round(stripContentWidth(viewportWidth, maxWidth) * aspect);
}

/** Resolve the page under a Y offset using per-page heights. */
export function pageIndexAtOffset(
  offsetY: number,
  pageCount: number,
  heightOf: (index: number) => number,
): number {
  if (pageCount <= 0) return 0;
  let rest = Math.max(0, offsetY);
  for (let i = 0; i < pageCount; i += 1) {
    const height = Math.max(1, heightOf(i));
    if (rest < height) return i;
    rest -= height;
  }
  return pageCount - 1;
}

/** Estimate a page height before its image has decoded. */
export function estimatedHeight(
  viewportWidth: number,
  maxWidth: number,
  aspect = DEFAULT_ASPECT,
): number {
  return displayHeight(viewportWidth, maxWidth, aspect);
}

function aspectStoreKey(source: string): string {
  return ASPECT_STORE_PREFIX + source.replace(/\\/g, "/");
}

export function loadStoredAspects(source: string): Map<number, number> {
  const map = new Map<number, number>();
  if (!source) return map;
  try {
    const raw = localStorage.getItem(aspectStoreKey(source));
    if (!raw) return map;
    const parsed = JSON.parse(raw) as Record<string, number>;
    for (const [key, value] of Object.entries(parsed)) {
      const index = Number(key);
      if (Number.isInteger(index) && Number.isFinite(value) && value > 0) {
        map.set(index, value);
      }
    }
  } catch {
    /* ignore */
  }
  return map;
}

export function storeAspects(source: string, map: Map<number, number>): void {
  if (!source) return;
  try {
    const parsed: Record<string, number> = {};
    for (const [index, aspect] of map) parsed[String(index)] = aspect;
    localStorage.setItem(aspectStoreKey(source), JSON.stringify(parsed));
  } catch {
    /* ignore */
  }
}
