import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { comicFileFilter, isComicPath } from "./formats";
import {
  cancelJob,
  clearFinishedJobs,
  createJob,
  doctor as fetchDoctor,
  estimateDisk,
  probeResume,
  exportDiagnostics,
  getEngineStatus,
  listEngines,
  listJobs,
  onJobProgress,
  openOutputFolder,
  listLibrary,
  addLibraryPath,
  removeLibraryEntry,
  previewLibraryScan,
  importLibraryPaths,
  removeJob,
  validateSource,
  takePendingOpenPaths,
  validateExternalOpenPath,
} from "./api";
import {
  loadExternalOpenRemember,
  saveExternalOpenRemember,
  titleFromPath,
} from "./externalOpen";
import { stateLabel, t, type Messages } from "./i18n";
import { loadReaderBg, readerBgPreset } from "./reader/prefs";
import { EnhanceView } from "./enhance/EnhanceView";
import {
  formatBytes,
  type Container,
  type ImgFmt,
  type Preset,
} from "./enhance/enhanceViewModel";
import { LibraryView, pickComicFiles, pickFolder } from "./library/LibraryView";
import { loadImportSettings, saveImportSettings } from "./library/prefs";
import { ComicReader, type ReaderSession } from "./reader/ComicReader";
import { rememberMainWindowGeometry, restoreMainWindowGeometry } from "./reader/smartFit";
import { setNativeWindowBg, startWindowDrag } from "./windowDrag";
import type {
  DiskEstimate,
  DoctorReport,
  EngineInfo,
  EngineStatus,
  JobState,
  JobStatus,
  LibraryEntry,
  LibraryScanPreview,
  ResumeHint,
  ValidateResult,
} from "./types";

type Tab = "library" | "enhance" | "doctor";
type Theme = "dark" | "light";

const THEME_KEY = "comic.theme";

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

const THEME_BG = { light: "#FFFFFF", dark: "#212121" } as const;

function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function fillMsg(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
}

function findLibraryByPath(list: LibraryEntry[], path: string): LibraryEntry | undefined {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const n = norm(path);
  return list.find((e) => norm(e.path) === n);
}

function noticeForUpsert(i18n: Messages, before: LibraryEntry | undefined, entry: LibraryEntry): string {
  if (!before) {
    return fillMsg(i18n.libraryNoticeAdded, { title: entry.title, pages: entry.pageCount });
  }
  if (before.pageCount !== entry.pageCount) {
    return fillMsg(i18n.libraryNoticeUpdated, {
      title: entry.title,
      from: before.pageCount,
      to: entry.pageCount,
    });
  }
  return fillMsg(i18n.libraryNoticeExists, { title: entry.title, pages: entry.pageCount });
}

function applyTheme(theme: Theme) {
  const bg = THEME_BG[theme];
  const reading = document.documentElement.hasAttribute("data-reader-open");
  const nativeBg = reading ? readerBgPreset(loadReaderBg()).hex : bg;
  document.documentElement.classList.toggle("dark", theme === "dark");
  // html/body remain on the application theme; the reader root owns its canvas color.
  document.documentElement.style.backgroundColor = bg;
  if (document.body) document.body.style.backgroundColor = bg;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
  setNativeWindowBg(nativeBg);
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/** 进行中的任务状态（空闲时轮询退避，避免常驻全量重渲染） */
const ACTIVE_JOB_STATES: readonly JobState[] = [
  "pending",
  "validating",
  "extracting",
  "running",
  "finalizing",
  "cancelling",
];

/** jobs 列表浅比较：仅关注影响 UI 的字段 */
function jobsEqual(a: JobStatus[], b: JobStatus[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.jobId !== y.jobId ||
      x.state !== y.state ||
      x.pagesDone !== y.pagesDone ||
      x.pagesTotal !== y.pagesTotal ||
      x.stage !== y.stage ||
      x.error !== y.error ||
      x.outputPath !== y.outputPath
    ) {
      return false;
    }
  }
  return true;
}

