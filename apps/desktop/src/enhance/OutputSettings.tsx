import type { Messages } from "../i18n";
import { Field, SelectBox } from "./controls";
import type { Container, ImgFmt } from "./enhanceViewModel";

type Props = {
  i18n: Messages;
  outputDir: string | null;
  container: Container;
  imageFormat: ImgFmt;
  onPickOutput: () => void;
  onContainerChange: (c: Container) => void;
  onImageFormatChange: (f: ImgFmt) => void;
  /** 导入后填充剩余高度，与右侧方案卡对齐 */
  fill?: boolean;
};

/** 输出独立区块：输出位置 + 容器 + 图片格式 */
export function OutputSettings({
  i18n,
  outputDir,
  container,
  imageFormat,
  onPickOutput,
  onContainerChange,
  onImageFormatChange,
  fill,
}: Props) {
  const formatHint =
    imageFormat === "png"
      ? i18n.formatHintPng
      : imageFormat === "webp"
        ? i18n.formatHintWebp
        : imageFormat === "same"
          ? i18n.formatHintSame
          : i18n.formatHintJpeg;

  return (
    <section className={`card p-5 ${fill ? "flex-1" : ""}`}>
      <p className="label mb-3">{i18n.enhanceOutputSection}</p>
      <div className="flex gap-2">
        <div
          className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-ink-200 bg-ink-100 px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-surface-raised"
          title={outputDir ?? undefined}
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true">
            <path
              fill="currentColor"
              d="M3 5.5A1.5 1.5 0 0 1 4.5 4h3l1.5 1.5h6.5A1.5 1.5 0 0 1 17 7v7.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5v-9Z"
            />
          </svg>
          <span
            className={`truncate font-mono text-xs ${
              outputDir
                ? "text-ink-700 dark:text-fg"
                : "text-ink-400 dark:text-fg-muted"
            }`}
          >
            {outputDir ?? i18n.outputNotSet}
          </span>
        </div>
        <button type="button" className="btn-ghost shrink-0 !px-3.5" onClick={onPickOutput}>
          {i18n.chooseOutput}
        </button>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4">
        <Field label={i18n.container} hint={i18n.containerHint}>
          <SelectBox
            value={container}
            onChange={onContainerChange}
            options={[
              { id: "cbz", label: i18n.containerCbz },
              { id: "zip", label: i18n.containerZip },
              { id: "folder", label: i18n.containerFolder },
            ]}
          />
        </Field>
        <Field
          label={i18n.imageFormat}
          hint={formatHint}
        >
          <SelectBox
            value={imageFormat}
            onChange={onImageFormatChange}
            options={[
              { id: "jpeg", label: i18n.formatJpeg },
              { id: "png", label: i18n.formatPng },
              { id: "webp", label: i18n.formatWebp },
              { id: "same", label: i18n.formatSame },
            ]}
          />
        </Field>
      </div>
    </section>
  );
}
