import { describe, expect, it } from "vitest";
import {
  EMPTY_SWIPE_SESSION,
  SWIPE_GESTURE_GAP_MS,
  SWIPE_THRESHOLD_PX,
  isHorizontalDominantWheel,
  isHorizontalWheel,
  reduceSwipeWheel,
  startsNewGesture,
  turnDirFromDeltaX,
  wheelDeltaPx,
  type SwipeSession,
} from "./useSwipePageTurn";
import { stepIndex } from "./readerNav";
import type { SpreadMode } from "./prefs";

describe("isHorizontalWheel", () => {
  it("rejects vertical-dominant and jitter", () => {
    expect(isHorizontalWheel(0, 40)).toBe(false);
    expect(isHorizontalWheel(10, 40)).toBe(false);
    expect(isHorizontalWheel(1, 0)).toBe(false);
  });

  it("accepts clearly horizontal deltas", () => {
    expect(isHorizontalWheel(80, 10)).toBe(true);
    expect(isHorizontalWheel(-80, 20)).toBe(true);
    expect(isHorizontalWheel(20, 10)).toBe(true);
  });
});

describe("isHorizontalDominantWheel", () => {
  it("holds back the container even for sub-threshold horizontal frames", () => {
    expect(isHorizontalDominantWheel(1.5, 0)).toBe(true);
    expect(isHorizontalDominantWheel(-1, 0.2)).toBe(true);
  });

  it("lets vertical scrolling through", () => {
    expect(isHorizontalDominantWheel(0, 40)).toBe(false);
    expect(isHorizontalDominantWheel(3, 40)).toBe(false);
  });
});

describe("turnDirFromDeltaX", () => {
  it("maps positive deltaX to next in LTR", () => {
    expect(turnDirFromDeltaX(80, "ltr")).toBe(1);
    expect(turnDirFromDeltaX(-80, "ltr")).toBe(-1);
  });

  it("inverts for RTL", () => {
    expect(turnDirFromDeltaX(80, "rtl")).toBe(-1);
    expect(turnDirFromDeltaX(-80, "rtl")).toBe(1);
  });
});

describe("wheelDeltaPx", () => {
  it("scales line and page modes to pixels", () => {
    expect(wheelDeltaPx(3, 0)).toBe(3);
    expect(wheelDeltaPx(2, 1)).toBe(32);
  });
});

type Ev = { dx: number; dy: number; t: number };

/**
 * 一次甩动的事件流:
 *   手指阶段 —— 从静止线性加速到抬手速度 vRelease;
 *   惯量阶段 —— macOS 从抬手速度起步逐帧衰减(抬手处不跳变)。
 *
 * rampFrames 是手指接触时长:60Hz 下 1 帧 ≈ 16ms,现实里一次甩动接触
 * 200~300ms(12~18 帧),默认的 6 帧(96ms)是刻意压缩的悲观模型。
 *
 * cancelOnTouchDown 模拟 macOS 行为:手指再次按下会打断惯性,所以上一段的
 * 惯量事件在下一段手指阶段开始处被截断。
 */
function flickEvents(
  starts: number[],
  vRelease = 15,
  decay = 0.95,
  cancelOnTouchDown = true,
  dirs?: number[],
  rampFrames = 6,
): Ev[] {
  const perFlick = starts.map((t0, i) => {
    const dir = dirs?.[i] ?? 1;
    const evs: Ev[] = [];
    let t = t0;
    for (let f = 1; f <= rampFrames; f++) {
      const dx = ((vRelease * f) / rampFrames) * dir;
      evs.push({ dx, dy: Math.abs(dx) * 0.03, t });
      t += 16;
    }
    let v = vRelease;
    while (v > 1 && t < t0 + 6000) {
      evs.push({ dx: v * dir, dy: Math.abs(v) * 0.03, t });
      t += 16;
      v *= decay;
    }
    return evs;
  });
  if (cancelOnTouchDown) {
    for (let i = 0; i + 1 < perFlick.length; i++) {
      const nextStart = starts[i + 1];
      perFlick[i] = perFlick[i].filter((e) => e.t < nextStart);
    }
  }
  return perFlick.flat();
}

