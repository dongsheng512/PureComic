import { useState } from "react";
import type { Messages } from "../i18n";
import type { EngineInfo } from "../types";
import { Field, Segmented, SelectBox } from "./controls";

type Props = {
  i18n: Messages;
  engineId: string;
  catalog: EngineInfo[];
  cuganModel: string;
  noise: -1 | 0 | 1 | 2 | 3;
  tta: boolean;
  onCuganModelChange: (id: string) => void;
  onNoiseChange: (n: -1 | 0 | 1 | 2 | 3) => void;
  onTtaChange: (v: boolean) => void;
};

/** 高级设置：CUGAN 模型 / 降噪 / TTA，默认折叠，不干扰主路径 */
export function AdvancedEnhanceSettings({
  i18n,
  engineId,
  catalog,
  cuganModel,
  noise,
  tta,
  onCuganModelChange,
  onNoiseChange,
  onTtaChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const isCugan = engineId === "realcugan";
  const models =
    catalog.find((e) => e.id === engineId)?.models ??
    (isCugan ? [{ id: "se", label: "SE" }] : [{ id: "cunet", label: "CUnet" }]);
  const noiseOptions = [
    { id: "-1", label: isCugan ? i18n.noiseConservative : i18n.noiseOff },
    { id: "0", label: i18n.noise0 },
    { id: "1", label: i18n.noise1 },
    { id: "2", label: i18n.noise2 },
    { id: "3", label: i18n.noise3 },
  ];
  // 折叠时展示当前高级参数摘要，免展开即可确认
  const noiseLabel = noiseOptions.find((o) => o.id === String(noise))?.label ?? "";
  const summaryParts: string[] = [];
  if (isCugan) {
    summaryParts.push(
      models.find((m) => m.id === cuganModel)?.label ?? cuganModel.toUpperCase(),
    );
  }
  if (noiseLabel) summaryParts.push(`${i18n.noise} ${noiseLabel}`);
  summaryParts.push(`TTA ${tta ? i18n.ttaOn : i18n.ttaOff}`);

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
          {isCugan && (
            <Field label={i18n.cuganPack} hint={i18n.cuganPackHint}>
              <Segmented
                value={cuganModel}
                onChange={onCuganModelChange}
                options={models.map((m) => ({ id: m.id, label: m.label }))}
              />
            </Field>
          )}
          <Field
            label={i18n.noise}
            hint={isCugan ? i18n.noiseHintCugan : i18n.noiseHint}
          >
            <SelectBox
              value={String(noise)}
              onChange={(v) => onNoiseChange(Number(v) as -1 | 0 | 1 | 2 | 3)}
              options={noiseOptions}
            />
          </Field>
          <Field label={i18n.tta} hint={i18n.ttaCostHint}>
            <Segmented
              value={tta ? "on" : "off"}
              onChange={(v) => onTtaChange(v === "on")}
              options={[
                { id: "off", label: i18n.ttaOff },
                { id: "on", label: i18n.ttaOn },
              ]}
            />
          </Field>
        </div>
      )}
    </div>
  );
}
