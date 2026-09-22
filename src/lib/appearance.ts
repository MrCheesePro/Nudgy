import { useSyncExternalStore } from "react";

import { setSetting } from "./ipc";

/**
 * Text size, typeface and background — the three things that make an app yours.
 *
 * All applied the way [theme.ts](./theme.ts) applies colour: properties written onto
 * `:root`, so no component learns any of this exists.
 *
 * **Text size** multiplies `--text-scale`, which every font size in `index.css` runs
 * through and nothing else does — the words grow and the layout holds. A root
 * `font-size` would have moved every rem with them, so padding and gaps would grow too
 * and "text size" would quietly mean "everything".
 */

export const SETTING_TEXT_SCALE = "text_scale";
export const SETTING_FONT = "font_family";
export const SETTING_BACKGROUND = "background_image";
export const SETTING_PANEL_OPACITY = "panel_opacity";
export const SETTING_BACKGROUND_SAVED = "background_saved";

/**
 * How many backgrounds can be kept.
 *
 * Three, because this is a shortcut between a few images somebody actually alternates
 * between — a morning one, a night one, a plain one — not a library. A list that grows
 * without limit needs naming, ordering and deleting, which is three features to avoid
 * pasting a URL again.
 */
export const MAX_SAVED_BACKGROUNDS = 3;

export const MIN_SCALE = 0.8;
export const MAX_SCALE = 1.5;

/**
 * How solid the panels are.
 *
 * Below about 40% the text on a card starts competing with whatever is behind it, and the
 * chart colours stop meaning what the legend says they mean. Solid is the default: a
 * background you cannot see is the same as no background, but a dashboard you cannot read
 * is worse than a plain one.
 */
export const MIN_PANEL_OPACITY = 0.4;

export interface FontChoice {
  id: string;
  name: string;
  /** Empty means the app's own stack; otherwise a family to load from Google Fonts. */
  google: string;
  stack: string;
}

export const FONTS: FontChoice[] = [
  { id: "default", name: "Inter (default)", google: "", stack: "" },
  { id: "system", name: "System", google: "", stack: "ui-sans-serif, system-ui, sans-serif" },
  { id: "serif", name: "Serif", google: "", stack: "ui-serif, Georgia, Cambria, serif" },
  { id: "lora", name: "Lora", google: "Lora", stack: '"Lora", ui-serif, Georgia, serif' },
  {
    id: "nunito",
    name: "Nunito",
    google: "Nunito",
    stack: '"Nunito", ui-sans-serif, system-ui, sans-serif',
  },
  {
    id: "jetbrains",
    name: "JetBrains Mono",
    google: "JetBrains Mono",
    stack: '"JetBrains Mono", ui-monospace, monospace',
  },
  {
    id: "atkinson",
    name: "Atkinson Hyperlegible",
    google: "Atkinson Hyperlegible",
    stack: '"Atkinson Hyperlegible", ui-sans-serif, system-ui, sans-serif',
  },
];

export interface Appearance {
  /**
   * Type size relative to the layout.
   *
   * A root `font-size`, so it moves text and the space around text together — which is
   * what makes bigger type actually readable rather than cramped into the same box.
   */
  scale: number;
  /** A `FONTS` id, or a raw Google Fonts family name the user typed. */
  font: string;
  /** A URL or data URI drawn behind the app, or empty for none. */
  background: string;
  /** Up to `MAX_SAVED_BACKGROUNDS` kept to switch between, newest first. */
  savedBackgrounds: string[];
  /**
   * How opaque the panels in the content area are, 0.4–1.
   *
   * The top bar and the icon rail are never included. They are the app's own frame —
   * the thing you aim at — and a chrome you can see through is a chrome you have to
   * find. Everything inside that frame is content, and content can float.
   */
  panelOpacity: number;
}

export const DEFAULT_APPEARANCE: Appearance = {
  scale: 1,
  font: "default",
  background: "",
  savedBackgrounds: [],
  panelOpacity: 1,
};

let current: Appearance = { ...DEFAULT_APPEARANCE };
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, () => current);
}

const FONT_LINK_ID = "nudgy-google-font";

/**
 * Loads a Google Fonts family by name.
 *
 * A name rather than a file: no picker, no copying into app data, no format to sniff,
 * and the same one word works on every machine the account is used from. The cost is
 * that a custom family needs the network once — the built-in choices never do.
 */