function replay(events: Ev[]): { turns: number; session: SwipeSession } {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  let session: SwipeSession = { ...EMPTY_SWIPE_SESSION };
  let turns = 0;
  for (const e of sorted) {
    const next = reduceSwipeWheel(session, e.dx, e.dy, e.t);
    if (next.turnAcc !== 0) turns += 1;
    session = next.session;
  }
  return { turns, session };
}

describe("reduceSwipeWheel", () => {
  it("turns only once while a long swipe stays locked", () => {
    let session: SwipeSession = { ...EMPTY_SWIPE_SESSION };
    let turns = 0;
    for (let i = 0; i < 20; i++) {
      const next = reduceSwipeWheel(session, SWIPE_THRESHOLD_PX, 0, i * 8);
      if (next.turnAcc !== 0) turns += 1;
      session = next.session;
    }
    expect(turns).toBe(1);
    expect(session.locked).toBe(true);
  });

  it("can turn again after a finger-lift gap", () => {
    const first = reduceSwipeWheel({ ...EMPTY_SWIPE_SESSION }, 80, 0, 0);
    expect(first.turnAcc).toBeGreaterThan(0);
    const second = reduceSwipeWheel(first.session, 80, 0, SWIPE_GESTURE_GAP_MS + 1);
    expect(second.turnAcc).toBeGreaterThan(0);
  });

  it("accumulates small trackpad ticks into one turn", () => {
    let session: SwipeSession = { ...EMPTY_SWIPE_SESSION };
    let turns = 0;
    for (let i = 0; i < 12; i++) {
      const next = reduceSwipeWheel(session, 5, 0, i * 8);
      if (next.turnAcc !== 0) turns += 1;
      session = next.session;
    }
    expect(turns).toBe(1);
  });

  it("does not treat a second swipe during inertia as a new turn", () => {
    const first = reduceSwipeWheel({ ...EMPTY_SWIPE_SESSION }, 80, 0, 0);
    const duringInertia = reduceSwipeWheel(first.session, 80, 0, 40);
    expect(duringInertia.turnAcc).toBe(0);
    expect(duringInertia.session.locked).toBe(true);
  });

  it("does not prevent the default for vertical scrolling", () => {
    const vertical = reduceSwipeWheel({ ...EMPTY_SWIPE_SESSION }, 0, 40, 0);
    expect(vertical.prevent).toBe(false);
  });

  it("prevents the default for a sub-threshold horizontal frame", () => {
    const tiny = reduceSwipeWheel({ ...EMPTY_SWIPE_SESSION }, 1.5, 0, 0);
    expect(tiny.prevent).toBe(true);
    expect(tiny.turnAcc).toBe(0);
  });
});

describe("startsNewGesture", () => {
  it("needs a confirmed inertia run before a rebound counts", () => {
    const rising = {
      ...EMPTY_SWIPE_SESSION,
      lastAt: 100,
      locked: true,
      lastMag: 20,
      peak: 20,
      trough: 20,
    };
    expect(startsNewGesture(rising, 40, 116)).toBe(false);
  });

  it("rejects a rebound out of a shallow dip (手指只是慢了一下)", () => {
    const shallow = {
      ...EMPTY_SWIPE_SESSION,
      lastAt: 500,
      locked: true,
      lastMag: 11,
      gentleRun: 3,
      sawInertia: true,
      peak: 15,
      trough: 11,
    };
    expect(startsNewGesture(shallow, 14, 516)).toBe(false);
  });

  it("accepts a rebound out of the inertia trough", () => {
    const decayed = {
      ...EMPTY_SWIPE_SESSION,
      lastAt: 500,
      locked: true,
      lastMag: 4,
      gentleRun: 6,
      sawInertia: true,
      peak: 15,
      trough: 3,
    };
    expect(startsNewGesture(decayed, 6, 516)).toBe(true);
  });

  it("does not fire on a frame that is still decaying", () => {
    const gone = {
      ...EMPTY_SWIPE_SESSION,
      lastAt: 500,
      locked: true,
      lastMag: 20,
      gentleRun: 6,
      sawInertia: true,
      peak: 20,
      trough: 2,
    };
    expect(startsNewGesture(gone, 19, 516)).toBe(false);
  });

  /**
   * 谷底判据带尺度。一次 120px/帧 的快速甩动被下一次按下打断时,新手指的起步帧
   * 绝对值就有 20px —— 相对「从静止起步」它确实很小,但过不了 6px 绝对阈值。
   * 只用绝对值会把快速连甩的后半段整段吞掉(丢页)。
   */
  it("快速甩动后:起步帧绝对值不低,但相对峰值够低 → 认", () => {
    const fast = {
      ...EMPTY_SWIPE_SESSION,
      lastAt: 500,
      locked: true,
      lastMag: 20,
      gentleRun: 6,
      sawInertia: true,
      peak: 120,
      trough: 20,
    };
    expect(startsNewGesture(fast, 40, 516)).toBe(true);
  });

  it("同样的起步帧放在慢速手势里就是不认(尺度不能乱放)", () => {
    const slow = {
      ...EMPTY_SWIPE_SESSION,
      lastAt: 500,
      locked: true,
      lastMag: 20,
      gentleRun: 6,
      sawInertia: true,
      peak: 60,
      trough: 20,
    };
    expect(startsNewGesture(slow, 40, 516)).toBe(false);
  });
});

