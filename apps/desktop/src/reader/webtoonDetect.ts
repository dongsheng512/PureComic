export type WebtoonPageName = { name: string };

/** Return a 0-based chapter number parsed from the last matching path segment. */
export function chapterIndexFromName(name: string): number | null {
  const segments = name.replace(/\\/g, "/").split("/");
  let result: number | null = null;
  for (const [index, raw] of segments.entries()) {
    const segment = raw.trim();
    const match =
      /^chapter[-_ ]?(\d+)$/i.exec(segment) ??
      /^ch[-_ ]?(\d+)$/i.exec(segment) ??
      /^话[-_ ]?(\d+)$/i.exec(segment) ??
      /^第(\d+)[话話]$/i.exec(segment) ??
      (index === segments.length - 1 ? /第(\d+)[话話]/.exec(segment) : null);
    if (match) result = Number(match[1]);
  }
  return result != null && Number.isSafeInteger(result) ? result : null;
}

function samplePages<T>(pages: readonly T[]): T[] {
  if (pages.length <= 24) return [...pages];
  const sample = pages.slice(0, 24);
  const remaining = pages.length - 24;
  const extraCount = Math.min(24, remaining);
  for (let i = 0; i < extraCount; i += 1) {
    const offset =
      extraCount === 1 ? 0 : Math.floor((i * (remaining - 1)) / (extraCount - 1));
    sample.push(pages[24 + offset]);
  }
  return sample;
}

/** Suggest vertical reading for old books without an explicit view preference. */
export function shouldDefaultWebtoon(pages: readonly WebtoonPageName[]): boolean {
  if (pages.length < 8) return false;
  const sample = samplePages(pages);
  const chapterIndexes = sample.map((page) => chapterIndexFromName(page.name));
  const parsed = chapterIndexes.filter((index): index is number => index != null);
  if (parsed.length / sample.length < 0.5) return false;

  const counts = new Map<number, number>();
  for (const index of parsed) counts.set(index, (counts.get(index) ?? 0) + 1);
  return counts.size >= 2 || Math.max(...counts.values()) >= 8;
}
