import { describe, expect, it } from "vitest";

import {
  DEFAULT_LAYOUT,
  gridColumns,
  MAX_RATIO,
  MIN_RATIO,
  normalise,
  reorder,
  visiblePanels,
  type PanelId,
} from "./layout";

describe("normalise", () => {
  it("returns the default when there is nothing stored", () => {
    expect(normalise(null)).toEqual(DEFAULT_LAYOUT);
  });

  /**
   * A stored layout outlives the code that wrote it. A panel renamed or removed since
   * must not leave the page with something it cannot render.
   */
  it("drops panels it no longer knows and appends ones it gained", () => {
    const layout = normalise({ order: ["apps", "ghost"] as PanelId[] });
    expect(layout.order).toEqual(["apps", "breakdown"]);
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

describe("reorder", () => {
  const order: PanelId[] = ["breakdown", "apps"];

  it("moves a panel to where the target was", () => {
    expect(reorder(order, "apps", "breakdown")).toEqual(["apps", "breakdown"]);
  });

  it("does nothing when dropped on itself", () => {
    expect(reorder(order, "apps", "apps")).toEqual(order);
  });

  it("does nothing when the target is not in the order", () => {
    expect(reorder(["breakdown"], "breakdown", "apps")).toEqual(["breakdown"]);
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
