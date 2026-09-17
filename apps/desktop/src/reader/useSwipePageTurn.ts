import { useEffect, useRef, type RefObject } from "react";
import type { ReadDirection } from "./prefs";

/** Horizontal must dominate vertical so diagonal scroll does not turn pages. */
export const SWIPE_AXIS_RATIO = 1.25;
/** Ignore sub-pixel jitter; still count small trackpad ticks toward the threshold. */
export const SWIPE_MIN_DELTA_PX = 2;
/** Accumulated |deltaX| before one page turn. */
export const SWIPE_THRESHOLD_PX = 48;
/**
 * 静默多久算「手指已离开」。只作兜底:惯性事件之间约 16ms 一帧,远小于它,
 * 所以这个判据单独用不足以结束手势(见 startsNewGesture)。
 */
export const SWIPE_GESTURE_GAP_MS = 180;
/**
 * 惯量(动量)是平滑几何衰减:每帧只掉几个百分点。手指阶段里的减速是手在变速,
 * 每帧能掉 20%~60%。这一条阈值就是拿这个物理差异来区分「抬手留下的惯量」和
 * 「手中途慢了一下」。
 */
export const SWIPE_INERTIA_RATIO = 0.9;
/** 认定「刚才确实是惯量在衰减」所需的连续平滑衰减帧数。 */
export const SWIPE_INERTIA_MIN_FRAMES = 3;
/**
 * 判定新手势时,谷底必须足够低。手在中途只是慢一下时,速度不会真掉到个位数;
 * 而手指重新按下总是从接近静止起步,开头几帧必然很小。
 *
 * 但幅度尺度随抬手速度变化:一次 120px/帧的快速甩动,新手指按下的第一帧就有
 * 8~9px —— 相对「从静止起步」它确实很小,绝对值却过不了 6px。只用绝对阈值会把
 * 快速连甩后半段整段吞掉(实测:抬手 60~120px/帧、连甩间隔 250ms 时丢页)。
 * 所以谷底判据用「或」:绝对值够低,或者低到本次手势峰值的这个比例以下。
 */
export const SWIPE_TROUGH_MAX_PX = 6;
/**
 * 谷底相对于本次手势峰值的「足够低」比例(快速甩动时走这一支)。
 * 0.18 是量出来的:峰值 ≤33px 的手势仍由上面那 6px 下限兜住,这里只对快速甩动
 * 生效;再往下调会在 60~120px/帧 的连甩上各差 1~2px 而丢页。
 */
export const SWIPE_TROUGH_PEAK_RATIO = 0.18;
/** 谷底之上回升多少倍算手指重新按下。 */
export const SWIPE_REBOUND_RISE_RATIO = 1.5;
/** 回升的绝对下限,避免尾部极小值之间的抖动被误判成新的手指动作。 */
export const SWIPE_REBOUND_MIN_PX = 4;

export function wheelDeltaPx(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * 800;
  return delta;
}

export function isHorizontalWheel(deltaX: number, deltaY: number): boolean {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return false;
  if (Math.abs(deltaX) < SWIPE_MIN_DELTA_PX) return false;
  return Math.abs(deltaX) >= Math.abs(deltaY) * SWIPE_AXIS_RATIO;
}

/**
 * 横向占优、但幅度还没到 SWIPE_MIN_DELTA_PX 的帧不参与累计,却仍然应该拦住
 * 容器的原生滚动。手势的第一帧常常只有一两像素,过去这种帧漏给了浏览器,
 * 容器就开始自己横向平移并起惯性 —— 那串惯性事件正是让翻页锁解不开的输入源。
 */
export function isHorizontalDominantWheel(deltaX: number, deltaY: number): boolean {
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return false;
  return deltaX !== 0 && Math.abs(deltaX) > Math.abs(deltaY);
}

/**
 * Trackpad: fingers move left → content tracks left → scrollRight → deltaX > 0.
 * LTR treats that as next page (same as clicking the right 35% zone).
 */
