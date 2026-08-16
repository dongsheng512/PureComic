/** 外部打开 / 临时阅读：偏好与路径处理 */

import { COMIC_EXT_RE } from "./formats";

export type ExternalOpenRemember = "import" | "discard" | null;

const REMEMBER_KEY = "comic.externalOpen.remember";

export function loadExternalOpenRemember(): ExternalOpenRemember {
  try {
    const v = localStorage.getItem(REMEMBER_KEY);
    if (v === "import" || v === "discard") return v;
  } catch {
    /* ignore */
  }
  return null;
}

export function saveExternalOpenRemember(v: ExternalOpenRemember) {
  try {
    if (!v) localStorage.removeItem(REMEMBER_KEY);
    else localStorage.setItem(REMEMBER_KEY, v);
  } catch {
    /* ignore */
  }
}

export function titleFromPath(path: string): string {
  const base = path.split(/[/\\]/).pop() || path;
  return base.replace(COMIC_EXT_RE, "") || base;
}
