import { useSyncExternalStore } from "react";

import { setSetting } from "./ipc";

/**
 * The app's colour scheme.
 *
 * Tailwind v4 compiles `bg-canvas` down to `var(--color-canvas)`, so a theme is just a set
 * of custom properties written onto `:root`. Nothing needs recompiling and no component
 * learns a theme exists — which is also why category colours are untouched by this: those
 * live in the database and mean something specific, and repainting Gaming purple because
 * you picked a green theme would make two charts disagree about the same hour.
 */

export const SETTING_THEME = "theme";
export const SETTING_ACCENT = "accent_color";

export interface Theme {
  id: string;
  name: string;
  /** Shown as the swatch, so it has to read as the theme at a glance. */
  swatch: [string, string, string];
  tokens: Record<string, string>;
}

export const THEMES: Theme[] = [
  {
    id: "blush",
    name: "Blush",
    swatch: ["#fdf2f3", "#e0919c", "#4a3437"],
    tokens: {
      "--color-canvas": "#fdf2f3",
      "--color-surface": "#ffffff",
      "--color-surface-sunken": "#fbeced",
      "--color-edge": "#f6dee0",
      "--color-edge-strong": "#eec9cd",
      "--color-ink": "#4a3437",
      "--color-ink-soft": "#7d6165",
      "--color-ink-mute": "#a98d90",
      "--color-rose": "#e0919c",
      "--color-rose-deep": "#b8666f",
      "--color-rose-wash": "#fae2e4",
      "--color-rose-bar": "#f0b6bc",
    },
  },
  {
    id: "meadow",
    name: "Meadow",
    swatch: ["#f2f7f1", "#6faa84", "#2f3f34"],
    tokens: {
      "--color-canvas": "#f2f7f1",
      "--color-surface": "#ffffff",
      "--color-surface-sunken": "#e9f1e8",
      "--color-edge": "#dbe8d9",
      "--color-edge-strong": "#c2d7bf",
      "--color-ink": "#2f3f34",
      "--color-ink-soft": "#566b5b",
      "--color-ink-mute": "#8aa190",
      "--color-rose": "#6faa84",
      "--color-rose-deep": "#4a7d5d",
      "--color-rose-wash": "#dff0e3",
      "--color-rose-bar": "#a6d1b3",
    },
  },
  {
    id: "harbor",
    name: "Harbor",
    swatch: ["#f1f5fa", "#5d8fc4", "#2c3a4a"],
    tokens: {
      "--color-canvas": "#f1f5fa",
      "--color-surface": "#ffffff",
      "--color-surface-sunken": "#e7eef7",
      "--color-edge": "#d8e3ef",
      "--color-edge-strong": "#bacfe3",
      "--color-ink": "#2c3a4a",
      "--color-ink-soft": "#52657b",
      "--color-ink-mute": "#8699ad",
      "--color-rose": "#5d8fc4",
      "--color-rose-deep": "#3a6795",
      "--color-rose-wash": "#dde9f6",
      "--color-rose-bar": "#a3c4e2",
    },
  },
  {
    id: "sand",
    name: "Sand",
    swatch: ["#faf6ef", "#c99a5b", "#463b2c"],
    tokens: {
      "--color-canvas": "#faf6ef",
      "--color-surface": "#ffffff",
      "--color-surface-sunken": "#f3ece0",
      "--color-edge": "#eae0cf",
      "--color-edge-strong": "#d9c8ac",
      "--color-ink": "#463b2c",
      "--color-ink-soft": "#6f6150",
      "--color-ink-mute": "#a3927c",
      "--color-rose": "#c99a5b",
      "--color-rose-deep": "#9c723a",
      "--color-rose-wash": "#f4e7d2",
      "--color-rose-bar": "#e0c091",
    },
  },
  {
    id: "dusk",
    name: "Dusk",
    swatch: ["#1e1b24", "#b79ae0", "#ece8f2"],
    tokens: {
      // Dark, so the ink and canvas swap roles. Surfaces stay lighter than the page for
      // the same reason they do in the light themes: a card has to lift off the page.
      "--color-canvas": "#1e1b24",
      "--color-surface": "#272330",
      "--color-surface-sunken": "#201d27",
      "--color-edge": "#37313f",
      "--color-edge-strong": "#4b4356",
      "--color-ink": "#ece8f2",
      "--color-ink-soft": "#bdb4cb",
      "--color-ink-mute": "#8d84a0",
      "--color-rose": "#b79ae0",
      "--color-rose-deep": "#cdb6ee",
      "--color-rose-wash": "#332c40",
      "--color-rose-bar": "#6f5f8c",
    },
  },
];

