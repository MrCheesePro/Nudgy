import { describe, expect, it } from "vitest";

import {
  DEFAULT_LAYOUT,
  gridColumns,
  MAX_RATIO,
  MIN_RATIO,
  normalise,
  visiblePanels,
  type PanelId,
} from "./layout";

describe("normalise", () => {
  it("returns the default when there is nothing stored", () => {
    expect(normalise(null)).toEqual(DEFAULT_LAYOUT);
  });

  /**
   * A stored layout outlives the code that wrote it. A panel removed since must not
   * leave the page with something it cannot render.
   */
  it("drops hidden ids it no longer knows", () => {
    expect(normalise({ hidden: ["ghost"] as unknown as PanelId[] }).hidden).toEqual([]);
  });

  it("clamps a ratio dragged past either end", () => {
    expect(normalise({ ratio: 99 }).ratio).toBe(MAX_RATIO);
    expect(normalise({ ratio: 0.01 }).ratio).toBe(MIN_RATIO);
  });

  it("falls back on a ratio that is not a number", () => {
    expect(normalise({ ratio: Number.NaN }).ratio).toBe(DEFAULT_LAYOUT.ratio);
    expect(normalise({ ratio: undefined }).ratio).toBe(DEFAULT_LAYOUT.ratio);
  });

  // A blank page with no way back is not a layout anybody chose.
  it("refuses to hide every panel", () => {
    expect(normalise({ hidden: ["breakdown", "apps"] }).hidden).toEqual([]);
  });

  it("keeps a single hidden panel", () => {
    expect(normalise({ hidden: ["apps"] }).hidden).toEqual(["apps"]);
  });
});

describe("visiblePanels", () => {
  // Fixed left to right: the panels cannot be reordered, so nothing stored can change
  // which one comes first.
  it("keeps the order whatever is hidden", () => {
    expect(visiblePanels(DEFAULT_LAYOUT)).toEqual(["breakdown", "apps"]);
    expect(visiblePanels({ ...DEFAULT_LAYOUT, hidden: ["breakdown"] })).toEqual(["apps"]);
  });
});

describe("gridColumns", () => {
  it("splits on the ratio with both showing", () => {
    expect(gridColumns({ ...DEFAULT_LAYOUT, ratio: 2 })).toContain("2fr");
  });

  // One panel takes the row rather than sitting in half of it beside a gap.
  it("gives the row to the only visible panel", () => {
    const solo = { ...DEFAULT_LAYOUT, hidden: ["apps"] as PanelId[] };
    expect(gridColumns(solo)).toBe("minmax(0, 1fr)");
    expect(visiblePanels(solo)).toEqual(["breakdown"]);
  });
});
