import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

/** 进场 / 出场时长（ms）。
 *
 * 这两个数**同时**喂给 CSS 和 JS：CSS 拿它做动画，JS 拿它决定什么时候真的卸载。
 * 各写一份迟早会漂（改了 CSS 忘了改 JS，就变成"面板已经滑走了但 DOM 还挂着"
 * 或者更糟 —— 动画没放完就被摘掉，看起来像卡了一下），所以由组件通过内联变量下发，
 * CSS 侧只读 `var(--drawer-*)`。
 *
 * ⚠️ **遮罩没有自己的时长**（上一版有一个 `FADE_MS = 180`，已删）。
 * 遮罩曾经是 `180ms ease-out`，面板是另外两条曲线、另外两个时长 ——
 * 实测两者**最大差 21.1 个百分点**（t=60ms 时面板已走 69.9%，遮罩才 48.8% 黑），
 * 观感是"面板先冲到位、房间后暗下来"，两个动作。
 * 现在遮罩和面板共用同一条曲线、同一个时长，脱节结构性归零。
 * **别再给遮罩单独配时长了。**
 *
 * 时长本身也收短了（进 280→240 / 出 210→200）：配合换成 easeOutQuad 的曲线，
 * 旧曲线在 280ms 里有 121ms 是"几乎不动的死尾巴"（97% 的位移在 57% 的时长就完成），
 * 现在死尾巴只剩 15%。曲线本身在 styles.css 抽屉段落里，那里写了完整依据。
 */
const ENTER_MS = 240;
const EXIT_MS = 200;

/** 出场比进场短一点，收得干脆 —— 打开可以慢，关闭必须利落。 */
const UNMOUNT_SLACK_MS = 40;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** 同时开着的抽屉数。关掉的那个在出场动画结束后会还焦点，
 *  这时如果另一个抽屉已经开着，还焦点会把焦点从它身上抢走。 */
let openDrawerCount = 0;

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/** 跟随系统的「减少动态效果」。
 *
 *  注意本仓库此前**没有任何**动效做过这个判断（`grep prefers-reduced-motion` 为空）。
 *  这里至少把新加的动画兜住：开了就直接切换，不留动画、也不留等动画的定时器。
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

type DrawerProps = {
  open: boolean;
  onClose: () => void;
  /** 面板的无障碍名（读屏播报用），例如「任务队列」 */
  label: string;
  /** 遮罩按钮的可访问名，是个动作，例如「关闭队列」 */
  closeLabel: string;
  children: ReactNode;
};

/** 右侧抽屉（缓存管理 / 任务队列共用）。
 *
 *  抽出来的原因有两个，都不是"少写几行"：
 *  1. **动画要有唯一落点。** 以前两个面板各写一遍 `fixed inset-0` + `aside` 壳，
 *     加动画就变成两处要同步改 —— 迟早一个有一个没有。
 *  2. **进出场都算。** React 一卸载就没了，只写进场等于只做了一半；
 *     这里在关闭时先切到 closed 态放完动画，再卸载。
 *
 *  ⚠️ **开合态直接挂在 `open` 上，不要再引入第二个 state 去做"两段式"切换。**
 *  这块 DOM 是 React 按需挂载的：挂载那一提交里 `.drawer` 已经是 `data-state="open"`，
 *  面板元素**诞生的瞬间就是终态**。用 transition 的话浏览器只看到终态、不会补间
 *  （面板"啪"地出现）；想救就得靠 rAF + 强制回流去凑一个"先前状态"，而那次 rAF
 *  与 React 提交 `setMounted` 的调度顺序不受我们控制 —— 于是变成
 *  "有时候有动画、有时候直接跳出来"。
 *  改用 keyframes 之后这个前提直接消失：动画在元素匹配到规则的那一刻就开始播，
 *  不需要任何先前状态，也不需要任何 JS 卡时序（详见 styles.css 的抽屉段落）。
 */