/**
 * 回归:曾经的失效 bug —— 一次用力甩动会产生 1–4 秒首尾相连的惯量事件,
 * 「距上一帧超过 180ms」永远不成立,locked 被无限续期,再加上下一次甩动自己
 * 也产生惯量继续续期,锁再也解不开,表现就是「翻几次之后双指翻页失效」。
 * 下面这些用例在修复前分别只翻 1 页 / 不翻页。
 */
describe("回归: 长时间惯量下不能卡死", () => {
  for (const decay of [0.9, 0.93, 0.95, 0.97, 0.98]) {
    it(`decay=${decay} 时连续甩 10 次翻 10 页`, () => {
      for (const cadence of [150, 200, 300, 400, 600, 900, 1500]) {
        const starts = Array.from({ length: 10 }, (_, i) => i * cadence);
        expect(replay(flickEvents(starts, 15, decay)).turns).toBe(10);
      }
    });
  }

  it("一次用力甩动只翻一页(抬手速度 10~120)", () => {
    for (const vRelease of [10, 15, 30, 60, 120]) {
      for (const decay of [0.9, 0.95, 0.97, 0.98]) {
        expect(replay(flickEvents([0], vRelease, decay)).turns).toBe(1);
      }
    }
  });

  it("甩右后甩左能翻回去", () => {
    expect(replay(flickEvents([0, 400], 15, 0.95, true, [1, -1])).turns).toBe(2);
    expect(replay(flickEvents([0, 1200], 15, 0.95, true, [1, -1])).turns).toBe(2);
  });

  it("左右交替连翻 10 次就是 10 页", () => {
    const starts = Array.from({ length: 10 }, (_, i) => i * 400);
    const dirs = starts.map((_, i) => (i % 2 === 0 ? 1 : -1));
    expect(replay(flickEvents(starts, 15, 0.95, true, dirs)).turns).toBe(10);
  });
});

/** 每帧幅度序列 → 事件流(16ms 一帧)。 */
function magStream(mags: number[], startAt = 0): Ev[] {
  return mags.map((dx, i) => ({ dx, dy: Math.abs(dx) * 0.03, t: startAt + i * 16 }));
}

/** 抬手后留下的惯量:从抬手速度按 decay 平滑衰减。 */
function inertia(v: number, decay: number, frames = 60): number[] {
  const out: number[] = [];
  let m = v;
  for (let i = 0; i < frames && m > 1; i++) {
    out.push(m);
    m *= decay;
  }
  return out;
}

const RAMP = [2.5, 5, 7.5, 10, 12.5, 15];

