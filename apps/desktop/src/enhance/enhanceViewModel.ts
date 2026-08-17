import { convertFileSrc } from "@tauri-apps/api/core";
import type { Messages } from "../i18n";
import type {
  DiskEstimate,
  EngineInfo,
  EngineStatus,
  LibraryEntry,
  ValidateResult,
} from "../types";

export type Preset = "fast" | "balanced" | "quality";
export type Container = "cbz" | "folder" | "zip";
export type ImgFmt = "jpeg" | "png" | "webp" | "same";

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

export function baseName(path: string): string {
  const p = path.replace(/\\/g, "/");
  return p.slice(p.lastIndexOf("/") + 1) || p;
}

export function kindLabel(kind: string): string {
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
      return "FOLDER";
    default:
      return kind.toUpperCase();
  }
}

/** 封面 asset url；浏览器环境 convertFileSrc 可能抛错，失败返回 null */
export function coverUrl(path?: string, cacheKey?: string): string | null {
  if (!path) return null;
  try {
    // 空格等字符由 convertFileSrc 处理；附加 cacheKey 避免重生成后仍用旧缓存
    const src = convertFileSrc(path);
    const bust = cacheKey ? encodeURIComponent(cacheKey) : encodeURIComponent(path);
    return `${src}${src.includes("?") ? "&" : "?"}v=${bust}`;
  } catch {
    return null;
  }
}

export type AccelInfo = {
  /** 引擎是否可用（未安装则 false） */
  ready: boolean;
  engineLabel: string;
  binary: string;
  /** 当前 CUGAN 模型（仅 Real-CUGAN） */
  modelLabel: string;
  /** 目录批处理 / 逐页并行 */
  mode: string;
  /** 形如 4:8:4 */
  threads: string;
  rawDetail: string;
  gpu: boolean;
};

/** 把后端 detail 长文本拆成徽章 + 详情需要的结构化字段 */
export function parseAccelInfo(
  catalog: EngineInfo[],
  engineId: string,
  cuganModel: string,
  fallback: EngineStatus | null,
): AccelInfo {
  const selected = catalog.find((e) => e.id === engineId) ?? null;
  const blob = `${selected?.detail ?? ""} ${fallback?.detail ?? ""}`;
  const threads =
    blob.match(/线程 -j (\S+)/)?.[1] ?? blob.match(/-j (\d+:\d+:\d+)/)?.[1] ?? "";
  const mode = /目录批处理/.test(blob)
    ? "目录批处理"
    : /逐页并行/.test(blob)
      ? "逐页并行"
      : "";
  const ready = selected ? selected.available : (fallback?.available ?? false);
  const engineLabel =
    engineId === "realcugan"
      ? "Real-CUGAN"
      : engineId === "waifu2x"
        ? "Waifu2x"
        : (selected?.label ?? engineId);
  const binary =
    engineId === "realcugan"
      ? "realcugan-ncnn-vulkan"
      : engineId === "waifu2x"
        ? "waifu2x-ncnn-vulkan"
        : engineId;
  const modelLabel =
    engineId === "realcugan"
      ? cuganModel.toUpperCase()
      : (selected?.models[0]?.label ?? "");
  const gpu =
    ready && (engineId === "realcugan" || engineId === "waifu2x" || /vulkan|metal|gpu/i.test(blob));
  return {
    ready,
    engineLabel,
    binary,
    modelLabel,
    mode,
    threads,
    rawDetail: selected?.detail || fallback?.detail || "",
    gpu,
  };
}

/** 开始增强不可用时的原因；可用返回 null */
export function startBlockReason(args: {
  i18n: Messages;
  source: string | null;
  sourceLoading: boolean;
  validation: ValidateResult | null;
  estimateLoading: boolean;
  outputDir: string | null;
  estimate: DiskEstimate | null;
  busy: boolean;
  engineReady: boolean;
}): string | null {
  const { i18n } = args;
  if (!args.source) return i18n.needSource;
  if (!args.engineReady) return i18n.needEngine;
  if (args.sourceLoading || !args.validation) return i18n.needValidate;
  if (args.estimateLoading || !args.estimate) return i18n.estimatingSpace;
  if (!args.outputDir) return i18n.needOutput;
  if (args.estimate && !args.estimate.ok)
    return `${i18n.needSpace} ${formatBytes(args.estimate.estimateBytes)}`;
  if (args.busy) return i18n.busyLabel;
  return null;
}

/** 源文件卡片展示信息（封面 / 标题 / 类型 / 页数） */
export function sourceMeta(args: {
  source: string | null;
  entry: LibraryEntry | null;
  validation: ValidateResult | null;
}): {
  title: string;
  kind: string;
  pages: number | null;
  cover: string | null;
} {
  const { source, entry, validation } = args;
  const title = entry?.title || (source ? baseName(source) : "");
  const kind = validation?.kind ?? entry?.kind ?? "";
  const pages = validation?.pageCount ?? (entry?.pageCount || null);
  const cover = coverUrl(entry?.coverPath, entry?.addedAt);
  return { title, kind, pages, cover };
}
