import zh from "./zh-CN.json";
import en from "./en.json";

export type Locale = "zh-CN" | "en";
export type Messages = typeof zh;

const catalogs: Record<Locale, Messages> = {
  "zh-CN": zh,
  en,
};

let current: Locale = "zh-CN";

export function setLocale(locale: Locale) {
  current = locale;
}

export function t(): Messages {
  return catalogs[current];
}

export function stateLabel(state: string): string {
  const map = t().state as Record<string, string>;
  return map[state] ?? state;
}
