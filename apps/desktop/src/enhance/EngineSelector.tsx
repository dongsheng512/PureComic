import { useState } from "react";
import type { Messages } from "../i18n";
import type { EngineInfo, EngineStatus } from "../types";
import { parseAccelInfo, type AccelInfo } from "./enhanceViewModel";

/* ————— 引擎信息卡 ————— */

type EngineCard = {
  id: string;
  name: string;
  desc: string;
  maxScale: number;
  available: boolean;
  detail: string;
};

function engineCards(i18n: Messages, catalog: EngineInfo[]): EngineCard[] {
  const list = catalog.length
    ? catalog.filter((e) => e.id === "realcugan" || e.id === "waifu2x")
    : [
        { id: "realcugan", label: i18n.engineCugan, available: true, detail: "", scales: [1, 2, 3, 4], models: [] },
        { id: "waifu2x", label: i18n.engineWaifu2x, available: true, detail: "", scales: [1, 2], models: [] },
      ];
  return list.map((e) => ({
    id: e.id,
    name: e.id === "realcugan" ? "Real-CUGAN" : e.id === "waifu2x" ? "Waifu2x" : e.label,
    desc: e.id === "realcugan" ? i18n.engineCuganTag : i18n.engineWaifuTag,
    maxScale: e.scales.length ? Math.max(...e.scales) : 2,
    available: e.available,
    detail: e.detail,
  }));
}

/** 引擎选择：下拉框 → 信息卡；下方以徽章展示就绪/GPU/批处理，详情可展开 */
export function EngineSelector({
  i18n,
  catalog,
  engineId,
  cuganModel,
  fallback,
  onChange,
}: {
  i18n: Messages;
  catalog: EngineInfo[];
  engineId: string;
  cuganModel: string;
  fallback: EngineStatus | null;
  onChange: (id: string) => void;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const cards = engineCards(i18n, catalog);
  const accel: AccelInfo = parseAccelInfo(catalog, engineId, cuganModel, fallback);

  return (
    <div>
      <div className="grid grid-cols-2 gap-2.5">
        {cards.map((c) => {
          const active = engineId === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => c.available && onChange(c.id)}
              disabled={!c.available}
              aria-pressed={active}
              className={`rounded-xl border p-3 text-left transition ${
                active
                  ? "border-accent bg-accent/10 dark:bg-accent/15"
                  : c.available
                    ? "border-ink-200 bg-ink-50 hover:border-ink-300 hover:bg-ink-100 dark:border-white/[0.08] dark:bg-surface-raised dark:hover:bg-surface-high"
                    : "cursor-not-allowed border-ink-200 bg-ink-50 opacity-55 dark:border-white/[0.08] dark:bg-surface-raised"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-ink-900 dark:text-fg">{c.name}</p>
                {!c.available && (
                  <span className="rounded-md bg-rose-500/10 border border-rose-400/30 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:text-rose-200">
                    {i18n.engineNotInstalled}
                  </span>
                )}
              </div>
              <p className="mt-1 text-[11px] leading-4 text-ink-500 dark:text-fg-muted">{c.desc}</p>
              <p
                className={`mt-1.5 text-[11px] font-medium ${
                  active ? "text-accent" : "text-ink-400 dark:text-fg-muted"
                }`}
              >
                {c.available ? `${c.maxScale}× · ${i18n.gpuAccelBadge}` : `${c.maxScale}×`}
              </p>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${
            accel.ready
              ? "border-success/30 bg-success/10 text-success dark:text-emerald-100"
              : "border-rose-400/40 bg-rose-500/10 text-rose-700 dark:text-rose-200"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${accel.ready ? "bg-success" : "bg-rose-500"}`} />
          {accel.ready ? `${accel.engineLabel} ${i18n.engineReadyBadge}` : i18n.engineMissingBadge}
        </span>
        {accel.gpu && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-ink-700 dark:text-fg">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            {i18n.gpuAccelBadge}
          </span>
        )}
        {accel.mode && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-ink-200 bg-ink-100 px-2 py-0.5 text-ink-600 dark:border-white/[0.08] dark:bg-surface-raised dark:text-fg-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-ink-400 dark:bg-fg-muted" />
            {accel.mode}
          </span>
        )}
        <button
          type="button"
          aria-expanded={detailOpen}
          onClick={() => setDetailOpen((v) => !v)}
          className="ml-auto text-[11px] text-ink-500 underline-offset-2 hover:text-ink-800 hover:underline dark:text-fg-muted dark:hover:text-fg"
        >
          {i18n.detailBtn}
        </button>
      </div>

      {detailOpen && (
        <dl className="mt-2 space-y-1 rounded-xl border border-ink-200 bg-ink-50 p-3 font-mono text-[11px] dark:border-white/[0.08] dark:bg-surface-raised">
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-ink-500 dark:text-fg-muted">{i18n.detailEngine}</dt>
            <dd className="min-w-0 break-all text-ink-800 dark:text-fg">
              {accel.binary}
              {accel.ready ? "" : `（${i18n.engineNotInstalled}）`}
            </dd>
          </div>
          {accel.modelLabel && (
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-ink-500 dark:text-fg-muted">{i18n.detailModel}</dt>
              <dd className="min-w-0 break-all text-ink-800 dark:text-fg">{accel.modelLabel}</dd>
            </div>
          )}
          {accel.threads && (
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-ink-500 dark:text-fg-muted">{i18n.detailThreads}</dt>
              <dd className="min-w-0 break-all text-ink-800 dark:text-fg">{accel.threads}</dd>
            </div>
          )}
          {accel.mode && (
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-ink-500 dark:text-fg-muted">{i18n.detailMode}</dt>
              <dd className="min-w-0 break-all text-ink-800 dark:text-fg">{accel.mode}</dd>
            </div>
          )}
          {accel.rawDetail && (
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-ink-500 dark:text-fg-muted">RAW</dt>
              <dd className="min-w-0 break-all text-ink-500 dark:text-fg-muted">{accel.rawDetail}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

/* ————— 倍率按钮（带实际影响副说明） ————— */

export function ScaleSelector({
  i18n,
  scales,
  value,
  onChange,
}: {
  i18n: Messages;
  scales: number[];
  value: number;
  onChange: (s: number) => void;
}) {
  const captions: Record<number, string> = {
    1: i18n.scaleCap1,
    2: i18n.scaleCap2,
    3: i18n.scaleCap3,
    4: i18n.scaleCap4,
  };
  return (
    <div className="flex flex-wrap gap-2">
      {scales.map((s) => {
        const active = value === s;
        return (
          <button
            key={s}
            type="button"
            onClick={() => onChange(s)}
            aria-pressed={active}
            className={`flex w-[5.5rem] flex-col items-center rounded-xl border px-2 py-2 transition ${
              active
                ? "border-accent bg-accent/10 dark:bg-accent/15"
                : "border-ink-200 bg-ink-50 hover:border-ink-300 hover:bg-ink-100 dark:border-white/[0.08] dark:bg-surface-raised dark:hover:bg-surface-high"
            }`}
          >
            <span
              className={`text-sm font-semibold tabular-nums ${
                active ? "text-accent" : "text-ink-800 dark:text-fg"
              }`}
            >
              {s}×
            </span>
            <span className="mt-0.5 block h-3 text-center text-[10px] leading-3 text-ink-500 dark:text-fg-muted">
              {captions[s] ?? ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}