/**
 * 回归:「滑一次翻两页」。
 *
 * 真机上手指阶段并不是匀速的 —— 中途会变速:慢一下再加速、几乎停住再加速、
 * 长距离拖动速度起伏。如果「新手势」只靠幅度回升判定,这些都会在一次滑动里
 * 被当成一次又一次按下,一次划动翻出好几页(长距离拖动曾一次翻 4 页)。
 *
 * 判据因此要求:必须先是「平滑几何衰减的惯量」(每帧只掉几个百分点),而手中途
 * 变速是急降(每帧掉 20%~60%),两者形状不同。
 */
describe("回归: 一次滑动只翻一页(手指变速不能当成多次手势)", () => {
  const singleSwipe: Array<[string, number[]]> = [
    ["平滑甩动", [...RAMP, ...inertia(15, 0.95)]],
    [
      "中途急减速再加速",
      [...RAMP, 12, 8, 5, 3.5, 6, 10, 15, 20, 25, ...inertia(25, 0.95)],
    ],
    [
      "中途几乎停住再加速",
      [...RAMP, 9, 4, 3.5, 8, 14, 20, 26, ...inertia(26, 0.95)],
    ],
    ["中途轻微减速再加速", [...RAMP, 14, 12.5, 11, 12, 14, 16, 20, ...inertia(20, 0.95)]],
    [
      "长距离拖动,速度起伏",
      [
        4, 9, 14, 18, 22, 25, 27, 24, 18, 12, 9, 12, 16, 22, 28, 31, 29, 24, 18,
        22, 27, 30, 26, 20, 14, 9, 12, 18, 24, 28, ...inertia(28, 0.95),
      ],
    ],
    ["双峰(手指没离开)", [...RAMP, 13, 9, 5, 2.5, 4, 9, 16, 24, 30, ...inertia(30, 0.95)]],
    /**
     * 手指平滑减速到 12 又推一把 —— 减速段每帧掉 5%(够「平滑」,会被认成惯量),
     * 但谷底 12px 离静止很远。这一条压的是**谷底的尺度判据**:一旦把谷底阈值
     * 放宽到「只要比上个手势峰值低」,这次滑动就会翻 2 页。
     */
    [
      "平滑减速到 12 再推一把(谷底不低)",
      [...RAMP, 14.25, 13.54, 12.86, 12, 19, 24, 30, 36, ...inertia(36, 0.95)],
    ],
  ];

  for (const [name, mags] of singleSwipe) {
    it(`${name} → 1 页`, () => {
      expect(replay(magStream(mags)).turns).toBe(1);
    });
  }

  it("甩动→惯量跑完→再甩 → 2 页", () => {
    const a = magStream([...RAMP, ...inertia(15, 0.95)]);
    const b = magStream([...RAMP, ...inertia(15, 0.95)], 3000);
    expect(replay([...a, ...b]).turns).toBe(2);
  });

  it("甩动→惯量被下一次按下截断 → 2 页", () => {
    const cadence = 350;
    const a = magStream(
      [...RAMP, ...inertia(15, 0.95)].slice(0, Math.floor((cadence - 96) / 16)),
    );
    const b = magStream([...RAMP, ...inertia(15, 0.95)], cadence);
    expect(replay([...a, ...b]).turns).toBe(2);
  });

  it("甩动→抬手静默→再甩 → 2 页", () => {
    const a = magStream([...RAMP, ...inertia(15, 0.95, 8)]);
    const b = magStream([...RAMP, ...inertia(15, 0.95, 8)], 250 + 8 * 16);
    expect(replay([...a, ...b]).turns).toBe(2);
  });
});

/**
 * 回归:「快速连甩丢页」。
 *
 * 快翻页时抬手速度能到 60~120px/帧,而下一次甩动往往落在上一段惯量还没衰减到
 * 个位数之前(抬手到再按下约 250ms,完全在人类操作范围内)。这时新手指出现在一个
 * 「还很响」的惯性尾部上,它的起步帧绝对值就有 10~20px,过不了 6px 的绝对阈值,
 * 于是后半段整段被吞掉 —— 10 次甩动只翻 1 页。
 *
 * 修法是让谷底判据带上尺度:要么绝对值够低,要么低到本次手势峰值的 18% 以下。
 * 峰值 ≤33px 的手势仍由 6px 下限兜住,所以这条只对快速甩动生效。
 */
