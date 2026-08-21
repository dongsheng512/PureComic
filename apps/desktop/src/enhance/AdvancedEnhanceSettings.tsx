import { useState } from "react";
import type { Messages } from "../i18n";
import { Field, SelectBox } from "./controls";

type Props = {
  i18n: Messages;
  engineId: string;
  noise: -1 | 0 | 1 | 2 | 3;
  onNoiseChange: (n: -1 | 0 | 1 | 2 | 3) => void;
};

/** 高级设置：降噪，默认折叠 */
export function AdvancedEnhanceSettings({
  i18n,
  engineId,
  noise,
  onNoiseChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const isCugan = engineId === "realcugan-coreml" || engineId === "realcugan";
  const noiseOptions = isCugan
    ? [
        { id: "0", label: i18n.noiseConservative },
        { id: "1", label: i18n.noise1 },
        { id: "2", label: i18n.noise2 },
        { id: "3", label: i18n.noise3 },
      ]
    : [
        { id: "0", label: i18n.noise0 },
        { id: "1", label: i18n.noise1 },
        { id: "2", label: i18n.noise2 },
        { id: "3", label: i18n.noise3 },
      ];
  const noiseLabel = noiseOptions.find((o) => o.id === String(noise))?.label ?? "";
  const summaryParts: string[] = [];
  if (noiseLabel) summaryParts.push(`${i18n.noise} ${noiseLabel}`);

  return (
    <div className="rounded-xl border border-ink-200 dark:border-white/[0.08]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left"
      >
        <span className="label shrink-0">{i18n.advancedSettings}</span>
        {!open && (
          <span className="min-w-0 flex-1 truncate text-right text-[11px] text-ink-500 dark:text-fg-muted">
            {summaryParts.join(" · ")}
          </span>
        )}
        <svg
          viewBox="0 0 20 20"
          className={`h-4 w-4 text-ink-400 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <path
            fill="currentColor"
            d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.58l3.3-3.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.42Z"
          />
        </svg>
      </button>
      {open && (
        <div className="space-y-4 border-t border-ink-200 px-3.5 py-4 dark:border-white/[0.08]">
          <Field
            label={i18n.noise}
            hint={isCugan ? i18n.noiseHintCugan : i18n.noiseHint}
          >
            <SelectBox
              value={String(noise < 0 ? 0 : noise)}
              onChange={(v) => onNoiseChange(Number(v) as -1 | 0 | 1 | 2 | 3)}
              options={noiseOptions}
            />
          </Field>
        </div>
      )}
    </div>
  );
}
