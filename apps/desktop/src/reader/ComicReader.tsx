import type { Messages } from "../i18n";
import type { JobStatus, LibraryEntry } from "../types";
import { ReaderView } from "./ReaderView";

/** 从书库 / 增强 / 队列 / 系统外部打开时传入的会话数据 */
export type ReaderSession = {
  /** 漫画文件或文件夹路径 */
  source: string;
  /** 关联增强任务（可选） */
  jobId?: string | null;
  /** 展示标题 */
  title?: string;
  /** 完整书库条目（从书库卡片下钻时带上） */
  entry?: LibraryEntry;
  /** 打开来源，便于返回文案与逻辑 */
  from?: "library" | "enhance" | "queue" | "external";
  /**
   * 临时阅读：不自动写入书库。
   * 退出时若路径不在书库，可提示导入。
   */
  temporary?: boolean;
};

type Props = {
  session: ReaderSession;
  jobs: JobStatus[];
  i18n: Messages;
  onClose: () => void;
  onError: (msg: string | null) => void;
  onImmersiveChange?: (immersive: boolean) => void;
  onPickedSource?: (path: string) => void;
};

/**
 * 独立全屏阅读器：从 Tab 抽离，由书库卡片下钻或其它入口打开。
 * 提供返回书库与 Esc 退出（由内部 ReaderView 在非全屏/非藏栏时触发 onClose）。
 */
export function ComicReader({
  session,
  jobs,
  i18n,
  onClose,
  onError,
  onImmersiveChange,
  onPickedSource,
}: Props) {
  const source = session.entry?.path ?? session.source;
  const jobId = session.entry?.jobId ?? session.jobId ?? null;
  const bookTitle = session.entry?.title ?? session.title ?? null;
  const backLabel =
    session.from === "enhance"
      ? i18n.readerBackEnhance
      : session.from === "queue"
        ? i18n.readerBackQueue
        : session.from === "external" || session.temporary
          ? i18n.readerBackLibrary
          : i18n.readerBackLibrary;

  return (
    <div className="relative flex h-full min-h-0 w-full flex-1 flex-col bg-black">
      <ReaderView
        jobs={jobs}
        source={source}
        requestedJobId={jobId}
        bookTitle={bookTitle}
        temporary={Boolean(session.temporary || session.from === "external")}
        i18n={i18n}
        backLabel={backLabel}
        onClose={onClose}
        onError={onError}
        onImmersiveChange={onImmersiveChange}
        onPickedSource={onPickedSource}
      />
    </div>
  );
}