export default function App() {
  const i18n = t();
  const [tab, setTab] = useState<Tab>("library");
  const [source, setSource] = useState<string | null>(null);
  /** 源文件对应的书库条目：紧凑信息卡展示封面 / 标题用 */
  const [sourceEntry, setSourceEntry] = useState<LibraryEntry | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const sourceRequestRef = useRef(0);
  /** 任务创建成功的轻反馈时间戳（底部栏显示 3s「增强任务已创建」） */
  const [taskCreatedAt, setTaskCreatedAt] = useState(0);
  // 记忆上次输出目录，避免每次重启重选
  const [outputDir, setOutputDir] = useState<string | null>(() => {
    try {
      return localStorage.getItem("comic.outputDir");
    } catch {
      return null;
    }
  });
  const [preset, setPreset] = useState<Preset>("balanced");
  const [engineId, setEngineId] = useState("realcugan");
  const [cuganModel, setCuganModel] = useState("se");
  const [catalog, setCatalog] = useState<EngineInfo[]>([]);
  const [scale, setScale] = useState<number>(2);
  const [noise, setNoise] = useState<-1 | 0 | 1 | 2 | 3>(1);
  const [tta, setTta] = useState(false);
  const [container, setContainer] = useState<Container>("cbz");
  const [imageFormat, setImageFormat] = useState<ImgFmt>("jpeg");
  const [validation, setValidation] = useState<ValidateResult | null>(null);
  const [estimate, setEstimate] = useState<DiskEstimate | null>(null);
  const [estimateLoading, setEstimateLoading] = useState(false);
  const [resumeHint, setResumeHint] = useState<ResumeHint | null>(null);
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  /** 独立阅读器会话；非 null 时全屏展示 ComicReader，隐藏主导航 */
  const [readerSession, setReaderSession] = useState<ReaderSession | null>(null);
  const reading = readerSession != null;
  /** 阅读器全屏接管：隐藏应用顶栏；阅读器内部再处理沉浸工具栏 */
  const hideAppChrome = reading;
  /** 临时阅读退出时：是否导入书库 */
  const [importPrompt, setImportPrompt] = useState<{
    path: string;
    title: string;
  } | null>(null);
  const [importRemember, setImportRemember] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const libraryRef = useRef<LibraryEntry[]>([]);
  const readerSessionRef = useRef<ReaderSession | null>(null);

  const openReader = useCallback((session: ReaderSession) => {
    // 阅读内改窗前先记下主界面几何，返回时还原
    void rememberMainWindowGeometry();
    setReaderSession(session);
    readerSessionRef.current = session;
    setError(null);
    setImportPrompt(null);
  }, []);

  const pathInLibrary = useCallback((path: string) => {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
    const n = norm(path);
    return libraryRef.current.some((e) => {
      const ep = norm(e.path);
      // 全等，或互为祖先/后代（按路径段边界，避免 /Users/a/X 误匹配 /Volumes/b/X）
      return ep === n || ep.startsWith(n + "/") || n.startsWith(ep + "/");
    });
  }, []);

  const [readerPrefsRev, setReaderPrefsRev] = useState(0);

  const finishCloseReader = useCallback(() => {
    setReaderSession(null);
    readerSessionRef.current = null;
    setImportPrompt(null);
    setImportRemember(false);
    setReaderPrefsRev((n) => n + 1);
    void restoreMainWindowGeometry();
  }, []);

  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [diagPath, setDiagPath] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [libraryScan, setLibraryScan] = useState(false);
  const [libraryImporting, setLibraryImporting] = useState(false);
  const [libraryImportProgress, setLibraryImportProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null);
  const [scanPreview, setScanPreview] = useState<LibraryScanPreview | null>(null);

  useEffect(() => {
    if (!libraryNotice || libraryImporting) return;
    const timer = window.setTimeout(() => setLibraryNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [libraryNotice, libraryImporting]);

  const refreshLibrary = useCallback(async () => {
    try {
      const list = await listLibrary();
      setLibrary(list);
      libraryRef.current = list;
    } catch {
      /* backend not ready */
    }
  }, []);

  const closeReader = useCallback(() => {
    const session = readerSessionRef.current;
    if (!session) {
      finishCloseReader();
      return;
    }
    const isTemp = Boolean(session.temporary || session.from === "external");
    const path = session.entry?.path ?? session.source;
    if (!isTemp || !path || pathInLibrary(path)) {
      finishCloseReader();
      return;
    }
    const remembered = loadExternalOpenRemember();
    if (remembered === "discard") {
      finishCloseReader();
      return;
    }
    if (remembered === "import") {
      setImportBusy(true);
      void addLibraryPath(path)
        .then(() => refreshLibrary())
        .catch((e) => setError(errMsg(e)))
        .finally(() => {
          setImportBusy(false);
          finishCloseReader();
        });
      return;
    }
    setImportPrompt({ path, title: session.title || titleFromPath(path) });
  }, [finishCloseReader, pathInLibrary, refreshLibrary]);

  const ingestPath = useCallback(
    async (path: string): Promise<LibraryEntry | null> => {
      setError(null);
      setLibraryImporting(true);
      setLibraryImportProgress(null);
      await yieldToPaint();
      try {
        const before = findLibraryByPath(libraryRef.current, path);
        const entry = await addLibraryPath(path);
        await refreshLibrary();
        setLibraryNotice(noticeForUpsert(i18n, before, entry));
        return entry;
      } catch {
        try {
          setLibraryScan(true);
          const preview = await previewLibraryScan(path);
          setScanPreview(preview);
          setTab("library");
        } catch (e) {
          setError(errMsg(e));
        } finally {
          setLibraryScan(false);
        }
        return null;
      } finally {
        setLibraryImporting(false);
      }
    },
    [i18n, refreshLibrary],
  );

  const refreshJobs = useCallback(async () => {
    try {
      const list = await listJobs();
      // 浅比较：无变化时不触发 setState，避免空闲状态 1.5s 一次全量重渲染
      setJobs((prev) => (jobsEqual(prev, list) ? prev : list));
    } catch {
      /* backend not ready */
    }
  }, []);

  const jobsActive = jobs.some((j) => ACTIVE_JOB_STATES.includes(j.state));

  const refreshDoctor = useCallback(async () => {
    try {
      setDoctorReport(await fetchDoctor());
      setEngine((await getEngineStatus().catch(() => null)) ?? null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  const openExternalPath = useCallback(
    async (raw: string) => {
      try {
        const path = await validateExternalOpenPath(raw);
        openReader({
          source: path,
          title: titleFromPath(path),
          from: "external",
          temporary: true,
          jobId: null,
        });
        setSource(path);
        setTab("library");
      } catch (e) {
        setError(errMsg(e));
      }
    },
    [openReader],
  );

  // 外部打开：启动参数 + 运行中二次打开
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const pending = await takePendingOpenPaths();
        if (!cancelled && pending[0]) await openExternalPath(pending[0]);
      } catch {
        /* not in tauri */
      }
      try {
        unlisten = await listen<string[]>("app://open-paths", (ev) => {
          const paths = ev.payload ?? [];
          if (paths[0]) void openExternalPath(paths[0]);
        });
      } catch {
        /* browser */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [openExternalPath]);

  // 监控目录：进入应用时轻量自动扫描并导入新书
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { watchFolders } = loadImportSettings();
      if (watchFolders.length === 0) return;
      for (const root of watchFolders) {
        if (cancelled) return;
        try {
          const preview = await previewLibraryScan(root);
          const fresh = preview.candidates
            .filter((c) => !c.alreadyInLibrary)
            .map((c) => c.path);
          if (fresh.length === 0) continue;
          const r = await importLibraryPaths(fresh);
          if (!cancelled && r.added > 0) {
            setLibraryNotice(r.message);
            await refreshLibrary();
          }
        } catch {
          /* watch is best-effort */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshLibrary]);

  useEffect(() => {
    refreshLibrary();
    refreshJobs();
    getEngineStatus()
      .then(setEngine)
      .catch(() =>
        setEngine({
          id: "mock",
          available: true,
          detail: "dev",
          version: "0.2.0-mock",
        }),
      );
    listEngines()
      .then((c) => {
        setCatalog(c);
        const savedRaw = localStorage.getItem("comic.engine");
        const saved =
          savedRaw === "realcugan" || savedRaw === "waifu2x" ? savedRaw : null;
        const savedModel = localStorage.getItem("comic.cuganModel");
        const batch = c.filter(
          (e) => e.id === "realcugan" || e.id === "waifu2x",
        );
        const pick =
          batch.find((e) => e.id === saved && e.available) ??
          batch.find((e) => e.id === "realcugan" && e.available) ??
          batch.find((e) => e.available) ??
          batch[0];
        if (pick) {
          if (saved !== pick.id) {
            try {
              localStorage.setItem("comic.engine", pick.id);
            } catch {
              /* ignore */
            }
          }
          setEngineId(pick.id);
          const mid =
            savedModel && pick.models.some((m) => m.id === savedModel)
              ? savedModel
              : pick.models.find((m) => m.id === "nose")?.id ??
                pick.models[0]?.id ??
                "nose";
          setCuganModel(mid);
        }
      })
      .catch(() => undefined);
    const timer = setInterval(
      refreshJobs,
      jobsActive ? 1500 : 15000, // 空闲时低频兜底轮询
    );
    let unlisten: (() => void) | undefined;
    onJobProgress(() => {
      refreshJobs();
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      clearInterval(timer);
      unlisten?.();
    };
  }, [refreshJobs, refreshLibrary, jobsActive]);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (tab === "doctor") refreshDoctor();
  }, [tab, refreshDoctor]);

  useEffect(() => {
    if (!queueOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setQueueOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queueOpen]);

  const applySource = useCallback(async (path: string) => {
    const requestId = ++sourceRequestRef.current;
    setError(null);
    setSource(path);
    setSourceEntry(null);
    // 立即清掉上一本的校验/预估，避免新书短暂显示旧数据
    setValidation(null);
    setEstimate(null);
    setEstimateLoading(false);
    setResumeHint(null);
    setSourceLoading(true);
    void ingestPath(path).then((entry) => {
      // 快速切换文件时，旧请求不能覆盖当前源文件的信息卡
      if (requestId === sourceRequestRef.current) setSourceEntry(entry);
    });
    try {
      const v = await validateSource(path);
      if (requestId !== sourceRequestRef.current) return;
      setValidation(v);
      const hint = await probeResume(path).catch(() => null);
      if (requestId === sourceRequestRef.current) setResumeHint(hint);
    } catch (e) {
      if (requestId === sourceRequestRef.current) setError(errMsg(e));
    } finally {
      if (requestId === sourceRequestRef.current) setSourceLoading(false);
    }
  }, [ingestPath]);

  // 磁盘预估：源文件或倍率变化后（去抖）重新计算
  useEffect(() => {
    if (!source) {
      setEstimate(null);
      setEstimateLoading(false);
      return;
    }
    let cancelled = false;
    setEstimateLoading(true);
    const timer = setTimeout(() => {
      estimateDisk(source, scale)
        .then((e) => {
          if (cancelled) return;
          setEstimate(e);
          setEstimateLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setEstimate(null);
          setEstimateLoading(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source, scale]);

  /** Prefer CBZ/ZIP files over random paths; accept directories. */
  const pickDroppedPath = (paths: string[]): string | null => {
    if (!paths.length) return null;
    const comic = paths.find((p) => isComicPath(p));
    if (comic) return comic;
    // folder or other path — backend detects kind
    return paths[0] ?? null;
  };

  // Tauri native drag-drop → real filesystem paths
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const webview = getCurrentWebview();
        unlisten = await webview.onDragDropEvent((event) => {
          if (cancelled) return;
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            setDragOver(true);
          } else if (payload.type === "leave") {
            setDragOver(false);
          } else if (payload.type === "drop") {
            setDragOver(false);
            const paths = payload.paths ?? [];
            const path = pickDroppedPath(paths);
            if (!path) {
              setError("未能从拖放获取有效路径");
              return;
            }
            void ingestPath(path);
            if (reading) {
              const current = readerSessionRef.current;
              const next: ReaderSession = current
                ? {
                    ...current,
                    source: path,
                    jobId: null,
                    entry: undefined,
                    title: undefined,
                  }
                : { source: path, from: "library" as const };
              setReaderSession(next);
              readerSessionRef.current = next;
            } else if (tab === "enhance") {
              void applySource(path);
            } else {
              setTab("library");
            }
          }
        });
      } catch {
        // Browser-only / vite without tauri: ignore
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applySource, ingestPath, tab, reading]);

  const pickSource = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        comicFileFilter("Comic / Ebook"),
        { name: "All", extensions: ["*"] },
      ],
    });
    if (typeof selected === "string") await applySource(selected);
  };

  const pickSourceFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") await applySource(selected);
  };

  const pickOutput = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      setOutputDir(selected);
      try {
        localStorage.setItem("comic.outputDir", selected);
      } catch {
        /* ignore */
      }
    }
  };

  // 「增强任务已创建」反馈 3 秒后自动消失
  useEffect(() => {
    if (!taskCreatedAt) return;
    const timer = setTimeout(() => setTaskCreatedAt(0), 3000);
    return () => clearTimeout(timer);
  }, [taskCreatedAt]);

  /** 当前源文件对应的进行中任务：底部操作栏切换为进度模式 */
  const activeSourceJob = useMemo(
    () =>
      source
        ? ([...jobs]
            .reverse()
            .find(
              (j) => j.source === source && ACTIVE_JOB_STATES.includes(j.state),
            ) ?? null)
        : null,
    [jobs, source],
  );

  const engineReady = catalog.length
    ? (catalog.find((e) => e.id === engineId)?.available ?? false)
    : true;

  const canStart = useMemo(
    () =>
      !!source &&
      !!outputDir &&
      !!validation &&
      !busy &&
      engineReady &&
      !estimateLoading &&
      !!estimate?.ok,
    [source, outputDir, validation, busy, engineReady, estimateLoading, estimate],
  );

  const onPresetChange = useCallback((p: Preset) => {
    setPreset(p);
    if (p === "fast") {
      setNoise(0);
      setTta(false);
    } else if (p === "quality") {
      setNoise(2);
      setTta(false);
    } else {
      setNoise(1);
      setTta(false);
    }
  }, []);

  const onEngineChange = useCallback(
    (id: string) => {
      const info = catalog.find((e) => e.id === id);
      setEngineId(id);
      try {
        localStorage.setItem("comic.engine", id);
      } catch {
        /* ignore */
      }
      const scales = info?.scales ?? [1, 2];
      setScale((prev) =>
        scales.includes(prev) ? prev : scales.includes(2) ? 2 : scales[0] ?? 2,
      );
      if (id === "realcugan") {
        const mid =
          info?.models.find((m) => m.id === "nose")?.id ??
          info?.models[0]?.id ??
          "nose";
        const keep = info?.models.some((m) => m.id === cuganModel);
        const next = keep ? cuganModel : mid;
        setCuganModel(next);
        try {
          localStorage.setItem("comic.cuganModel", next);
        } catch {
          /* ignore */
        }
      }
    },
    [catalog, cuganModel],
  );

  const onCuganModelChange = useCallback((id: string) => {
    setCuganModel(id);
    try {
      localStorage.setItem("comic.cuganModel", id);
    } catch {
      /* ignore */
    }
  }, []);

  const openSourceReader = useCallback(() => {
    if (!source) return;
    openReader({
      source,
      jobId: jobs.find((j) => j.source === source)?.jobId ?? null,
      from: "enhance",
    });
  }, [openReader, source, jobs]);

  const onCancelJob = useCallback(
    (id: string) => {
      cancelJob(id)
        .then(refreshJobs)
        .catch((e) => setError(`取消失败: ${errMsg(e)}`));
    },
    [refreshJobs],
  );

  const start = async () => {
    if (!source || !outputDir) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createJob({
        source,
        engine: engineId,
        preset,
        output: {
          dir: outputDir,
          container,
          imageFormat,
          jpegQuality: 92,
        },
        enhance: { scale, noiseLevel: noise, tta, cuganModel },
      });
      // Real-CUGAN 等引擎会归一化参数（如 1×→2×、Pro 包 noise→3）：
      // 以返回的实际值为准回写 UI，任务消息里会显示归一化说明
      if (created.actualScale && created.actualScale !== scale) {
        setScale(created.actualScale);
      }
      if (
        created.actualNoise !== undefined &&
        (created.actualNoise === -1 ||
          created.actualNoise === 0 ||
          created.actualNoise === 1 ||
          created.actualNoise === 2 ||
          created.actualNoise === 3) &&
        created.actualNoise !== noise
      ) {
        setNoise(created.actualNoise);
      }
      await refreshJobs();
      setTab("enhance");
      setTaskCreatedAt(Date.now());
      // 提交后留在增强页：底部操作栏切换为轻量进度条，用户可随时打开队列
      if (created.resumed && created.nextPage) {
        setResumeHint(null);
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const onExportDiag = async () => {
    setError(null);
    try {
      const { zipPath } = await exportDiagnostics();
      setDiagPath(zipPath);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: "library", label: i18n.tabLibrary },
    { id: "enhance", label: i18n.tabEnhance },
  ];
  const runningJobCount = jobs.filter((j) => canShowCancel(j.state)).length;

  const onLibAddFile = useCallback(async () => {
    const paths = await pickComicFiles();
    if (paths.length === 0) return;
    setLibraryImporting(true);
    setLibraryImportProgress({ done: 0, total: paths.length });
    setError(null);
    await yieldToPaint();
    try {
      let done = 0;
      let lastNotice: string | null = null;
      const prior = libraryRef.current;
      for (const p of paths) {
        try {
          const before = findLibraryByPath(prior, p);
          const entry = await addLibraryPath(p);
          lastNotice = noticeForUpsert(i18n, before, entry);
        } catch {
          /* single fail continues */
        }
        done += 1;
        setLibraryImportProgress({ done, total: paths.length });
      }
      await refreshLibrary();
      setLibraryNotice(paths.length === 1 ? lastNotice : `已处理 ${paths.length} 个文件`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLibraryImporting(false);
      setLibraryImportProgress(null);
    }
  }, [i18n, refreshLibrary]);

  const onLibAddFolder = useCallback(async () => {
    const p = await pickFolder();
    if (p) await ingestPath(p);
  }, [ingestPath]);

  const onLibScan = useCallback(
    async (opts?: { addToWatch?: boolean }) => {
      const p = await pickFolder();
      if (!p) return;
      if (opts?.addToWatch) {
        const settings = loadImportSettings();
        if (!settings.watchFolders.includes(p)) {
          saveImportSettings({ ...settings, watchFolders: [...settings.watchFolders, p] });
        }
      }
      setLibraryScan(true);
      setError(null);
      try {
        setScanPreview(await previewLibraryScan(p));
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setLibraryScan(false);
      }
    },
    [],
  );

  const onLibCancelScan = useCallback(() => setScanPreview(null), []);

  const onLibConfirmScan = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setLibraryImporting(true);
      setLibraryImportProgress({ done: 0, total: paths.length });
      setError(null);
      try {
        const batch = 8;
        let lastMsg = "";
        for (let i = 0; i < paths.length; i += batch) {
          const slice = paths.slice(i, i + batch);
          const r = await importLibraryPaths(slice);
          lastMsg = r.message;
          setLibraryImportProgress({ done: Math.min(paths.length, i + slice.length), total: paths.length });
        }
        setLibraryNotice(lastMsg || `已导入 ${paths.length} 本`);
        setScanPreview(null);
        await refreshLibrary();
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setLibraryImporting(false);
        setLibraryImportProgress(null);
      }
    },
    [refreshLibrary],
  );

  const onLibOpen = useCallback(
    (e: LibraryEntry) => {
      if (e.missing) return;
      setSource(e.path);
      openReader({
        source: e.path,
        jobId: e.jobId ?? null,
        title: e.title,
        entry: e,
        from: "library",
      });
    },
    [openReader],
  );

  const onLibEnhance = useCallback(
    (e: LibraryEntry) => {
      void applySource(e.path);
      setTab("enhance");
    },
    [applySource],
  );

  const onLibRemove = useCallback(
    (e: LibraryEntry) => {
      void removeLibraryEntry(e.id)
        .then(refreshLibrary)
        .catch((err) => setError(errMsg(err)));
    },
    [refreshLibrary],
  );

  const onExternalImportAdd = useCallback(async () => {
    if (!importPrompt) return;
    if (importRemember) saveExternalOpenRemember("import");
    setImportBusy(true);
    try {
      await addLibraryPath(importPrompt.path);
      await refreshLibrary();
      finishCloseReader();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setImportBusy(false);
    }
  }, [importPrompt, importRemember, refreshLibrary, finishCloseReader]);

  const onExternalImportDiscard = useCallback(() => {
    if (importRemember) saveExternalOpenRemember("discard");
    finishCloseReader();
  }, [importRemember, finishCloseReader]);

  const onExternalImportCancel = useCallback(() => {
    setImportPrompt(null);
    setImportRemember(false);
  }, []);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <header
        className={`app-topbar sticky top-0 z-10 shrink-0 ${
          hideAppChrome ? "hidden" : ""
        }`}
      >
        <div className="relative flex h-[52px] items-center">
          <div
            data-tauri-drag-region
            className="h-full w-[84px] shrink-0"
            onMouseDown={startWindowDrag}
          />
          <div
            data-tauri-drag-region
            className="flex min-w-0 items-center gap-2.5 pr-3"
            onMouseDown={startWindowDrag}
          >
            <h1 className="pointer-events-none shrink-0 text-[15px] font-semibold tracking-tight text-ink-900 dark:text-fg">
              {i18n.appName}
            </h1>
          </div>

          <nav
            aria-label="Primary"
            className="absolute left-1/2 flex h-full -translate-x-1/2 items-stretch gap-0.5 px-1"
          >
            {tabs.map((x) => {
              const active = tab === x.id;
              return (
                <button
                  key={x.id}
                  type="button"
                  onClick={() => setTab(x.id)}
                  className={`relative px-3 py-2 text-sm transition ${
                    active
                      ? "font-semibold text-ink-900 dark:text-fg"
                      : "font-normal text-ink-500 hover:text-ink-800 dark:text-fg-muted dark:hover:text-fg"
                  }`}
                >
                  {x.label}
                  {active && (
                    <span className="absolute inset-x-3 bottom-0.5 h-0.5 rounded-full bg-accent dark:bg-fg" />
                  )}
                </button>
              );
            })}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-1.5 pr-3">
            <button
              type="button"
              onClick={() => setTab("doctor")}
              title={i18n.statusMenu}
              aria-label={i18n.statusMenu}
              aria-pressed={tab === "doctor"}
              className={`btn-soft !h-[34px] !w-[34px] !p-0 ${
                tab === "doctor" ? "!bg-ink-200 !text-ink-800 dark:!bg-surface-high dark:!text-fg" : ""
              }`}
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
                <circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <path d="M10 9.1v4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <circle cx="10" cy="6.2" r=".9" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              title={i18n.themeToggle}
              aria-label={i18n.themeToggle}
              className="btn-soft !h-[34px] !w-[34px] !p-0"
            >
              {theme === "dark" ? (
                <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M10 3.2a.8.8 0 0 1 .8.8v1.2a.8.8 0 1 1-1.6 0V4a.8.8 0 0 1 .8-.8Zm0 10.2a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Zm6-3.4a.8.8 0 0 1 .8.8.8.8 0 0 1-.8.8h-1.2a.8.8 0 1 1 0-1.6H16ZM5.2 10a.8.8 0 0 1-.8.8H3.2a.8.8 0 1 1 0-1.6H4.4A.8.8 0 0 1 5.2 10Zm9.33 4.53a.8.8 0 0 1 0 1.13l-.85.85a.8.8 0 1 1-1.13-1.13l.85-.85a.8.8 0 0 1 1.13 0ZM7.45 4.34a.8.8 0 0 1 0 1.13l-.85.85A.8.8 0 1 1 5.47 5.2l.85-.85a.8.8 0 0 1 1.13 0Zm7.08.85a.8.8 0 0 1 1.13 0 .8.8 0 0 1 0 1.13l-.85.85a.8.8 0 1 1-1.13-1.13l.85-.85ZM6.6 14.53a.8.8 0 0 1 0 1.13.8.8 0 1 1-1.13-1.13l.85-.85a.8.8 0 0 1 1.13 0ZM10 14.8a.8.8 0 0 1 .8.8V16.8a.8.8 0 1 1-1.6 0V15.6a.8.8 0 0 1 .8-.8Z"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M11.3 2.2a.7.7 0 0 1 .86.9 6.6 6.6 0 1 0 4.74 4.74.7.7 0 0 1 .9.86A8 8 0 1 1 11.3 2.2Z"
                  />
                </svg>
              )}
            </button>
            <button
              type="button"
              onClick={() => setQueueOpen(true)}
              title={i18n.showQueue}
              aria-label={i18n.showQueue}
              className={`btn-soft relative !h-[34px] !w-[34px] !p-0 ${
                runningJobCount > 0
                  ? "!border-amber-400/70 !bg-amber-50 !text-amber-700 dark:!border-amber-400/40 dark:!bg-amber-400/15 dark:!text-amber-200"
                  : queueOpen
                    ? "!bg-ink-200 !text-ink-800 dark:!bg-surface-high dark:!text-fg"
                    : ""
              }`}
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M4 5.2A1.2 1.2 0 0 1 5.2 4h9.6A1.2 1.2 0 0 1 16 5.2v9.6a1.2 1.2 0 0 1-1.2 1.2H5.2A1.2 1.2 0 0 1 4 14.8V5.2Zm2.4 1.3a.7.7 0 1 0 0 1.4h7.2a.7.7 0 1 0 0-1.4H6.4Zm0 3a.7.7 0 1 0 0 1.4h7.2a.7.7 0 1 0 0-1.4H6.4Zm0 3a.7.7 0 1 0 0 1.4h4.6a.7.7 0 1 0 0-1.4H6.4Z"
                />
              </svg>
              {jobs.length > 0 && (
                <span
                  className={`absolute -right-1 -top-1 inline-flex min-h-[17px] min-w-[17px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none ${
                    runningJobCount > 0
                      ? "bg-amber-500 text-white"
                      : "bg-ink-300 text-ink-800 dark:bg-surface-high dark:text-fg"
                  }`}
                >
                  {runningJobCount || jobs.length}
                </span>
              )}
            </button>
          </div>
        </div>
      </header>

      {(engine?.id === "mock" || engine?.detail?.includes("mock") || doctorReport?.useMockEngine) &&
        !hideAppChrome && (
        <div className="bg-amber-500/10 border-b border-amber-500/20 text-amber-900 dark:text-amber-100 text-sm px-6 py-2 text-center">
          {i18n.mockBanner}
        </div>
      )}

      {error && !hideAppChrome && (
        <div className="mx-auto max-w-6xl w-full px-6 pt-4">
          <div className="rounded-xl bg-rose-500/10 border border-rose-500/30 px-4 py-3 text-sm text-rose-800 dark:text-rose-100">
            {error}
          </div>
        </div>
      )}

      {error && hideAppChrome && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-40 flex justify-center px-4">
          <div className="pointer-events-auto max-w-xl rounded-xl bg-rose-500/90 px-4 py-2 text-sm text-white shadow-lg">
            {error}
          </div>
        </div>
      )}

      <main
        className={
          reading
            ? "flex min-h-0 w-full flex-1 flex-col"
            : tab === "library" || tab === "enhance"
              ? "mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col px-6 py-4"
              : "mx-auto w-full max-w-6xl flex-1 px-6 py-4"
        }
      >
        {reading && readerSession && (
          <ComicReader
            session={readerSession}
            jobs={jobs}
            i18n={i18n}
            onClose={closeReader}
            onError={setError}
            onPickedSource={(path) => {
              // 阅读器内再开文件：仍按临时会话，不强制入库
              setSource(path);
              const next: ReaderSession = {
                source: path,
                title: titleFromPath(path),
                jobId: null,
                from: readerSession.temporary || readerSession.from === "external" ? "external" : "library",
                temporary: Boolean(readerSession.temporary || readerSession.from === "external"),
              };
              setReaderSession(next);
              readerSessionRef.current = next;
            }}
          />
        )}

        {importPrompt && (
          <ExternalImportModal
            i18n={i18n}
            title={importPrompt.title}
            path={importPrompt.path}
            remember={importRemember}
            busy={importBusy}
            onRememberChange={setImportRemember}
            onAdd={onExternalImportAdd}
            onDiscard={onExternalImportDiscard}
            onCancel={onExternalImportCancel}
          />
        )}

        {!reading && tab === "library" && (
          <div className="flex min-h-0 flex-1 flex-col">
            {libraryNotice && (
              <div className="mb-3 flex items-start gap-2 rounded-xl border border-success/25 bg-success/10 px-3 py-2 text-sm text-success dark:text-emerald-100">
                <p className="min-w-0 flex-1">{libraryNotice}</p>
                <button
                  type="button"
                  className="shrink-0 rounded-md px-1.5 text-base leading-none text-success/80 hover:bg-success/15 hover:text-success"
                  aria-label={i18n.libraryNoticeDismiss}
                  onClick={() => setLibraryNotice(null)}
                >
                  ×
                </button>
              </div>
            )}
            <LibraryView
              entries={library}
              dragOver={dragOver}
              scanning={libraryScan}
              scanPreview={scanPreview}
              importing={libraryImporting}
              importProgress={libraryImportProgress}
              i18n={i18n}
              onAddFile={onLibAddFile}
              onAddFolder={onLibAddFolder}
              onScan={onLibScan}
              onCancelScan={onLibCancelScan}
              onConfirmScan={onLibConfirmScan}
              onOpen={onLibOpen}
              onEnhance={onLibEnhance}
              onRemove={onLibRemove}
              prefsRev={readerPrefsRev}
            />
          </div>
        )}

        {!reading && tab === "enhance" && (
          <EnhanceView
            i18n={i18n}
            source={source}
            sourceEntry={sourceEntry}
            sourceLoading={sourceLoading}
            validation={validation}
            estimate={estimate}
            estimateLoading={estimateLoading}
            resumeHint={resumeHint}
            dragOver={dragOver}
            outputDir={outputDir}
            container={container}
            imageFormat={imageFormat}
            preset={preset}
            engineId={engineId}
            cuganModel={cuganModel}
            catalog={catalog}
            scale={scale}
            noise={noise}
            tta={tta}
            engine={engine}
            busy={busy}
            activeJob={activeSourceJob}
            canStart={canStart}
            engineReady={engineReady}
            taskCreated={taskCreatedAt > 0}
            onPickFile={pickSource}
            onPickFolder={pickSourceFolder}
            onPickOutput={pickOutput}
            onOpenReader={openSourceReader}
            onPresetChange={onPresetChange}
            onEngineChange={onEngineChange}
            onCuganModelChange={onCuganModelChange}
            onScaleChange={setScale}
            onNoiseChange={setNoise}
            onTtaChange={setTta}
            onContainerChange={setContainer}
            onImageFormatChange={setImageFormat}
            onStart={start}
            onOpenQueue={() => setQueueOpen(true)}
            onCancelJob={onCancelJob}
          />
        )}


        {!reading && tab === "doctor" && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-ink-900 dark:text-fg">{i18n.statusTitle}</h2>
                <p className="mt-1 text-sm text-ink-500 dark:text-fg-muted">{i18n.statusSubtitle}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-ghost" onClick={refreshDoctor}>
                  {i18n.refreshDoctor}
                </button>
                <button type="button" className="btn-primary" onClick={onExportDiag}>
                  {i18n.exportDiag}
                </button>
              </div>
            </div>
            {diagPath && (
              <div className="rounded-xl border border-success/25 bg-success/10 px-4 py-3 font-mono text-sm text-success dark:text-emerald-100">
                {diagPath}
              </div>
            )}
            {doctorReport && (
              <div className="space-y-4">
                <section className="card p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="label">{i18n.statusTitle}</p>
                      <p className="mt-1 text-sm text-ink-600 dark:text-fg-muted">
                        {doctorReport.engine.detail}
                      </p>
                    </div>
                    <span
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                        doctorReport.engine.available
                          ? "border-success/30 bg-success/10 text-success dark:text-emerald-100"
                          : "border-amber-400/40 bg-amber-500/10 text-amber-800 dark:text-amber-200"
                      }`}
                    >
                      {doctorReport.engine.available ? i18n.statusReady : i18n.statusUnavailable}
                    </span>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <Info label={i18n.statusEngine} value={doctorReport.engine.id} />
                    <Info
                      label={i18n.statusDisk}
                      value={
                        doctorReport.freeWorkBytes != null
                          ? formatBytes(doctorReport.freeWorkBytes)
                          : "—"
                      }
                    />
                    <Info
                      label={i18n.statusUnrar}
                      value={doctorReport.unrarFound ? i18n.statusAvailable : i18n.statusUnavailableValue}
                    />
                    <Info
                      label={i18n.statusMock}
                      value={doctorReport.useMockEngine ? i18n.statusAvailable : i18n.statusUnavailableValue}
                    />
                  </div>
                </section>
                <details className="card group">
                  <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-sm font-medium text-ink-800 marker:hidden dark:text-fg">
                    <span>{i18n.statusAdvanced}</span>
                    <span className="text-ink-400 transition-transform group-open:rotate-180 dark:text-fg-muted">⌄</span>
                  </summary>
                  <div className="space-y-4 border-t border-ink-200 px-5 py-5 text-sm dark:border-white/[0.08]">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Info label="Version" value={doctorReport.appVersion} />
                      <Info label="OS" value={`${doctorReport.os}/${doctorReport.arch}`} />
                      <Info label="Host target" value={doctorReport.hostTarget} />
                      <Info label="Jobs on disk" value={String(doctorReport.jobsOnDisk)} />
                      <Info label="Enhance mode" value={doctorReport.enhanceMode ?? "directory"} />
                      <Info label="Waifu2x -j threads" value={doctorReport.waifu2xJobs ?? "auto"} />
                      <Info label="Extract threads" value={String(doctorReport.extractConcurrency ?? "—")} />
                      <Info label="Timestamp" value={doctorReport.timestamp} />
                      <Info label="Waifu2x bundle" value={doctorReport.waifu2xBundleFound ? "found" : "missing"} />
                      <Info label="Waifu2x binary" value={doctorReport.waifu2xBinary ?? "—"} />
                      <Info label="Models" value={doctorReport.waifu2xModels ?? "—"} />
                      <Info label="Work root" value={doctorReport.workRoot} />
                    </div>
                    <div>
                      <p className="label mb-2">GPUs</p>
                      <ul className="space-y-1">
                        {doctorReport.gpus.map((g) => (
                          <li
                            key={`${g.id}-${g.name}`}
                            className="rounded-lg border border-ink-200 bg-ink-100 px-3 py-2 font-mono text-xs dark:border-white/[0.08] dark:bg-surface-raised"
                          >
                            [{g.id}] {g.name}{g.is_cpu ? " (CPU)" : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </details>
              </div>
            )}
          </div>
        )}
      </main>

      {queueOpen && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            aria-label={i18n.hideQueue}
            onClick={() => setQueueOpen(false)}
          />
          <aside className="relative h-full w-full max-w-md border-l border-ink-200 bg-white shadow-panel flex flex-col dark:border-white/[0.08] dark:bg-surface">
            <JobQueue
              jobs={jobs}
              i18n={i18n}
              onClose={() => setQueueOpen(false)}
              onRefresh={refreshJobs}
              onCancel={(id) =>
                cancelJob(id)
                  .then(refreshJobs)
                  .catch((e) => setError(`取消失败: ${errMsg(e)}`))
              }
              onRemove={(id) =>
                removeJob(id)
                  .then(refreshJobs)
                  .catch((e) => setError(`删除失败: ${errMsg(e)}`))
              }
              onClearFinished={() =>
                clearFinishedJobs()
                  .then(() => {
                    setError(null);
                    void refreshJobs();
                  })
                  .catch((e) => setError(`清理失败: ${errMsg(e)}`))
              }
              onOpen={(id) => openOutputFolder(id).catch((e) => setError(errMsg(e)))}
              onRead={(id) => {
                const job = jobs.find((j) => j.jobId === id);
                openReader({
                  source: job?.source ?? source ?? "",
                  jobId: id,
                  from: "queue",
                });
                setQueueOpen(false);
              }}
            />
          </aside>
        </div>
      )}
    </div>
  );
}

function ExternalImportModal({
  i18n,
  title,
  path,
  remember,
  busy,
  onRememberChange,
  onAdd,
  onDiscard,
  onCancel,
}: {
  i18n: ReturnType<typeof t>;
  title: string;
  path: string;
  remember: boolean;
  busy: boolean;
  onRememberChange: (v: boolean) => void;
  onAdd: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        aria-label={i18n.externalImportCancel}
        onClick={onCancel}
        disabled={busy}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="external-import-title"
        className="relative w-full max-w-md rounded-2xl border border-ink-200 bg-white p-5 shadow-panel dark:border-white/[0.08] dark:bg-surface-raised"
      >
        <p id="external-import-title" className="text-base font-semibold text-ink-900 dark:text-fg">
          {i18n.externalImportTitle}
        </p>
        <p className="mt-2 text-sm text-ink-600 dark:text-fg-muted">{i18n.externalImportBody}</p>
        <p className="mt-2 truncate rounded-lg bg-ink-100 px-2.5 py-1.5 font-mono text-[11px] text-ink-700 dark:bg-surface-high dark:text-fg" title={path}>
          {title}
          <span className="mt-0.5 block truncate text-ink-400 dark:text-fg-muted">{path}</span>
        </p>
        <label className="mt-4 flex cursor-pointer items-center gap-2 text-xs text-ink-600 dark:text-fg-muted">
          <input
            type="checkbox"
            checked={remember}
            disabled={busy}
            onChange={(e) => onRememberChange(e.target.checked)}
          />
          {i18n.externalImportRemember}
        </label>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-ghost !h-9 !px-3 text-xs" disabled={busy} onClick={onCancel}>
            {i18n.externalImportCancel}
          </button>
          <button type="button" className="btn-soft !h-9 !px-3 text-xs" disabled={busy} onClick={onDiscard}>
            {i18n.externalImportDiscard}
          </button>
          <button type="button" className="btn-accent !h-9 !px-3 text-xs" disabled={busy} onClick={onAdd}>
            {busy ? "…" : i18n.externalImportAdd}
          </button>
        </div>
      </div>
    </div>
  );
}

function stateBadgeClass(state: string): string {
  const s = normalizeJobState(state);
  if (s === "completed")
    return "bg-success/15 border-success/35 text-success dark:text-emerald-100";
  if (s === "failed") return "bg-rose-500/20 border-rose-400/40 text-rose-800 dark:text-rose-100";
  if (s === "cancelled" || s === "cancelling")
    return "bg-ink-200 border-ink-300 text-ink-700 dark:bg-surface-raised dark:border-white/[0.08] dark:text-fg";
  if (s === "running") return "bg-accent/15 border-accent/40 text-accent dark:text-fg";
  if (s === "extracting") return "bg-sky-500/20 border-sky-400/40 text-sky-800 dark:text-sky-100";
  if (s === "finalizing")
    return "bg-amber-500/20 border-amber-400/40 text-amber-900 dark:text-amber-100";
  return "bg-ink-100 border-ink-200 text-ink-700 dark:bg-surface-high dark:border-white/[0.08] dark:text-fg";
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-ink-200 bg-ink-50 px-3 py-2 dark:bg-surface-raised dark:border-white/[0.08]">
      <p className="text-[10px] uppercase tracking-wider text-ink-500">{label}</p>
      <p className="mt-0.5 text-ink-800 break-all dark:text-fg">{value}</p>
    </div>
  );
}

/** Normalize job state from backend (snake_case / PascalCase / unexpected). */
function normalizeJobState(state: unknown): string {
  if (state == null) return "";
  if (typeof state === "string") return state.toLowerCase();
  // defensive: some serializers may nest
  return String(state).toLowerCase();
}

function isTerminalState(state: unknown): boolean {
  const s = normalizeJobState(state);
  return s === "completed" || s === "failed" || s === "cancelled";
}

function isCancellingState(state: unknown): boolean {
  return normalizeJobState(state) === "cancelling";
}

function canShowCancel(state: unknown): boolean {
  // Show for pending / validating / extracting / running / finalizing / cancelling / unknown
  return !isTerminalState(state);
}

function JobQueue({
  jobs,
  i18n,
  onRefresh,
  onCancel,
  onRemove,
  onClearFinished,
  onOpen,
  onRead,
  onClose,
}: {
  jobs: JobStatus[];
  i18n: ReturnType<typeof t>;
  onRefresh: () => void;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
  onClearFinished: () => void;
  onOpen: (id: string) => void;
  onRead: (id: string) => void;
  onClose?: () => void;
}) {
  const finishedCount = jobs.filter((j) => isTerminalState(j.state)).length;
  return (
    <div className="h-full min-h-0 flex flex-col p-4">
      <div className="flex items-center justify-between mb-4 gap-2">
        <p className="label">{i18n.queue}</p>
        <div className="flex items-center gap-2">
          {finishedCount > 0 && (
            <button
              type="button"
              className="text-xs text-amber-200/90 hover:text-amber-100 border border-amber-400/30 rounded-lg px-2 py-1"
              onClick={onClearFinished}
              title={`清理 ${finishedCount} 个已结束任务`}
            >
              {i18n.clearFinished}
            </button>
          )}
          <button type="button" className="text-xs text-ink-500 hover:text-ink-950 dark:text-fg-muted dark:hover:text-fg" onClick={onRefresh}>
            刷新
          </button>
          {onClose && (
            <button type="button" className="btn-ghost !px-2.5 !py-1 text-xs" onClick={onClose}>
              {i18n.hideQueue}
            </button>
          )}
        </div>
      </div>
      {jobs.length === 0 ? (
        <div className="flex-1 grid place-items-center text-ink-500 text-sm">{i18n.emptyQueue}</div>
      ) : (
        <ul className="space-y-3 overflow-auto flex-1 min-h-0 pr-1">
          {jobs.map((j) => {
            const id = j.jobId || (j as { job_id?: string }).job_id || "";
            // Defend against snake_case payloads if IPC ever skips rename
            const raw = j as JobStatus & {
              pages_done?: number;
              pages_total?: number;
            };
            const pagesDone = j.pagesDone ?? raw.pages_done ?? 0;
            const pagesTotal = j.pagesTotal ?? raw.pages_total ?? 0;
            const pct =
              pagesTotal > 0 ? Math.round((pagesDone / pagesTotal) * 100) : 0;
            const showCancel = canShowCancel(j.state);
            const cancelling = isCancellingState(j.state);
            return (
              <li key={id || j.source} className="rounded-xl border border-ink-200 bg-ink-50 p-3.5 dark:border-white/[0.08] dark:bg-surface-panel">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink-900 truncate dark:text-fg">
                      {j.source.split(/[/\\]/).pop()}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold tracking-wide ${stateBadgeClass(j.state)}`}
                      >
                        {stateLabel(normalizeJobState(j.state) || j.state)}
                      </span>
                      <span className="text-xl font-semibold tabular-nums text-ink-950 leading-none dark:text-fg">
                        {pct}%
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5 items-end shrink-0">
                    {id && (
                      <button
                        type="button"
                        className="rounded-full border border-ink-300 bg-ink-200 px-2.5 py-1 text-xs font-medium text-ink-800 hover:bg-ink-300 dark:border-white/[0.08] dark:bg-surface-high dark:text-fg"
                        onClick={() => onRead(id)}
                      >
                        {i18n.readerRead}
                      </button>
                    )}
                    {showCancel && (
                      <button
                        type="button"
                        disabled={cancelling || !id}
                        className="rounded-lg border border-rose-400/40 bg-rose-500/15 px-2.5 py-1 text-xs font-medium text-rose-700 hover:bg-rose-500/25 disabled:opacity-40 disabled:pointer-events-none dark:text-rose-200"
                        onClick={() => id && onCancel(id)}
                      >
                        {cancelling ? "取消中…" : i18n.cancel}
                      </button>
                    )}
                    {isTerminalState(j.state) && (
                      <button
                        type="button"
                        className="text-xs text-ink-500 hover:text-ink-950 dark:text-fg-muted dark:hover:text-fg"
                        onClick={() => id && onRemove(id)}
                      >
                        {i18n.remove}
                      </button>
                    )}
                    {j.outputPath && (
                      <button
                        type="button"
                        className="text-xs text-ink-500 hover:text-ink-950 dark:text-fg-muted dark:hover:text-fg"
                        onClick={() => id && onOpen(id)}
                      >
                        {i18n.openOut}
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-3 h-2.5 rounded-full bg-ink-200 overflow-hidden dark:bg-surface-high">
                  <div
                    className={`h-full transition-all ${
                      normalizeJobState(j.state) === "failed"
                        ? "bg-rose-400"
                        : normalizeJobState(j.state) === "completed"
                          ? "bg-success"
                          : "bg-accent"
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="mt-1.5 text-sm font-medium text-ink-800 dark:text-fg">
                  {pagesDone}/{pagesTotal} {i18n.pages}
                  {j.stage ? ` · ${j.stage}` : ""}
                </p>
                {j.message && (
                  <p className="mt-0.5 text-xs text-success dark:text-emerald-200/90">{j.message}</p>
                )}
                {j.error && <p className="mt-1 text-xs text-rose-300">{j.error.message}</p>}
                {j.outputPath && (
                  <p className="mt-1 text-[11px] text-success/90 dark:text-emerald-300/90 font-mono truncate">
                    {j.outputPath}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
