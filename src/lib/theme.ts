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
  root.style.colorScheme = "light";

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