export const DEFAULT_THEME = THEMES[0].id;

let current = DEFAULT_THEME;
/** A hex the user picked, or "" for whatever the theme says. */
let accent = "";
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Writes the tokens onto `:root`. Every `bg-*` and `text-*` class follows immediately. */
export function applyTheme(id: string) {
  const theme = THEMES.find((entry) => entry.id === id) ?? THEMES[0];
  const root = document.documentElement;
  for (const [token, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(token, value);
  }
  // Tells the browser to draw native scrollbars and form controls to match, which is the
  // difference between a dark theme and a dark theme with white dropdowns in it.
  root.style.colorScheme = theme.id === "dusk" ? "dark" : "light";

  current = theme.id;
  // After the theme, never before: the accent overrides four of the tokens it just wrote,
  // and applying them the other way round would leave the theme's own accent in place.
  paintAccent();
  for (const listener of listeners) listener();
}

/**
 * One colour of your own, and the theme the app derives from it.
 *
 * A single hex rather than a palette: a theme is twelve colours that have to agree with
 * each other, and picking twelve is the part that is actually hard. `color-mix` derives
 * the other eleven from this one, so any colour produces a whole scheme — surfaces,
 * borders and text, not just the accent.
 *
 * Empty means the chosen theme's own colours, which is why this is stored separately from
 * the theme rather than as an extra entry in `THEMES`: it is a modifier, and clearing it
 * has to put back whatever the theme said.
 */
export function applyAccent(hex: string) {
  accent = hex.trim();
  paintAccent();
  for (const listener of listeners) listener();
}

/**
 * A whole theme from one colour.
 *
 * The proportions are Blush's own, read back out of it: its canvas is about a tenth of
 * its accent over white, its edge about a fifth, its ink about a third of the accent over
 * black. Applying those same ratios to another colour gives a set that hangs together for
 * the same reason Blush does, rather than an accent sitting on top of somebody else's
 * palette.
 *
 * Every surface is mixed toward white and every ink toward black, which is what keeps it
 * legible whatever gets picked: a navy accent still gives pale surfaces and dark text, and
 * so does a pale yellow one. That is the whole safety argument — there is no hue that can
 * produce grey text on a grey card.
 */
const DERIVED: [string, number, "white" | "black"][] = [
  ["--color-canvas", 9, "white"],
  ["--color-surface", 3, "white"],
  ["--color-surface-sunken", 13, "white"],
  ["--color-edge", 20, "white"],
  ["--color-edge-strong", 34, "white"],
  ["--color-ink", 32, "black"],
  ["--color-ink-soft", 52, "black"],
  ["--color-ink-mute", 68, "black"],
  ["--color-rose", 100, "white"],
  ["--color-rose-deep", 74, "black"],
  ["--color-rose-wash", 20, "white"],
  ["--color-rose-bar", 55, "white"],
];

const ACCENT_TOKENS = DERIVED.map(([token]) => token);

function paintAccent() {
  const root = document.documentElement;

  if (!accent) {
    // Cleared, not overwritten — put back whatever the current theme says for each one.
    const theme = THEMES.find((entry) => entry.id === current) ?? THEMES[0];
    for (const token of ACCENT_TOKENS) {
      const value = theme.tokens[token];
      if (value) root.style.setProperty(token, value);
      else root.style.removeProperty(token);
    }
    return;
  }

  for (const [token, percent, toward] of DERIVED) {
    root.style.setProperty(
      token,
      percent >= 100 ? accent : `color-mix(in srgb, ${accent} ${percent}%, ${toward})`,
    );
  }
  // Light surfaces and dark text, whatever the hue — so the native controls match.
  root.style.colorScheme = "light";
}

export function useAccent(): string {
  return useSyncExternalStore(subscribe, () => accent);
}

/** Applies and persists. Empty puts the theme's own accent back. */
export async function chooseAccent(hex: string): Promise<void> {
  applyAccent(hex);
  await setSetting(SETTING_ACCENT, accent);
}

export function useTheme(): string {
  return useSyncExternalStore(subscribe, () => current);
}

/** Applies and persists, so the choice survives a restart. */
export async function chooseTheme(id: string): Promise<void> {
  applyTheme(id);
  await setSetting(SETTING_THEME, id);
}
