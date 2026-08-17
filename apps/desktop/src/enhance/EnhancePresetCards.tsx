import type { Messages } from "../i18n";
import type { Preset } from "./enhanceViewModel";

type Props = {
  i18n: Messages;
  value: Preset;
  onChange: (p: Preset) => void;
};

type PresetCard = {
  id: Preset;
  title: string;
  desc: string;
  /** 资源等级：直观表达耗时/占用 */
  level: string;
  recommended?: boolean;
};

/** 质量预设：从三个圆角按钮升级为带说明的方案卡片 */
export function EnhancePresetCards({ i18n, value, onChange }: Props) {
  const presets: PresetCard[] = [
    {
      id: "fast",
      title: i18n.presetFast,
      desc: i18n.presetFastDesc,
      level: i18n.presetLevelFast,
    },
    {
      id: "balanced",
      title: i18n.presetBalanced,
      desc: i18n.presetBalancedDesc,
      level: i18n.presetLevelBalanced,
      recommended: true,
    },
    {
      id: "quality",
      title: i18n.presetQuality,
      desc: i18n.presetQualityDesc,
      level: i18n.presetLevelQuality,
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-2.5">
      {presets.map((p) => {
        const active = value === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(p.id)}
            aria-pressed={active}
            className={`relative rounded-xl border p-3 text-left transition ${
              active
                ? "border-accent bg-accent/10 dark:bg-accent/15"
                : "border-ink-200 bg-ink-50 hover:border-ink-300 hover:bg-ink-100 dark:border-white/[0.08] dark:bg-surface-raised dark:hover:bg-surface-high"
            }`}
          >
            {p.recommended && (
              <span
                className={`absolute right-2 top-2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                  active
                    ? "bg-accent text-white"
                    : "bg-ink-200 text-ink-600 dark:bg-surface-high dark:text-fg-muted"
                }`}
              >
                {i18n.presetBadge}
              </span>
            )}
            <p
              className={`text-sm font-semibold ${
                active ? "text-ink-900 dark:text-fg" : "text-ink-800 dark:text-fg"
              }`}
            >
              {p.title}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-ink-500 dark:text-fg-muted">{p.desc}</p>
            <p
              className={`mt-1.5 text-[11px] font-medium ${
                active ? "text-accent" : "text-ink-400 dark:text-fg-muted"
              }`}
            >
              {p.level}
            </p>
          </button>
        );
      })}
    </div>
  );
}
