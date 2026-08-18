import {
  LogicalPosition,
  LogicalSize,
  currentMonitor,
  getCurrentWindow,
} from "@tauri-apps/api/window";

export type ContentSize = { width: number; height: number };

/** 进入阅读器前保存的主窗口几何，返回时恢复 */
export type WindowGeometry = {
  width: number;
  height: number;
  x: number;
  y: number;
};

const DEFAULT_MIN = { width: 900, height: 640 };
const SMART_MIN = { width: 360, height: 320 };

/** 模块级缓存：同一阅读会话只记一次进入前的主窗尺寸 */
let savedMainGeometry: WindowGeometry | null = null;
/** 工具栏高度（含边框）——单一来源：ReaderView 挂载时写入 CSS 变量 --reader-bar-h */
export const READER_BAR_H = 44;

/** 把工具栏高度注入 CSS 变量（.reader-bar 高度引用它），保证 TS/CSS 单一来源 */
export function syncReaderBarHeightCss(): void {
  document.documentElement.style.setProperty("--reader-bar-h", `${READER_BAR_H}px`);
}
/** 窗口与屏幕边缘的安全边距（逻辑像素） */
const SCREEN_MARGIN = 24;

export function loadImageNaturalSize(url: string): Promise<ContentSize> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () =>
      resolve({
        width: Math.max(1, img.naturalWidth || img.width),
        height: Math.max(1, img.naturalHeight || img.height),
      });
    img.onerror = () => reject(new Error("image load failed"));
    img.src = url;
  });
}

/** 当前可见页拼成的内容区尺寸（双页并排） */
export function measurePageContent(
  sizes: ContentSize[],
  spread: "single" | "double",
): ContentSize {
  if (sizes.length === 0) return { width: 800, height: 1200 };
  if (spread === "double" && sizes.length >= 2) {
    return {
      width: sizes[0].width + sizes[1].width,
      height: Math.max(sizes[0].height, sizes[1].height),
    };
  }
  return { width: sizes[0].width, height: sizes[0].height };
}

/**
 * 按漫画内容比例调整应用窗口（一次）。
 * @param center 是否居中到当前显示器（仅用户主动「贴合」时建议 true）
 */
export async function applySmartWindowFit(opts: {
  content: ContentSize;
  barVisible: boolean;
  /** 默认 false：只改尺寸，不挪窗口位置，避免阅读时窗口乱跳 */
  center?: boolean;
}): Promise<void> {
  const win = getCurrentWindow();
  const chromeH = opts.barVisible ? READER_BAR_H : 0;
  const contentW = Math.max(1, opts.content.width);
  const contentH = Math.max(1, opts.content.height);

  const needW = contentW;
  const needH = contentH + chromeH;

  let maxW = 1800;
  let maxH = 1200;
  let monX = 0;
  let monY = 0;
  let monW = maxW;
  let monH = maxH;
  try {
    const mon = await currentMonitor();
    if (mon) {
      const scale = mon.scaleFactor || (await win.scaleFactor());
      monW = mon.size.width / scale;
      monH = mon.size.height / scale;
      monX = mon.position.x / scale;
      monY = mon.position.y / scale;
      maxW = Math.max(SMART_MIN.width, monW - SCREEN_MARGIN * 2);
      maxH = Math.max(SMART_MIN.height, monH - SCREEN_MARGIN * 2);
    }
  } catch {
    /* 非 Tauri 或权限不足 */
  }

  const fitScale = Math.min(1, maxW / needW, maxH / needH);
  const winW = Math.max(SMART_MIN.width, Math.round(needW * fitScale));
  const winH = Math.max(SMART_MIN.height, Math.round(needH * fitScale));

  try {
    await win.setMinSize(new LogicalSize(SMART_MIN.width, SMART_MIN.height));
    await win.setSize(new LogicalSize(winW, winH));
    if (opts.center) {
      const x = Math.round(monX + (monW - winW) / 2);
      const y = Math.round(monY + (monH - winH) / 2);
      await win.setPosition(new LogicalPosition(Math.max(monX, x), Math.max(monY, y)));
    }
  } catch {
    /* dev 浏览器无窗口 API */
  }
}

/** 离开智能适应时恢复默认最小尺寸 */
export async function restoreDefaultWindowMinSize() {
  try {
    const win = getCurrentWindow();
    await win.setMinSize(new LogicalSize(DEFAULT_MIN.width, DEFAULT_MIN.height));
  } catch {
    /* ignore */
  }
}

/** 竖读：允许把窗口缩到比书库默认更窄，图片才能跟着变小、一页能看全。 */
export async function allowCompactWindowMinSize() {
  try {
    const win = getCurrentWindow();
    await win.setMinSize(new LogicalSize(SMART_MIN.width, SMART_MIN.height));
  } catch {
    /* ignore */
  }
}

/** 根据已加载页 URL 列表量尺寸并贴合窗口 */
export async function fitWindowToPageUrls(
  urls: string[],
  spread: "single" | "double",
  barVisible: boolean,
  center: boolean,
): Promise<void> {
  if (urls.length === 0) return;
  const sizes = await Promise.all(urls.map((u) => loadImageNaturalSize(u)));
  const content = measurePageContent(sizes, spread);
  await applySmartWindowFit({ content, barVisible, center });
}

/** 进入阅读器时调用：若尚未保存，则记下当前主窗口几何 */
export async function rememberMainWindowGeometry(): Promise<void> {
  if (savedMainGeometry) return;
  try {
    const win = getCurrentWindow();
    const scale = await win.scaleFactor();
    const size = await win.outerSize();
    const pos = await win.outerPosition();
    savedMainGeometry = {
      width: Math.round(size.width / scale),
      height: Math.round(size.height / scale),
      x: Math.round(pos.x / scale),
      y: Math.round(pos.y / scale),
    };
  } catch {
    savedMainGeometry = null;
  }
}

/** 离开阅读器时调用：恢复进入前的主窗口大小与位置，并恢复最小尺寸 */
export async function restoreMainWindowGeometry(): Promise<void> {
  const g = savedMainGeometry;
  savedMainGeometry = null;
  try {
    const win = getCurrentWindow();
    await win.setMinSize(new LogicalSize(DEFAULT_MIN.width, DEFAULT_MIN.height));
    // 若仍全屏，先退出以免 setSize 无效
    try {
      if (await win.isFullscreen()) {
        await win.setFullscreen(false);
      }
    } catch {
      /* ignore */
    }
    if (g) {
      await win.setSize(new LogicalSize(g.width, g.height));
      await win.setPosition(new LogicalPosition(g.x, g.y));
    }
  } catch {
    /* ignore */
  }
}