export function turnDirFromDeltaX(deltaX: number, direction: ReadDirection): 1 | -1 {
  const ltr: 1 | -1 = deltaX > 0 ? 1 : -1;
  return direction === "rtl" ? ((-ltr) as 1 | -1) : ltr;
}

export type SwipeSession = {
  acc: number;
  locked: boolean;
  lastAt: number | null;
  /** 上一次水平采样的 |deltaX|。 */
  lastMag: number;
  /** 当前连续「平滑衰减」的帧数(每帧掉幅不超过 SWIPE_INERTIA_RATIO)。 */
  gentleRun: number;
  /** 本次翻页之后是否已经确认出现过一段惯量(平滑衰减够长)。 */
  sawInertia: boolean;
  /** 本次翻页之后的幅度谷底,只降不升。 */
  trough: number;
  /** 本次翻页之后见过的最大幅度(手指阶段的峰值),用于给谷底判据定尺度。 */
  peak: number;
};

export const EMPTY_SWIPE_SESSION: SwipeSession = {
  acc: 0,
  locked: false,
  lastAt: null,
  lastMag: 0,
  gentleRun: 0,
  sawInertia: false,
  trough: 0,
  peak: 0,
};

/**
 * 这一帧是否属于一次新手势。
 *
 * 两个历史 bug 决定了这里的形状:
 *
 * 1) 「翻几次之后完全失效」——惯量事件能持续 1–4 秒且首尾相连(约 16ms 一帧),
 *    只看「距上一帧超过 180ms」的话这个条件永远不成立,locked 被一帧帧续期;
 *    手指再次按下(在 macOS 上会打断惯性)也凑不出 180ms 静默,于是那次甩动被并进
 *    同一个手势、翻不动页,它自己又产生新的惯量继续续期 —— 锁再也解不开。
 *    所以必须补一条与时间无关的判据。
 *
 * 2) 「滑一次翻两页」——如果只用「幅度回升」当新手势,那么同一次滑动里手变速
 *    (中途慢一下再加速、长距离拖动速度起伏)都会被判成一次又一次按下,一次划动
 *    能翻出好几页。
 *
 * 区分点是惯量的物理形状:抬手后留下的是平滑几何衰减(每帧几个百分点),而手在
 * 中途变速是急降(每帧 20%~60%)。所以要求「先确认存在一段够长的平滑衰减」,
 * 且谷底必须真的低 —— 手指重新按下总是从接近静止起步,不管上一次甩得多快。
 */
export function startsNewGesture(
  session: SwipeSession,
  mag: number,
  now: number,
): boolean {
  if (session.lastAt == null) return true;
  if (now - session.lastAt >= SWIPE_GESTURE_GAP_MS) return true;
  // 只在已锁定时用于解锁:未锁定时手势本来就在累计,不需要重启。
  if (!session.locked) return false;
  const troughLimit = Math.max(
    SWIPE_TROUGH_MAX_PX,
    session.peak * SWIPE_TROUGH_PEAK_RATIO,
  );
  return (
    session.sawInertia &&
    mag > session.lastMag &&
    session.trough > 0 &&
    session.trough <= troughLimit &&
    mag >= Math.max(SWIPE_REBOUND_MIN_PX, session.trough * SWIPE_REBOUND_RISE_RATIO)
  );
}

/**
 * One wheel sample. A lock lasts only for this continuous stream; a new
 * finger-down (silence, or a rebound out of the inertia trough) starts a new swipe.
 */