export function Drawer({ open, onClose, label, closeLabel, children }: DrawerProps) {
  const reduced = usePrefersReducedMotion();
  /** DOM 里到底有没有这棵子树。关闭后要留到出场动画放完才摘。 */
  const [mounted, setMounted] = useState(open);
  const panelRef = useRef<HTMLElement>(null);
  /** 打开前焦点在谁身上，关闭后还给它 */
  const prevFocusRef = useRef<HTMLElement | null>(null);

  // 挂载 / 卸载时机。视觉上的开合由 `open` 直接驱动 CSS，这里只管 DOM 的生命周期。
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (reduced) {
      setMounted(false);
      return;
    }
    // 留一点余量：animationend 不保证会来（动画被打断、元素被隐藏、时长被系统改过）
    const id = window.setTimeout(() => setMounted(false), EXIT_MS + UNMOUNT_SLACK_MS);
    return () => window.clearTimeout(id);
  }, [open, reduced]);

  // 打开时把焦点收进面板 —— 否则 Tab 会跑到被遮罩盖住的正文里去。
  // 不用 rAF：这个 effect 跑的时候提交已经完成，panelRef.current 就是活的。
  //
  // ⚠️ **`preventScroll: true` 是必须的，不是保险。** 实测过不带的后果：
  //   挂载那一刻面板在 `translateX(100%)`（屏幕右侧外），而 `.drawer` 壳子是
  //   `overflow: hidden` —— 那可是个**能用脚本滚动的滚动容器**
  //   （实测 `scrollWidth=1348 / clientWidth=900`，正好多出一个面板宽）。
  //   `focus()` 默认会把元素滚进可视区，于是壳子被滚了整整 448px：
  //     · 滚动量恰好抵消 transform → 面板**瞬间出现在停靠位**；
  //     · 动画继续跑（translateX 448→0）而滚动量不再变 → 面板**一路滑到最左边**；
  //     · 动画结束、可滚面积收缩，浏览器把 `scrollLeft` 夹回 0 → 面板**跳回正确位置**。
  //   用户看到的就是"直接弹到最左边、再回到正确的位置"。
  //   壳子那边同时改成 `overflow-clip`（见下），两层都堵上。
  useEffect(() => {
    if (!open || !mounted) return;
    const panel = panelRef.current;
    if (!panel) return;
    // 只在焦点**还没在面板里**的时候记一次，否则 StrictMode 下重跑会把面板自己记成"来源"
    if (!panel.contains(document.activeElement)) {
      prevFocusRef.current = document.activeElement as HTMLElement | null;
    }
    panel.focus({ preventScroll: true });
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return;
    openDrawerCount += 1;
    return () => {
      openDrawerCount -= 1;
    };
  }, [open]);

  // 关闭（且已经卸载干净）之后，把焦点还给当初打开它的那个按钮。
  // 另一个抽屉还开着时不还：定时器会把焦点从那个抽屉里拉走。
  useEffect(() => {
    if (open || mounted) return;
    const prev = prevFocusRef.current;
    prevFocusRef.current = null;
    if (openDrawerCount > 0) return;
    prev?.focus?.({ preventScroll: true });
  }, [open, mounted]);

  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    // 陷阱只圈面板：scrim 按钮在 DOM 序里位于 panel 之前，若一起圈进来，
    // 从面板最后控件 Tab 会先"落到面板外"的遮罩上再绕回
    const panel = panelRef.current;
    if (!panel) return;
    const items = focusableIn(panel);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && items.includes(active);
    if (!inside) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus({ preventScroll: true });
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  if (!mounted) return null;

  // 壳子用 `overflow-clip` 而不是 `overflow-hidden`：后者是**能用脚本滚动的滚动容器**，
  // focus()/scrollIntoView 一碰它就会滚起来（上面那个"弹到最左边"的 bug 就是这么来的）。
  // `clip` 不产生滚动容器，`scrollLeft` 永远是 0，谁也滚不动它。
  // （`clip` 只是裁切，视觉效果与 hidden 一致；Safari 16+ / macOS 13+ 起支持，本项目够用。）
  return (
    <div
      className="drawer fixed inset-0 z-40 flex justify-end overflow-clip"
      data-state={open ? "open" : "closed"}
      onKeyDown={trapTab}
      style={
        {
          "--drawer-enter": `${ENTER_MS}ms`,
          "--drawer-exit": `${EXIT_MS}ms`,
        } as CSSProperties
      }
    >
      {/* 遮罩用 bg-black/30：和书库那边的浮层一个量级。
          原来的 /50 是"弹窗"的浓度，侧栏滑出来时把整页压得太黑。 */}
      <button
        type="button"
        className="drawer-scrim absolute inset-0 bg-black/30"
        aria-label={closeLabel}
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="drawer-panel relative flex h-full w-full max-w-md flex-col border-l border-ink-200 bg-white shadow-drawer outline-none dark:border-white/10 dark:bg-surface"
      >
        {children}
      </aside>
    </div>
  );
}

/** 面板统一的关闭控件。
 *
 *  以前队列是「关闭队列」文字按钮、缓存是 × 图标 —— 同一个动作、两种外观。
 *  提到这里之后两个面板共用一份，改也只会改一处。
 */
export function PanelCloseButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className="btn-ghost !h-6 !w-6 !p-0"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" aria-hidden="true">
        <path
          d="M5.6 5.6l8.8 8.8M14.4 5.6l-8.8 8.8"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </button>
  );
}

export function PanelFeedback({
  message,
  dismissLabel,
  onDismiss,
}: {
  message: string | null;
  dismissLabel: string;
  onDismiss: () => void;
}) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="mb-3 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-800 dark:border-danger-border dark:bg-danger-soft dark:text-danger-fg"
    >
      <p className="min-w-0 flex-1">{message}</p>
      <button
        type="button"
        className="shrink-0 rounded px-1 text-sm leading-none opacity-75 hover:opacity-100"
        aria-label={dismissLabel}
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
