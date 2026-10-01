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
export type ExportQuality = "high" | "balanced" | "compact" | "minimal";

/**
 * 导出档位。quality 是同一分辨率下的 JPEG 质量。
 * `outputMaxSide` 为 0 时不限宽；其余档在超分之后把长边收到 3200。
 * 最高画质保持引擎分辨率，避免「最高」仍被静默缩小。
 */
export const EXPORT_TIER: Record<
  ExportQuality,
  { jpegQuality: number; outputMaxSide: number }
> = {
  high: { jpegQuality: 92, outputMaxSide: 0 },
  balanced: { jpegQuality: 88, outputMaxSide: 3200 },
  compact: { jpegQuality: 82, outputMaxSide: 3200 },
  minimal: { jpegQuality: 75, outputMaxSide: 3200 },
};

export const JPEG_QUALITY_OF: Record<ExportQuality, number> = {
  high: EXPORT_TIER.high.jpegQuality,
  balanced: EXPORT_TIER.balanced.jpegQuality,
  compact: EXPORT_TIER.compact.jpegQuality,
  minimal: EXPORT_TIER.minimal.jpegQuality,
};

export const DEFAULT_EXPORT_QUALITY: ExportQuality = "balanced";

export function exportTierOf(q: ExportQuality): {
  jpegQuality: number;
  outputMaxSide: number;
} {
  return EXPORT_TIER[q] ?? EXPORT_TIER[DEFAULT_EXPORT_QUALITY];
}

export function jpegQualityOf(q: ExportQuality): number {
  return exportTierOf(q).jpegQuality;
}

/** 首页扩展名。空列表视为未知，不当成 PNG。 */
export function sourcePageIsJpeg(pageNames: readonly string[] | undefined): boolean {
  const name = pageNames?.find((n) => n.length > 0 && !n.endsWith("/")) ?? "";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ext !== "png" && ext !== "webp";
}

/**
 * 画质档位是否对该格式生效。
 * PNG 恒为无损；WebP 在本项目（image 0.25）只有无损编码，两者都不吃 quality。
 * `same` 只在源页是 JPEG（或扩展名还未知）时生效。
 */
export function qualityAppliesTo(fmt: ImgFmt, sourceIsJpeg = true): boolean {
  if (fmt === "png" || fmt === "webp") return false;
  if (fmt === "same") return sourceIsJpeg;
  return true;
}

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

export const BATCH_ENGINE_IDS = ["realcugan-coreml", "waifu2x-coreml"] as const;

export function isBatchEngineId(id: string): boolean {
  return id === "realcugan-coreml" || id === "waifu2x-coreml";
}

/** 旧 Vulkan id 迁到 Core ML；无法识别则返回 null */
export function migrateBatchEngineId(raw: string | null): string | null {
  if (!raw) return null;
  if (raw === "realcugan" || raw === "realcugan-coreml") return "realcugan-coreml";
  if (raw === "waifu2x" || raw === "waifu2x-coreml") return "waifu2x-coreml";
  return isBatchEngineId(raw) ? raw : null;
}

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
    fallback?.threads ||
    blob.match(/线程 -j (\S+)/)?.[1] ||
    blob.match(/-j (\d+:\d+:\d+)/)?.[1] ||
    "";
  const mode =
    fallback?.mode ||
    (/目录批处理/.test(blob) ? "目录批处理" : /逐页并行/.test(blob) ? "逐页并行" : "");
  const ready = selected ? selected.available : (fallback?.available ?? false);
  const engineLabel =
    engineId === "realcugan-coreml" || engineId === "realcugan"
      ? "Real-CUGAN"
      : engineId === "waifu2x-coreml" || engineId === "waifu2x"
        ? "Waifu2x"
        : (selected?.label ?? engineId);
  const binary =
    engineId === "realcugan-coreml" || engineId === "realcugan"
      ? "Real-CUGAN Core ML"
      : engineId === "waifu2x-coreml" || engineId === "waifu2x"
        ? "Waifu2x Core ML"
        : engineId;
  const modelLabel = selected?.models.find((m) => m.id === cuganModel)?.label ?? selected?.models[0]?.label ?? "";
  const gpu =
    ready &&
    !fallback?.isMock &&
    (engineId.includes("coreml") ||
      fallback?.mode === "Core ML" ||
      /core ml|ane|metal|gpu|vulkan/i.test(blob));
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
