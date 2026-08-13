import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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
} from "./api";
import { stateLabel, t } from "./i18n";
import { LibraryView, pickComicFile, pickFolder } from "./library/LibraryView";
import { ReaderView } from "./reader/ReaderView";
import type {
  DiskEstimate,
  DoctorReport,
  EngineInfo,
  EngineStatus,
  JobStatus,
  LibraryEntry,
  LibraryScanPreview,
  ResumeHint,
  ValidateResult,
} from "./types";

type Preset = "fast" | "balanced" | "quality";
type Tab = "library" | "enhance" | "reader" | "doctor";
type Container = "cbz" | "folder" | "zip";
type ImgFmt = "jpeg" | "png" | "webp" | "same";
type Theme = "dark" | "light";

const THEME_KEY = "comic.theme";

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) =>
      getCurrentWindow().setBackgroundColor(theme === "light" ? "#f0f2f7" : "#1c1e2e"),
    )
    .catch(() => undefined);
}

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

function accelLabel(
  catalog: EngineInfo[],
  engineId: string,
  cuganModel: string,
  fallback: EngineStatus | null,
): string {
  const selected = catalog.find((e) => e.id === engineId);
  const blob = `${selected?.detail ?? ""} ${fallback?.detail ?? ""}`;
  const jobs = blob.match(/线程 -j \S+/)?.[0] ?? "";
  const mode = /目录批处理/.test(blob) ? "目录批处理" : /逐页并行/.test(blob) ? "逐页并行" : "";
  const ready =
    selected && !selected.available
      ? selected.detail || `${selected.label} 未安装`
      : engineId === "realcugan"
        ? "realcugan-ncnn-vulkan 就绪"
        : engineId === "waifu2x"
          ? "waifu2x-ncnn-vulkan 就绪"
          : selected?.label || fallback?.detail || engineId;
  const parts = [ready];
  if (engineId === "realcugan" && selected?.available !== false) {
    parts.push(`当前 ${cuganModel.toUpperCase()}`);
  }
  if (mode) parts.push(mode);
  if (jobs) parts.push(jobs);
  return parts.join(" · ");
}