describe("回归: 快速连甩不能丢页(抬手 60~120px/帧)", () => {
  for (const vRelease of [60, 120]) {
    for (const decay of [0.93, 0.95, 0.97]) {
      for (const cadence of [350, 400, 600, 900, 1500]) {
        it(`v=${vRelease} decay=${decay} cadence=${cadence} → 10 次甩动 10 页`, () => {
          const starts = Array.from({ length: 10 }, (_, i) => i * cadence);
          const events = flickEvents(starts, vRelease, decay, true, undefined, 14);
          expect(replay(events).turns).toBe(10);
        });
      }
    }
  }

  it("接触只有 96ms 的压缩斜坡下也要成立", () => {
    for (const vRelease of [60, 120]) {
      const starts = Array.from({ length: 10 }, (_, i) => i * 600);
      expect(replay(flickEvents(starts, vRelease)).turns).toBe(10);
    }
  });

  it("快速连甩时一次甩动仍然只翻一页(不能反过来多翻)", () => {
    for (const vRelease of [60, 120]) {
      for (const decay of [0.93, 0.95, 0.97]) {
        expect(replay(flickEvents([0], vRelease, decay, true, undefined, 14)).turns).toBe(1);
      }
    }
  });
});

/**
 * 单页 vs 双页:手势层只决定「翻一步」,一步是 1 页还是 1 跨页由 stepIndex 按版式
 * 决定。这里把事件流接到真实的 stepIndex 上,确认一次甩动 = 恰好一步 —— 双页时
 * 一次甩动走 2 页(一跨页),但绝不能因为版式而走出两跨。
 */
describe("单页/双页: 一次甩动只走一步", () => {
  function simulate(spread: SpreadMode, total: number, events: Ev[]) {
    const sorted = [...events].sort((a, b) => a.t - b.t);
    let session: SwipeSession = { ...EMPTY_SWIPE_SESSION };
    let index = 0;
    let turns = 0;
    for (const e of sorted) {
      const next = reduceSwipeWheel(session, e.dx, e.dy, e.t);
      if (next.turnAcc !== 0) {
        index = stepIndex(index, turnDirFromDeltaX(next.turnAcc, "ltr"), spread, total);
        turns += 1;
      }
      session = next.session;
    }
    return { index, turns };
  }

  it("单页:甩 3 次前进 3 页", () => {
    const fwd = flickEvents([0, 600, 1200], 15, 0.95, true, undefined, 14);
    const r = simulate("single", 20, fwd);
    expect(r.turns).toBe(3);
    expect(r.index).toBe(3);
  });

  it("双页:甩 3 次前进 6 页(每次一跨页),且停在偶数页", () => {
    const fwd = flickEvents([0, 600, 1200], 15, 0.95, true, undefined, 14);
    const r = simulate("double", 20, fwd);
    expect(r.turns).toBe(3);
    expect(r.index).toBe(6);
    expect(r.index % 2).toBe(0);
  });

  it("双页:甩过去再甩回来回到起点", () => {
    const fwd = flickEvents([0, 600, 1200], 15, 0.95, true, undefined, 14);
    const back = flickEvents([2000, 2600, 3200], 15, 0.95, true, [-1, -1, -1], 14);
    const r = simulate("double", 20, [...fwd, ...back]);
    expect(r.turns).toBe(6);
    expect(r.index).toBe(0);
  });

  it("双页:一次长距离波动拖动仍只前进一跨页", () => {
    const mags = [
      4, 9, 14, 18, 22, 25, 27, 24, 18, 12, 9, 12, 16, 22, 28, 31, 29, 24, 18, 22,
      27, 30, 26, 20, 14, 9, 12, 18, 24, 28,
    ];
    const evs: Ev[] = mags.map((dx, i) => ({ dx, dy: dx * 0.03, t: i * 16 }));
    const r = simulate("double", 20, evs);
    expect(r.turns).toBe(1);
    expect(r.index).toBe(2);
  });

  it("双页:已在末页时不再越界", () => {
    const fwd = flickEvents([0, 600, 1200, 1800, 2400], 15, 0.95, true, undefined, 14);
    expect(simulate("double", 4, fwd).index).toBe(2);
  });
});