export function reduceSwipeWheel(
  session: SwipeSession,
  deltaX: number,
  deltaY: number,
  now = 0,
): { session: SwipeSession; turnAcc: number; prevent: boolean } {
  const horizontal = isHorizontalWheel(deltaX, deltaY);
  const mag = Math.abs(deltaX);
  // 横向占优的帧一律不许容器自己滚,哪怕幅度还不够计入翻页累计。
  const holdScroll = isHorizontalDominantWheel(deltaX, deltaY) || horizontal;

  const live = startsNewGesture(session, mag, now)
    ? { ...EMPTY_SWIPE_SESSION }
    : session;

  if (!horizontal) {
    if (live.lastAt == null && !live.locked && live.acc === 0) {
      return { session: live, turnAcc: 0, prevent: holdScroll };
    }
    // Keep the gesture alive through mixed ticks so a mostly-horizontal swipe
    // is not dropped, but do not accumulate vertical-dominant motion.
    // (衰减计数只在水平帧上推进,所以这里不动 lastMag / trough / peak。)
    return {
      session: { ...live, lastAt: now },
      turnAcc: 0,
      prevent: holdScroll || live.locked || Math.abs(live.acc) > 0,
    };
  }

  // 惯量是平滑几何衰减:每帧只掉几个百分点。手在中途变速是急降(20%~60%/帧),
  // 两者在「相邻帧衰减比」上分得开 —— 这就是区分惯量与手指阶段的唯一依据。
  const decaying = mag < live.lastMag;
  const gentle = decaying && mag >= live.lastMag * SWIPE_INERTIA_RATIO;
  const gentleRun = gentle ? live.gentleRun + 1 : 0;
  const sawInertia = live.sawInertia || gentleRun >= SWIPE_INERTIA_MIN_FRAMES;
  // 谷底只降不升,且从「翻页那一刻」起算:
  //  - 只降不升:手指按下后的第一帧常常还低于惯量末帧,那一帧不能把状态清掉,
  //    否则回升判据会一直等不到「越过谷底」。
  //  - 从翻页起算:用力甩动的翻页往往发生在手指阶段中段,此后手指还会加速到抬手
  //    速度,只有从翻页那帧开始量,才能把「加速段」和后面真正的最低点分开。
  const trough = live.trough > 0 ? Math.min(live.trough, mag) : mag;
  // 峰值与谷底同理:从翻页那帧起算,给谷底判据提供本量级的尺度。
  const peak = Math.max(live.peak, mag);
  const carried = {
    lastAt: now,
    lastMag: mag,
    gentleRun,
    sawInertia,
    trough,
    peak,
  };

  if (live.locked) {
    return {
      session: { ...carried, acc: 0, locked: true },
      turnAcc: 0,
      prevent: true,
    };
  }

  const acc = live.acc + deltaX;
  if (Math.abs(acc) >= SWIPE_THRESHOLD_PX) {
    return {
      // 刚翻过页:谷底与衰减标记从这一帧重新开始记。
      session: {
        ...carried,
        acc: 0,
        locked: true,
        gentleRun: 0,
        sawInertia: false,
        trough: mag,
        peak: mag,
      },
      turnAcc: acc,
      prevent: true,
    };
  }
  return {
    session: { ...carried, acc, locked: false },
    turnAcc: 0,
    prevent: true,
  };
}

export function useSwipePageTurn(opts: {
  enabled: boolean;
  direction: ReadDirection;
  go: (dir: 1 | -1) => void;
  viewportRef: RefObject<HTMLDivElement | null>;
}): void {
  const goRef = useRef(opts.go);
  goRef.current = opts.go;
  const directionRef = useRef(opts.direction);
  directionRef.current = opts.direction;

  useEffect(() => {
    if (!opts.enabled) return;
    const el = opts.viewportRef.current;
    if (!el) return;

    let session: SwipeSession = { ...EMPTY_SWIPE_SESSION };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      const next = reduceSwipeWheel(
        session,
        wheelDeltaPx(e.deltaX, e.deltaMode),
        wheelDeltaPx(e.deltaY, e.deltaMode),
        e.timeStamp,
      );
      if (next.prevent) e.preventDefault();
      if (next.turnAcc !== 0) {
        goRef.current(turnDirFromDeltaX(next.turnAcc, directionRef.current));
      }
      session = next.session;
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
    };
  }, [opts.enabled, opts.viewportRef]);
}