function loadGoogleFont(family: string) {
  const existing = document.getElementById(FONT_LINK_ID);
  if (!family) {
    existing?.remove();
    return;
  }

  const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(
    family,
  ).replace(/%20/g, "+")}:wght@400;500;600;700&display=swap`;

  const link = (existing as HTMLLinkElement | null) ?? document.createElement("link");
  link.id = FONT_LINK_ID;
  link.rel = "stylesheet";
  if (link.href !== href) link.href = href;
  if (!existing) document.head.appendChild(link);
}

/** Writes the appearance onto `:root`. Everything follows from these three properties. */
export function applyAppearance(next: Partial<Appearance>) {
  current = { ...current, ...next };
  const root = document.documentElement;

  // A multiplier on the font sizes only, never a root `font-size`. Tailwind's spacing is
  // rem too, so scaling the root moved padding, gaps and widths along with the words —
  // which made "text size" quietly mean "everything", and left the Everything slider
  // with nothing of its own to do.
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale));
  root.style.setProperty("--text-scale", String(scale));

  const known = FONTS.find((entry) => entry.id === current.font);
  if (known) {
    loadGoogleFont(known.google);
    // An empty stack means the app's own — clearing the property is how it goes back,
    // rather than restating the default here and having two places to keep in step.
    if (known.stack) root.style.setProperty("--font-sans", known.stack);
    else root.style.removeProperty("--font-sans");
  } else if (current.font.trim()) {
    // Anything else is treated as a Google Fonts family the user typed.
    const family = current.font.trim();
    loadGoogleFont(family);
    root.style.setProperty(
      "--font-sans",
      `"${family}", ui-sans-serif, system-ui, sans-serif`,
    );
  }

  // A percentage the stylesheet mixes into the panel colour. Written even at 1, so
  // turning it back up is the same code path as turning it down.
  const panel = Math.min(1, Math.max(MIN_PANEL_OPACITY, current.panelOpacity));
  root.style.setProperty("--panel-opacity", String(panel));

  root.style.setProperty(
    "--app-background",
    current.background ? `url("${CSS.escape(current.background).replace(/\\"/g, '"')}")` : "none",
  );

  for (const listener of listeners) listener();
}

/** Applies and persists. Each key is written separately so a partial save is coherent. */
export async function saveAppearance(next: Partial<Appearance>): Promise<void> {
  applyAppearance(next);
  const writes: Promise<unknown>[] = [];
  if (next.scale !== undefined) {
    writes.push(setSetting(SETTING_TEXT_SCALE, String(current.scale)));
  }
  if (next.font !== undefined) writes.push(setSetting(SETTING_FONT, current.font));
  if (next.background !== undefined) {
    writes.push(setSetting(SETTING_BACKGROUND, current.background));
  }
  if (next.savedBackgrounds !== undefined) {
    // One row of JSON rather than three keys: the list is read and written whole, and
    // three keys would let it be half-updated.
    writes.push(
      setSetting(SETTING_BACKGROUND_SAVED, JSON.stringify(current.savedBackgrounds)),
    );
  }
  if (next.panelOpacity !== undefined) {
    writes.push(setSetting(SETTING_PANEL_OPACITY, String(current.panelOpacity)));
  }
  await Promise.all(writes);
}

/** Reads what was stored at startup, before anything renders against the defaults. */
export function hydrateAppearance(settings: Map<string, string>) {
  const scale = Number(settings.get(SETTING_TEXT_SCALE));
  const panelOpacity = Number(settings.get(SETTING_PANEL_OPACITY));
  applyAppearance({
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    font: settings.get(SETTING_FONT) ?? "default",
    background: settings.get(SETTING_BACKGROUND) ?? "",
    savedBackgrounds: parseSaved(settings.get(SETTING_BACKGROUND_SAVED)),
    panelOpacity:
      Number.isFinite(panelOpacity) && panelOpacity > 0 ? panelOpacity : 1,
  });
}

/** Whatever was stored, minus anything that is not a non-empty string. */
function parseSaved(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .slice(0, MAX_SAVED_BACKGROUNDS);
  } catch {
    return [];
  }
}

/**
 * Keeps the current background, dropping the oldest once there are three.
 *
 * Saving one already saved moves it to the front rather than adding it twice — the same
 * thing twice in a row of three is a third of the row wasted.
 */
export function saveCurrentBackground(): Promise<void> {
  const url = current.background.trim();
  if (!url) return Promise.resolve();

  const next = [url, ...current.savedBackgrounds.filter((entry) => entry !== url)].slice(
    0,
    MAX_SAVED_BACKGROUNDS,
  );
  return saveAppearance({ savedBackgrounds: next });
}

export function forgetBackground(url: string): Promise<void> {
  return saveAppearance({
    savedBackgrounds: current.savedBackgrounds.filter((entry) => entry !== url),
  });
}
