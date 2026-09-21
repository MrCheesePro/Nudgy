import { readPref, usePref } from "./prefs";

/**
 * Where the panels on Today sit, and how much room each gets.
 *
 * A per-viewer preference, so it lives in `localStorage` beside the chart toggles rather
 * than in the settings table — this is furniture, not data, and it never needs to reach
 * Rust or survive a reinstall.
 *
 * Deliberately small. A split and a hidden list is enough to fix "this one needs more
 * room" without inventing a grid system that can be dragged into a state nothing renders
 * from. The order is fixed: the panels read left to right for a reason, and swapping them
 * buys nothing that resizing does not.
 */

export type PanelId = "breakdown" | "apps";

export interface Layout {
  /** Width of the first panel relative to the second. */
  ratio: number;
  hidden: PanelId[];
}

export const PANEL_NAMES: Record<PanelId, string> = {
  breakdown: "Tracked today",
  apps: "Where the time went",
};

/** The fixed order, left to right. */
export const ALL: PanelId[] = ["breakdown", "apps"];

export const DEFAULT_LAYOUT: Layout = { ratio: 1.25, hidden: [] };

/** Past these the narrower panel stops being able to show anything useful. */
export const MIN_RATIO = 0.45;
export const MAX_RATIO = 2.6;

const KEY = "layout.today";

/**
 * Repairs whatever came out of storage.
 *
 * A stored layout outlives the code that wrote it: a panel may have been renamed or
 * removed since. Ids nothing knows about are dropped, and a nonsense ratio falls back to
 * the default.
 */
export function normalise(stored: Partial<Layout> | null): Layout {
  const ratio = Number(stored?.ratio);
  const hidden = (stored?.hidden ?? []).filter((id): id is PanelId => ALL.includes(id));

  return {
    ratio:
      Number.isFinite(ratio) && ratio > 0
        ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
        : DEFAULT_LAYOUT.ratio,
    // Never hide everything: a blank page with no way back is not a layout.
    hidden: hidden.length >= ALL.length ? [] : hidden,
  };
}

export function useLayout(): [Layout, (next: Layout) => void] {
  const [raw, write] = usePref<Layout>(KEY, DEFAULT_LAYOUT);
  return [normalise(raw), (next) => write(normalise(next))];
}

export function readLayout(): Layout {
  return normalise(readPref<Layout>(KEY, DEFAULT_LAYOUT));
}

/** The visible panels, in their fixed order. */
export function visiblePanels(layout: Layout): PanelId[] {
  return ALL.filter((id) => !layout.hidden.includes(id));
}

/**
 * The grid columns for a layout.
 *
 * One visible panel takes the whole row rather than sitting in a half-width column with
 * a gap where its neighbour used to be.
 */
export function gridColumns(layout: Layout): string {
  const visible = visiblePanels(layout);
  if (visible.length <= 1) return "minmax(0, 1fr)";
  return `minmax(0, ${layout.ratio}fr) minmax(0, 1fr)`;
}