export default function App() {
  const i18n = t();
  const [tab, setTab] = useState<Tab>("library");
  const [source, setSource] = useState<string | null>(null);
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>("balanced");
  const [engineId, setEngineId] = useState("waifu2x");
  const [cuganModel, setCuganModel] = useState("se");
  const [catalog, setCatalog] = useState<EngineInfo[]>([]);
  const [scale, setScale] = useState<number>(2);
  const [noise, setNoise] = useState<-1 | 0 | 1 | 2 | 3>(1);
  const [tta, setTta] = useState(false);
  const [container, setContainer] = useState<Container>("cbz");
  const [imageFormat, setImageFormat] = useState<ImgFmt>("jpeg");
  const [validation, setValidation] = useState<ValidateResult | null>(null);
  const [estimate, setEstimate] = useState<DiskEstimate | null>(null);
  const [resumeHint, setResumeHint] = useState<ResumeHint | null>(null);
  const [jobs, setJobs] = useState<JobStatus[]>([]);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [readerJobId, setReaderJobId] = useState<string | null>(null);
  const [readerImmersive, setReaderImmersive] = useState(false);
  const hideAppChrome = tab === "reader" && readerImmersive;
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [diagPath, setDiagPath] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [libraryScan, setLibraryScan] = useState(false);
  const [libraryImporting, setLibraryImporting] = useState(false);
  const [libraryNotice, setLibraryNotice] = useState<string | null>(null);
  const [scanPreview, setScanPreview] = useState<LibraryScanPreview | null>(null);

  const refreshLibrary = useCallback(async () => {
    try {
      setLibrary(await listLibrary());
    } catch {
      /* backend not ready */
    }
  }, []);

  const ingestPath = useCallback(
    async (path: string) => {
      setError(null);
      try {
        await addLibraryPath(path);
        await refreshLibrary();
        setLibraryNotice(null);
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
      }
    },
    [refreshLibrary],
  );

  const refreshJobs = useCallback(async () => {
    try {
      setJobs(await listJobs());
    } catch {
      /* backend not ready */
    }
  }, []);

  const refreshDoctor = useCallback(async () => {
    try {
      setDoctorReport(await fetchDoctor());
      setEngine((await getEngineStatus().catch(() => null)) ?? null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

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
          version: "0.1.0-mock",
        }),
      );
    listEngines()
      .then((c) => {
        setCatalog(c);
        const saved = localStorage.getItem("comic.engine");
        const savedModel = localStorage.getItem("comic.cuganModel");
        const pick =
          c.find((e) => e.id === saved && e.available) ??
          c.find((e) => e.available) ??
          c[0];
        if (pick) {
          setEngineId(pick.id);
          const mid =
            savedModel && pick.models.some((m) => m.id === savedModel)
              ? savedModel
              : pick.models[0]?.id ?? "se";
          setCuganModel(mid);
        }
      })
      .catch(() => undefined);
    const timer = setInterval(refreshJobs, 1500);
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
  }, [refreshJobs, refreshLibrary]);

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
    setError(null);
    setSource(path);
    void ingestPath(path);
    try {
      const v = await validateSource(path);
      setValidation(v);
      const e = await estimateDisk(path, scale);
      setEstimate(e);
      const hint = await probeResume(path).catch(() => null);
      setResumeHint(hint);
    } catch (e) {
      setValidation(null);
      setEstimate(null);
      setResumeHint(null);
      setError(errMsg(e));
    }
  }, [scale, ingestPath]);

  /** Prefer CBZ/ZIP files over random paths; accept directories. */
  const pickDroppedPath = (paths: string[]): string | null => {
    if (!paths.length) return null;
    const comic = paths.find((p) =>
      /\.(cbz|zip|cbr|rar|epub|mobi|azw|azw3)$/i.test(p),
    );
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
            if (tab === "enhance") {
              void applySource(path);
            } else if (tab === "reader") {
              setSource(path);
              setReaderJobId(null);
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
  }, [applySource, ingestPath, tab]);

  const pickSource = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: "Comic / Ebook",
          extensions: ["cbz", "cbr", "zip", "rar", "epub", "mobi", "azw", "azw3"],
        },
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
    if (typeof selected === "string") setOutputDir(selected);
  };

  const canStart = useMemo(
    () => !!source && !!outputDir && !!validation && !busy && (estimate?.ok ?? true),
    [source, outputDir, validation, busy, estimate],
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
      await refreshJobs();
      setReaderJobId(created.jobId);
      setTab("enhance");
      setQueueOpen(true);
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
    { id: "reader", label: i18n.tabReader },
    { id: "doctor", label: i18n.tabDoctor },
  ];
  const runningJobCount = jobs.filter((j) => canShowCancel(j.state)).length;
  const readyModels = catalog.filter((e) => e.available && e.id !== "mock");
  const readyModelLabel =
    readyModels.length > 0
      ? readyModels
          .map((e) =>
            e.id === "waifu2x" ? "Waifu2x" : e.id === "realcugan" ? "Real-CUGAN" : e.label.split("（")[0],
          )
          .join(" · ")
      : catalog.length > 0
        ? "无可用模型"
        : engine?.available && engine.id !== "mock"
          ? engine.id === "waifu2x"
            ? "Waifu2x"
            : engine.id
          : "检测中…";
  const readyModelHint =
    readyModels.length > 0
      ? readyModels.map((e) => `${e.label}${e.detail ? ` · ${e.detail}` : ""}`).join("\n")
      : (engine?.detail ?? "");
  const accel = accelLabel(catalog, engineId, cuganModel, engine);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <header
        className={`sticky top-0 z-10 shrink-0 border-b border-ink-200/80 bg-[#f0f2f7] dark:border-white/[0.06] dark:bg-ink-950 ${
          hideAppChrome ? "hidden" : ""
        }`}
      >
        <div className="flex h-[52px] items-center">
          <div data-tauri-drag-region className="h-full w-[84px] shrink-0" />
          <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2.5 h-full pr-3">
            <h1 className="shrink-0 text-[15px] font-semibold tracking-tight text-ink-950 dark:text-white pointer-events-none">
              {i18n.appName}
            </h1>
            <span
              className="min-w-0 truncate rounded-full border border-emerald-600/20 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] text-emerald-800 dark:border-emerald-400/20 dark:text-emerald-200/90"
              title={readyModelHint}
            >
              {readyModelLabel}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0 pr-3">
            <button
              type="button"
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
              title={i18n.themeToggle}
              aria-label={i18n.themeToggle}
              className="inline-flex h-[34px] items-center gap-1.5 rounded-xl border border-ink-200 bg-white px-2.5 text-sm text-ink-700 hover:bg-ink-100 dark:border-white/10 dark:bg-white/5 dark:text-ink-200 dark:hover:bg-white/10 dark:hover:text-white"
            >
              {theme === "dark" ? (
                <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true">
                  <path
                    fill="currentColor"
                    d="M10 3.2a.8.8 0 0 1 .8.8v1.2a.8.8 0 1 1-1.6 0V4a.8.8 0 0 1 .8-.8Zm0 10.2a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8Zm6-3.4a.8.8 0 0 1 .8.8.8.8 0 0 1-.8.8h-1.2a.8.8 0 1 1 0-1.6H16ZM5.2 10a.8.8 0 0 1-.8.8H3.2a.8.8 0 1 1 0-1.6H4.4A.8.8 0 0 1 5.2 10Zm9.33 4.53a.8.8 0 0 1 0 1.13l-.85.85a.8.8 0 1 1-1.13-1.13l.85-.85a.8.8 0 0 1 1.13 0ZM7.45 4.34a.8.8 0 0 1 0 1.13l-.85.85A.8.8 0 1 1 5.47 5.2l.85-.85a.8.8 0 0 1 1.13 0Zm7.08.85a.8.8 0 0 1 1.13 0 .8.8 0 0 1 0 1.13l-.85.85a.8.8 0 1 1-1.13-1.13l.85-.85ZM6.6 14.53a.8.8 0 0 1 0 1.13l-.85.85A.8.8 0 1 1 4.62 15.4l.85-.85a.8.8 0 0 1 1.13 0ZM10 14.8a.8.8 0 0 1 .8.8V16.8a.8.8 0 1 1-1.6 0V15.6a.8.8 0 0 1 .8-.8Z"
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
              <span className="hidden sm:inline">{theme === "dark" ? i18n.themeLight : i18n.themeDark}</span>
            </button>
            <nav className="flex rounded-xl border border-ink-200 bg-ink-100/70 p-1 dark:border-white/10 dark:bg-white/5">
              {tabs.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  onClick={() => setTab(x.id)}
                  className={`px-3 py-1.5 text-sm rounded-lg transition ${
                    tab === x.id
                      ? "bg-accent text-white shadow"
                      : "text-ink-600 hover:text-ink-950 dark:text-ink-300 dark:hover:text-white"
                  }`}
                >
                  {x.label}
                </button>
              ))}
            </nav>
            <button
              type="button"
              onClick={() => setQueueOpen(true)}
              title={i18n.showQueue}
              className={`inline-flex items-center rounded-xl border px-3 py-1.5 text-sm transition ${
                runningJobCount > 0
                  ? "border-amber-400/40 bg-amber-500 text-ink-950 font-medium shadow"
                  : queueOpen
                    ? "border-accent/40 bg-accent text-white shadow"
                    : "border-ink-200 bg-white text-ink-600 hover:bg-ink-100 hover:text-ink-950 dark:border-white/10 dark:bg-white/5 dark:text-ink-300 dark:hover:text-white dark:hover:bg-white/10"
              }`}
            >
              {i18n.queue}
              {jobs.length > 0 && (
                <span
                  className={`ml-1.5 inline-flex min-w-[1.15rem] h-[1.15rem] items-center justify-center rounded-full px-1 text-[11px] font-semibold leading-none ${
                    runningJobCount > 0
                      ? "bg-ink-950/20 text-ink-950"
                      : "bg-ink-200 text-ink-800 dark:bg-white/15 dark:text-ink-100"
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
          tab === "reader"
            ? "flex min-h-0 w-full flex-1 flex-col"
            : tab === "library"
              ? "mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col px-6 py-4"
              : "mx-auto w-full max-w-6xl flex-1 px-6 py-4"
        }
      >
        {tab === "library" && (
          <div className="flex min-h-0 flex-1 flex-col">
            {libraryNotice && (
              <div className="mb-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-100">
                {libraryNotice}
              </div>
            )}
            <LibraryView
              entries={library}
              dragOver={dragOver}
              scanning={libraryScan}
              scanPreview={scanPreview}
              importing={libraryImporting}
              i18n={i18n}
              onAddFile={async () => {
                const p = await pickComicFile();
                if (p) await ingestPath(p);
              }}
              onAddFolder={async () => {
                const p = await pickFolder();
                if (p) await ingestPath(p);
              }}
              onScan={async () => {
                const p = await pickFolder();
                if (!p) return;
                setLibraryScan(true);
                setError(null);
                try {
                  setScanPreview(await previewLibraryScan(p));
                } catch (e) {
                  setError(errMsg(e));
                } finally {
                  setLibraryScan(false);
                }
              }}
              onCancelScan={() => setScanPreview(null)}
              onConfirmScan={async (paths) => {
                if (paths.length === 0) return;
                setLibraryImporting(true);
                setError(null);
                try {
                  const r = await importLibraryPaths(paths);
                  setLibraryNotice(r.message);
                  setScanPreview(null);
                  await refreshLibrary();
                } catch (e) {
                  setError(errMsg(e));
                } finally {
                  setLibraryImporting(false);
                }
              }}
              onOpen={(e) => {
                setSource(e.path);
                setReaderJobId(e.jobId ?? null);
                setTab("reader");
              }}
              onEnhance={(e) => {
                void applySource(e.path);
                setTab("enhance");
              }}
              onRemove={(e) => {
                void removeLibraryEntry(e.id)
                  .then(refreshLibrary)
                  .catch((err) => setError(errMsg(err)));
              }}
            />
          </div>
        )}

        {tab === "enhance" && (
          <div className="grid lg:grid-cols-2 gap-5 items-stretch">
            <section
              className={`card p-5 h-full flex flex-col ${
                dragOver ? "ring-2 ring-accent border-accent/40 bg-accent/5" : ""
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <p className="label">{i18n.import}</p>
                <div className="flex gap-1.5">
                  <button type="button" className="btn-ghost !px-2.5 !py-1 text-xs" onClick={pickSource}>
                    文件
                  </button>
                  <button type="button" className="btn-ghost !px-2.5 !py-1 text-xs" onClick={pickSourceFolder}>
                    文件夹
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={pickSource}
                className="w-full flex-1 min-h-[8rem] rounded-xl border border-dashed border-ink-300 bg-ink-100/60 px-5 py-10 text-center hover:border-accent/50 hover:bg-accent/5 transition grid place-items-center dark:border-white/15 dark:bg-ink-950/40"
              >
                <div>
                  <p className="text-sm text-ink-800 dark:text-ink-100">
                    <span className="mr-2 opacity-80">📚</span>
                    {i18n.dropCompact}
                  </p>
                  {source && (
                    <p className="mt-2 text-xs text-accent break-all font-mono">{source}</p>
                  )}
                </div>
              </button>
              <div className="mt-4">
                <p className="label mb-1.5">{i18n.outputDir}</p>
                <div className="flex gap-2">
                  <div className="flex-1 min-w-0 rounded-xl bg-ink-100 border border-ink-200 px-3 py-2 text-sm font-mono text-ink-700 truncate dark:bg-ink-950/60 dark:border-white/10 dark:text-ink-200">
                    {outputDir ?? "—"}
                  </div>
                  <button type="button" className="btn-ghost shrink-0" onClick={pickOutput}>
                    {i18n.chooseOutput}
                  </button>
                </div>
              </div>
              {(validation || estimate || resumeHint) && (
                <div className="mt-4 flex flex-wrap gap-2 text-xs">
                  {validation && (
                    <span className="rounded-lg bg-emerald-500/15 border border-emerald-400/30 px-2.5 py-1 text-emerald-800 dark:text-emerald-100">
                      {i18n.validateOk} · {validation.pageCount} {i18n.pages}
                      {validation.hasComicInfo ? " · ComicInfo" : ""}
                    </span>
                  )}
                  {estimate && (
                    <span
                      className={`rounded-lg px-2.5 py-1 border ${
                        estimate.ok
                          ? "bg-ink-100 border-ink-200 text-ink-700 dark:bg-white/5 dark:border-white/10 dark:text-ink-200"
                          : "bg-rose-500/10 border-rose-500/30 text-rose-800 dark:text-rose-100"
                      }`}
                    >
                      {i18n.estimate}: ~{formatBytes(estimate.estimateBytes)} /{" "}
                      {formatBytes(estimate.freeBytes)}
                      {estimate.message ? ` — ${estimate.message}` : ""}
                    </span>
                  )}
                  {resumeHint && (
                    <span className="w-full rounded-lg bg-amber-500/15 border border-amber-400/40 px-2.5 py-1.5 text-sm font-medium text-amber-900 dark:text-amber-50">
                      {i18n.resumeTitle}：{resumeHint.message}
                    </span>
                  )}
                </div>
              )}
            </section>

            <section className="card p-5 h-full flex flex-col">
              <p className="label mb-4">{i18n.settings}</p>
              <div className="flex-1 space-y-4">
              <Field label={i18n.preset}>
                <Segmented
                  value={preset}
                  onChange={(p) => {
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
                  }}
                  options={[
                    { id: "fast", label: i18n.presetFast },
                    { id: "balanced", label: i18n.presetBalanced },
                    { id: "quality", label: i18n.presetQuality },
                  ]}
                />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label={i18n.engine}>
                  <SelectBox
                    value={engineId}
                    onChange={(id) => {
                      const info = catalog.find((e) => e.id === id);
                      setEngineId(id);
                      localStorage.setItem("comic.engine", id);
                      const scales = info?.scales ?? [1, 2];
                      if (!scales.includes(scale)) {
                        setScale(scales.includes(2) ? 2 : scales[0] ?? 2);
                      }
                      const mid = info?.models[0]?.id ?? "se";
                      if (id === "realcugan") {
                        const keep = info?.models.some((m) => m.id === cuganModel);
                        const next = keep ? cuganModel : mid;
                        setCuganModel(next);
                        localStorage.setItem("comic.cuganModel", next);
                      }
                    }}
                    options={(catalog.length
                      ? catalog
                      : [{ id: "waifu2x", label: i18n.engineWaifu2x, available: true }]
                    ).map((e) => ({
                      id: e.id,
                      label: e.available ? e.label : `${e.label}（未安装）`,
                    }))}
                  />
                </Field>
                <Field label={i18n.scale} hint={i18n.scaleHint}>
                  <Segmented
                    value={String(scale)}
                    onChange={(v) => setScale(Number(v))}
                    options={(catalog.find((e) => e.id === engineId)?.scales ?? [1, 2]).map((s) => ({
                      id: String(s),
                      label: `${s}×`,
                    }))}
                  />
                </Field>
              </div>
              <Field
                label={engineId === "realcugan" ? i18n.cuganPack : i18n.model}
                hint={engineId === "realcugan" ? i18n.cuganPackHint : i18n.modelHintWaifu}
              >
                <SelectBox
                  value={
                    engineId === "realcugan"
                      ? cuganModel
                      : catalog.find((e) => e.id === engineId)?.models[0]?.id ?? "cunet"
                  }
                  onChange={(id) => {
                    if (engineId !== "realcugan") return;
                    setCuganModel(id);
                    localStorage.setItem("comic.cuganModel", id);
                  }}
                  options={(
                    catalog.find((e) => e.id === engineId)?.models ??
                    (engineId === "realcugan"
                      ? [{ id: "se", label: "SE" }]
                      : [{ id: "cunet", label: "CUnet" }])
                  ).map((m) => ({ id: m.id, label: m.label }))}
                />
              </Field>
              <div className="grid grid-cols-2 gap-4 items-end">
                <Field
                  label={i18n.noise}
                  hint={engineId === "realcugan" ? i18n.noiseHintCugan : i18n.noiseHint}
                >
                  <SelectBox
                    value={String(noise)}
                    onChange={(v) => setNoise(Number(v) as -1 | 0 | 1 | 2 | 3)}
                    options={[
                      {
                        id: "-1",
                        label:
                          engineId === "realcugan" ? i18n.noiseConservative : i18n.noiseOff,
                      },
                      { id: "0", label: i18n.noise0 },
                      { id: "1", label: i18n.noise1 },
                      { id: "2", label: i18n.noise2 },
                      { id: "3", label: i18n.noise3 },
                    ]}
                  />
                </Field>
                <Field label={i18n.tta} hint={i18n.ttaHint}>
                  <SelectBox
                    value={tta ? "on" : "off"}
                    onChange={(v) => setTta(v === "on")}
                    options={[
                      { id: "off", label: i18n.ttaOff },
                      { id: "on", label: i18n.ttaOn },
                    ]}
                  />
                </Field>
              </div>
              {accel && (
                <Field label={i18n.threads}>
                  <p className="min-h-[2.5rem] text-xs font-mono leading-5 text-emerald-700 dark:text-emerald-200 break-all">
                    {accel}
                  </p>
                </Field>
              )}
              <div className="grid grid-cols-2 gap-4">
                <Field label={i18n.container} hint={i18n.containerHint}>
                  <SelectBox
                    value={container}
                    onChange={setContainer}
                    options={[
                      { id: "cbz", label: i18n.containerCbz },
                      { id: "zip", label: i18n.containerZip },
                      { id: "folder", label: i18n.containerFolder },
                    ]}
                  />
                </Field>
                <Field
                  label={i18n.imageFormat}
                  hint={imageFormat === "png" ? i18n.formatHintPng : i18n.formatHintJpeg}
                >
                  <SelectBox
                    value={imageFormat}
                    onChange={setImageFormat}
                    options={[
                      { id: "jpeg", label: i18n.formatJpeg },
                      { id: "png", label: i18n.formatPng },
                      { id: "webp", label: i18n.formatWebp },
                      { id: "same", label: i18n.formatSame },
                    ]}
                  />
                </Field>
              </div>
              </div>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  className="btn-primary flex-1 py-2.5 text-base"
                  disabled={!canStart}
                  onClick={start}
                >
                  {busy ? "…" : i18n.start}
                </button>
                <button
                  type="button"
                  className="btn-ghost py-2.5 px-4"
                  disabled={!source}
                  onClick={() => {
                    setReaderJobId(jobs.find((j) => j.source === source)?.jobId ?? null);
                    setTab("reader");
                  }}
                >
                  {i18n.readerRead}
                </button>
              </div>
            </section>
          </div>
        )}

        {tab === "reader" && (
          <ReaderView
            jobs={jobs}
            source={source}
            requestedJobId={readerJobId}
            i18n={i18n}
            onError={setError}
            onImmersiveChange={setReaderImmersive}
            onPickedSource={(path) => {
              setSource(path);
              setReaderJobId(null);
              void ingestPath(path);
            }}
          />
        )}

        {tab === "doctor" && (
          <div className="space-y-6">
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-ghost" onClick={refreshDoctor}>
                {i18n.refreshDoctor}
              </button>
              <button type="button" className="btn-primary" onClick={onExportDiag}>
                {i18n.exportDiag}
              </button>
            </div>
            {diagPath && (
              <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-4 py-3 text-sm text-emerald-800 dark:text-emerald-100 font-mono break-all">
                {diagPath}
              </div>
            )}
            {doctorReport && (
              <div className="card p-6 space-y-4 text-sm">
                <div className="grid sm:grid-cols-2 gap-3">
                  <Info label="Version" value={doctorReport.appVersion} />
                  <Info label="OS" value={`${doctorReport.os}/${doctorReport.arch}`} />
                  <Info label="Engine" value={`${doctorReport.engine.id} · ${doctorReport.engine.detail}`} />
                  <Info label="Mock" value={String(doctorReport.useMockEngine)} />
                  <Info label="Host target" value={doctorReport.hostTarget} />
                  <Info
                    label="Waifu2x bundle"
                    value={
                      doctorReport.waifu2xBundleFound
                        ? "found"
                        : "missing (run scripts/fetch-waifu2x.sh)"
                    }
                  />
                  <Info
                    label="Waifu2x binary"
                    value={doctorReport.waifu2xBinary ?? "—"}
                  />
                  <Info
                    label="Models"
                    value={doctorReport.waifu2xModels ?? "—"}
                  />
                  <Info label="Work root" value={doctorReport.workRoot} />
                  <Info
                    label="Free space"
                    value={
                      doctorReport.freeWorkBytes != null
                        ? formatBytes(doctorReport.freeWorkBytes)
                        : "—"
                    }
                  />
                  <Info label="Jobs on disk" value={String(doctorReport.jobsOnDisk)} />
                  <Info
                    label="Enhance mode"
                    value={doctorReport.enhanceMode ?? "directory"}
                  />
                  <Info
                    label="Waifu2x -j threads"
                    value={doctorReport.waifu2xJobs ?? "auto"}
                  />
                  <Info
                    label="Extract threads"
                    value={String(doctorReport.extractConcurrency ?? "—")}
                  />
                  <Info
                    label="UnRAR (CBR)"
                    value={
                      doctorReport.unrarFound
                        ? doctorReport.unrarBinary ?? "found"
                        : "missing — brew install unrar"
                    }
                  />
                  <Info label="Timestamp" value={doctorReport.timestamp} />
                </div>
                <div>
                  <p className="label mb-2">GPUs</p>
                  <ul className="space-y-1">
                    {doctorReport.gpus.map((g) => (
                      <li
                        key={`${g.id}-${g.name}`}
                        className="rounded-lg border border-ink-200 bg-ink-100 px-3 py-2 font-mono text-xs dark:bg-white/5 dark:border-white/10"
                      >
                        [{g.id}] {g.name}
                        {g.is_cpu ? " (CPU)" : ""}
                      </li>
                    ))}
                  </ul>
                </div>
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
          <aside className="relative h-full w-full max-w-md border-l border-ink-200 bg-white shadow-panel flex flex-col dark:border-white/10 dark:bg-ink-950">
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
                setReaderJobId(id);
                setTab("reader");
                setQueueOpen(false);
              }}
            />
          </aside>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-2 flex h-4 items-center justify-between gap-3">
        <p className="label shrink-0">{label}</p>
        {hint && (
          <p className="text-[11px] text-ink-500 truncate" title={hint}>
            {hint}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onChange(opt.id)}
          className={`rounded-xl px-3 py-2 text-sm border transition ${
            value === opt.id
              ? "border-accent bg-accent/15 text-ink-950 dark:text-white"
              : "border-ink-200 bg-ink-100/80 text-ink-700 hover:bg-ink-200/80 dark:border-white/10 dark:bg-white/5 dark:text-ink-200 dark:hover:bg-white/10"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function SelectBox<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.id === value) ?? options[0];
  const single = options.length <= 1;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        disabled={single}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!single) setOpen((v) => !v);
        }}
        className={`w-full h-10 flex items-center justify-between gap-2 rounded-xl border px-3 text-sm text-left transition ${
          open
            ? "border-accent bg-white text-ink-950 dark:bg-ink-950 dark:text-white"
            : "border-ink-200 bg-white text-ink-800 hover:border-ink-300 dark:border-white/10 dark:bg-ink-950/70 dark:text-ink-100 dark:hover:border-white/20 dark:hover:bg-ink-950"
        } disabled:opacity-80 disabled:cursor-default`}
      >
        <span className="truncate">{selected?.label ?? "—"}</span>
        <svg
          viewBox="0 0 20 20"
          className={`h-4 w-4 shrink-0 text-ink-400 transition ${open ? "rotate-180 text-accent" : ""}`}
          aria-hidden="true"
        >
          <path
            fill="currentColor"
            d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.58l3.3-3.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.42Z"
          />
        </svg>
      </button>
      {open && !single && (
        <ul
          role="listbox"
          className="absolute z-30 mt-1.5 w-full overflow-hidden rounded-xl border border-ink-200 bg-white py-1 shadow-panel dark:border-white/10 dark:bg-ink-900/95 dark:backdrop-blur-md"
        >
          {options.map((opt) => {
            const active = opt.id === value;
            return (
              <li key={opt.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`flex w-full items-center justify-between px-3 py-2 text-sm text-left transition ${
                    active
                      ? "bg-accent/15 text-ink-950 dark:text-white"
                      : "text-ink-700 hover:bg-ink-100 hover:text-ink-950 dark:text-ink-200 dark:hover:bg-white/10 dark:hover:text-white"
                  }`}
                  onClick={() => {
                    onChange(opt.id);
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{opt.label}</span>
                  {active && (
                    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true">
                      <path
                        fill="currentColor"
                        d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.2 7.2a1 1 0 0 1-1.4 0L3.3 9.1a1 1 0 1 1 1.4-1.4l4.1 4.08 6.5-6.48a1 1 0 0 1 1.4 0Z"
                      />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function stateBadgeClass(state: string): string {
  const s = normalizeJobState(state);
  if (s === "completed")
    return "bg-emerald-500/20 border-emerald-400/40 text-emerald-800 dark:text-emerald-100";
  if (s === "failed") return "bg-rose-500/20 border-rose-400/40 text-rose-800 dark:text-rose-100";
  if (s === "cancelled" || s === "cancelling")
    return "bg-ink-200 border-ink-300 text-ink-700 dark:bg-ink-700/60 dark:border-white/15 dark:text-ink-200";
  if (s === "running") return "bg-accent/25 border-accent/50 text-ink-950 dark:text-white";
  if (s === "extracting") return "bg-sky-500/20 border-sky-400/40 text-sky-800 dark:text-sky-100";
  if (s === "finalizing")
    return "bg-amber-500/20 border-amber-400/40 text-amber-900 dark:text-amber-100";
  return "bg-ink-100 border-ink-200 text-ink-700 dark:bg-white/10 dark:border-white/15 dark:text-ink-100";
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-ink-200 bg-ink-50 px-3 py-2 dark:bg-white/5 dark:border-white/10">
      <p className="text-[10px] uppercase tracking-wider text-ink-500">{label}</p>
      <p className="mt-0.5 text-ink-800 break-all dark:text-ink-100">{value}</p>
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
          <button type="button" className="text-xs text-ink-500 hover:text-ink-950 dark:text-ink-400 dark:hover:text-white" onClick={onRefresh}>
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
              <li key={id || j.source} className="rounded-xl border border-ink-200 bg-ink-50 p-3.5 dark:border-white/10 dark:bg-ink-950/50">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink-900 truncate dark:text-ink-50">
                      {j.source.split(/[/\\]/).pop()}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold tracking-wide ${stateBadgeClass(j.state)}`}
                      >
                        {stateLabel(normalizeJobState(j.state) || j.state)}
                      </span>
                      <span className="text-xl font-semibold tabular-nums text-ink-950 leading-none dark:text-white">
                        {pct}%
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5 items-end shrink-0">
                    {id && (
                      <button
                        type="button"
                        className="rounded-lg border border-accent/40 bg-accent/15 px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/25"
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
                        className="text-xs text-ink-500 hover:text-ink-950 dark:text-ink-400 dark:hover:text-white"
                        onClick={() => id && onRemove(id)}
                      >
                        {i18n.remove}
                      </button>
                    )}
                    {j.outputPath && (
                      <button
                        type="button"
                        className="text-xs text-accent hover:text-ink-950 dark:hover:text-white"
                        onClick={() => id && onOpen(id)}
                      >
                        {i18n.openOut}
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-3 h-2.5 rounded-full bg-ink-200 overflow-hidden dark:bg-white/10">
                  <div
                    className={`h-full transition-all ${
                      normalizeJobState(j.state) === "failed"
                        ? "bg-rose-400"
                        : normalizeJobState(j.state) === "completed"
                          ? "bg-emerald-400"
                          : "bg-accent"
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="mt-1.5 text-sm font-medium text-ink-800 dark:text-ink-100">
                  {pagesDone}/{pagesTotal} {i18n.pages}
                  {j.stage ? ` · ${j.stage}` : ""}
                </p>
                {j.message && (
                  <p className="mt-0.5 text-xs text-emerald-700 dark:text-emerald-200/90">{j.message}</p>
                )}
                {j.error && <p className="mt-1 text-xs text-rose-300">{j.error.message}</p>}
                {j.outputPath && (
                  <p className="mt-1 text-[11px] text-emerald-300/90 font-mono truncate">
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
