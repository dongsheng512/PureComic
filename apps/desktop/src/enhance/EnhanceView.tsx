import type { Messages } from "../i18n";
import type {
  DiskEstimate,
  EngineInfo,
  EngineStatus,
  JobStatus,
  LibraryEntry,
  ResumeHint,
  ValidateResult,
} from "../types";
import { AdvancedEnhanceSettings } from "./AdvancedEnhanceSettings";
import { EngineSelector, ScaleSelector } from "./EngineSelector";
import { EnhancePresetCards } from "./EnhancePresetCards";
import { EnhanceSummaryBar } from "./EnhanceSummaryBar";
import { OutputSettings } from "./OutputSettings";
import { SourceDropCard } from "./SourceDropCard";
import { Field } from "./controls";
import type { Container, ImgFmt, Preset } from "./enhanceViewModel";

export type EnhanceViewProps = {
  i18n: Messages;
  // 源文件
  source: string | null;
  sourceEntry: LibraryEntry | null;
  sourceLoading: boolean;
  validation: ValidateResult | null;
  estimate: DiskEstimate | null;
  estimateLoading: boolean;
  resumeHint: ResumeHint | null;
  dragOver: boolean;
  // 输出
  outputDir: string | null;
  container: Container;
  imageFormat: ImgFmt;
  // 增强方案
  preset: Preset;
  engineId: string;
  cuganModel: string;
  catalog: EngineInfo[];
  scale: number;
  noise: -1 | 0 | 1 | 2 | 3;
  tta: boolean;
  engine: EngineStatus | null;
  busy: boolean;
  activeJob: JobStatus | null;
  canStart: boolean;
  engineReady: boolean;
  /** 任务创建成功的轻反馈（底部栏短暂显示） */
  taskCreated?: boolean;
  // 回调
  onPickFile: () => void;
  onPickFolder: () => void;
  onPickOutput: () => void;
  onOpenReader: () => void;
  onPresetChange: (p: Preset) => void;
  onEngineChange: (id: string) => void;
  onCuganModelChange: (id: string) => void;
  onScaleChange: (s: number) => void;
  onNoiseChange: (n: -1 | 0 | 1 | 2 | 3) => void;
  onTtaChange: (v: boolean) => void;
  onContainerChange: (c: Container) => void;
  onImageFormatChange: (f: ImgFmt) => void;
  onStart: () => void;
  onOpenQueue: () => void;
  onCancelJob: (id: string) => void;
};

/**
 * 三段式增强工作台：
 * 左 = 源文件 + 输出；右 = 核心增强方案（高级参数默认折叠）；底部 = 资源预估与提交。
 */
export function EnhanceView(props: EnhanceViewProps) {
  const { i18n } = props;
  const scales =
    props.catalog.find((e) => e.id === props.engineId)?.scales ?? [1, 2];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto pb-1 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <SourceDropCard
            i18n={i18n}
            source={props.source}
            entry={props.sourceEntry}
            validation={props.validation}
            loading={props.sourceLoading}
            dragOver={props.dragOver}
            resumeHint={props.resumeHint}
            onPickFile={props.onPickFile}
            onPickFolder={props.onPickFolder}
            onOpenReader={props.onOpenReader}
          />
          <OutputSettings
            i18n={i18n}
            outputDir={props.outputDir}
            container={props.container}
            imageFormat={props.imageFormat}
            onPickOutput={props.onPickOutput}
            onContainerChange={props.onContainerChange}
            onImageFormatChange={props.onImageFormatChange}
            fill={!!props.source}
          />
        </div>

        <section className="card flex min-w-0 flex-col gap-5 p-5">
          <div>
            <p className="label mb-2.5">{i18n.enhancePlanSection}</p>
            <EnhancePresetCards i18n={i18n} value={props.preset} onChange={props.onPresetChange} />
          </div>
          <div>
            <p className="label mb-2.5">{i18n.engine}</p>
            <EngineSelector
              i18n={i18n}
              catalog={props.catalog}
              engineId={props.engineId}
              cuganModel={props.cuganModel}
              fallback={props.engine}
              onChange={props.onEngineChange}
            />
          </div>
          <Field label={i18n.scale} hint={i18n.scaleHint}>
            <ScaleSelector
              i18n={i18n}
              scales={scales}
              value={props.scale}
              onChange={props.onScaleChange}
            />
          </Field>
          <div className="mt-auto">
            <AdvancedEnhanceSettings
              i18n={i18n}
              engineId={props.engineId}
              catalog={props.catalog}
              cuganModel={props.cuganModel}
              noise={props.noise}
              tta={props.tta}
              onCuganModelChange={props.onCuganModelChange}
              onNoiseChange={props.onNoiseChange}
              onTtaChange={props.onTtaChange}
            />
          </div>
        </section>
      </div>

      <EnhanceSummaryBar
        i18n={i18n}
        estimate={props.estimate}
        outputDir={props.outputDir}
        container={props.container}
        imageFormat={props.imageFormat}
        source={props.source}
        sourceLoading={props.sourceLoading}
        validation={props.validation}
        estimateLoading={props.estimateLoading}
        engineReady={props.engineReady}
        canStart={props.canStart}
        busy={props.busy}
        taskCreated={props.taskCreated}
        activeJob={props.activeJob}
        onStart={props.onStart}
        onOpenReader={props.onOpenReader}
        onOpenQueue={props.onOpenQueue}
        onCancelJob={props.onCancelJob}
      />
    </div>
  );
}
