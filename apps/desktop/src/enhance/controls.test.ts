import { describe, expect, it } from "vitest";
import { pickPlacement } from "./controls";

/** 4 options => 4*36 + 8 padding + 6 gap = 158px needed. */
const FOUR = 4;

describe("pickPlacement", () => {
  it("opens downward when the list fits below", () => {
    expect(
      pickPlacement({
        anchorTop: 100,
        anchorBottom: 140,
        boundsTop: 0,
        boundsBottom: 800,
        itemCount: FOUR,
      }),
    ).toBe("down");
  });

  it("opens upward when the list would fall out of view below", () => {
    // button sits near the bottom edge of the scroll area, lots of room above
    expect(
      pickPlacement({
        anchorTop: 700,
        anchorBottom: 740,
        boundsTop: 0,
        boundsBottom: 760,
        itemCount: FOUR,
      }),
    ).toBe("up");
  });

  it("stays downward when there is not enough room on either side", () => {
    // flipping would not help, so keep the list capped and scrollable instead
    expect(
      pickPlacement({
        anchorTop: 30,
        anchorBottom: 70,
        boundsTop: 0,
        boundsBottom: 100,
        itemCount: FOUR,
      }),
    ).toBe("down");
  });

  it("treats an exact fit as fitting", () => {
    // below === need exactly => still downward
    expect(
      pickPlacement({
        anchorTop: 400,
        anchorBottom: 442,
        boundsTop: 0,
        boundsBottom: 600,
        itemCount: FOUR,
      }),
    ).toBe("down");
  });

  it("needs less room for a shorter list", () => {
    // a single option fits in 50px, so a cramped space still opens downward
    expect(
      pickPlacement({
        anchorTop: 200,
        anchorBottom: 240,
        boundsTop: 0,
        boundsBottom: 295,
        itemCount: 1,
      }),
    ).toBe("down");
    // ...but the same gap is too small for four
    expect(
      pickPlacement({
        anchorTop: 200,
        anchorBottom: 240,
        boundsTop: 0,
        boundsBottom: 295,
        itemCount: FOUR,
      }),
    ).toBe("up");
  });
});
