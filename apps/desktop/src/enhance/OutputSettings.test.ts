import { Window } from "happy-dom";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  localStorage: dom.localStorage,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  getComputedStyle: dom.getComputedStyle.bind(dom),
});

import { cleanup, fireEvent, render, type RenderResult } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import zh from "../i18n/zh-CN.json";
import type { Messages } from "../i18n";
import { OutputSettings } from "./OutputSettings";
import type { ExportQuality, ImgFmt } from "./enhanceViewModel";

const i18n = zh as Messages;
const noop = () => {};

const TIER_LABEL: Record<ExportQuality, string> = {
  high: i18n.qualityHigh,
  balanced: i18n.qualityBalanced,
  compact: i18n.qualityCompact,
  minimal: i18n.qualityMinimal,
};

function renderSettings(imageFormat: ImgFmt, quality: ExportQuality): RenderResult {
  return render(
    createElement(OutputSettings, {
      i18n,
      outputDir: "/tmp/out",
      container: "cbz",
      imageFormat,
      quality,
      onPickOutput: noop,
      onContainerChange: noop,
      onImageFormatChange: noop,
      onQualityChange: noop,
    }),
  );
}

/** The SelectBox trigger button that currently shows `label`. */
function buttonFor(view: RenderResult, label: string): HTMLButtonElement {
  const node = view.getByText(label).closest("button");
  if (!node) throw new Error(`no button for ${label}`);
  return node as HTMLButtonElement;
}

afterEach(cleanup);

describe("OutputSettings quality selector", () => {
  it("shows the selected tier for JPEG and stays interactive", () => {
    const view = renderSettings("jpeg", "balanced");
    const btn = buttonFor(view, TIER_LABEL.balanced);
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute("aria-haspopup")).toBe("listbox");
    expect(view.getByText(i18n.qualityHintBalanced)).toBeTruthy();
  });

  it("renders a distinct label for every tier", () => {
    const seen = new Set<string>();
    for (const q of ["high", "balanced", "compact", "minimal"] as ExportQuality[]) {
      cleanup();
      const view = renderSettings("jpeg", q);
      expect(buttonFor(view, TIER_LABEL[q])).toBeTruthy();
      seen.add(TIER_LABEL[q]);
    }
    expect(seen.size).toBe(4);
  });

  it("disables the selector and explains why for lossless formats", () => {
    for (const fmt of ["png", "webp"] as ImgFmt[]) {
      cleanup();
      const view = renderSettings(fmt, "balanced");
      expect(buttonFor(view, TIER_LABEL.balanced).disabled).toBe(true);
      expect(view.getByText(i18n.qualityHintLossless)).toBeTruthy();
    }
  });

  it("keeps the selector enabled when the source format is unknown", () => {
    const view = renderSettings("same", "compact");
    expect(buttonFor(view, TIER_LABEL.compact).disabled).toBe(false);
  });

  it("disables the selector when same-format follows a PNG page", () => {
    const view = render(
      createElement(OutputSettings, {
        i18n,
        outputDir: "/tmp/out",
        container: "cbz",
        imageFormat: "same",
        quality: "compact",
        sourcePageName: "00001.png",
        onPickOutput: noop,
        onContainerChange: noop,
        onImageFormatChange: noop,
        onQualityChange: noop,
      }),
    );
    expect(buttonFor(view, TIER_LABEL.compact).disabled).toBe(true);
    expect(view.getByText(i18n.qualityHintLossless)).toBeTruthy();
  });

  it("opens the tier list on click and lists all four tiers", () => {
    const view = renderSettings("jpeg", "balanced");
    const btn = buttonFor(view, TIER_LABEL.balanced);
    fireEvent.click(btn);
    const list = view.getByRole("listbox");
    expect(list).toBeTruthy();
    expect(list.querySelectorAll("li").length).toBe(4);
    // placement 方向类名由 pickPlacement 决定（controls.test.ts 覆盖分支）；
    // 这里断言列表是定位容器（否则会撑开卡片布局）且挂了滚动上限
    expect(list.className).toMatch(/absolute/);
    expect(list.className).toMatch(/overflow-y-auto/);
  });

  it("does not open when the format makes quality irrelevant", () => {
    const view = renderSettings("png", "balanced");
    fireEvent.click(buttonFor(view, TIER_LABEL.balanced));
    expect(view.queryByRole("listbox")).toBeNull();
  });
});
