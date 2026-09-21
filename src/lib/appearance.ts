import { useSyncExternalStore } from "react";

import { setSetting } from "./ipc";

/**
 * Text size, typeface and background — the three things that make an app yours.
 *
 * All applied the way [theme.ts](./theme.ts) applies colour: properties written onto
 * `:root`, so no component learns any of this exists.
 *
 * The two size controls are deliberately different mechanisms, because they answer
 * different complaints. **Text** multiplies `--text-scale`, which every font size in
 * `index.css` runs through and nothing else does — the words grow, the layout holds.
 * **Everything** is `zoom` on the app root, which takes icons, chart rings and fixed
 * pixel widths with it. A root `font-size` would have been neither: it moves every rem,
 * so spacing grows with type and the two sliders end up doing the same job.
 */

export const SETTING_TEXT_SCALE = "text_scale";
export const SETTING_UI_SCALE = "ui_scale";
export const SETTING_FONT = "font_family";
export const SETTING_BACKGROUND = "background_image";

export const MIN_SCALE = 0.8;
export const MAX_SCALE = 1.5;

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
  /**
   * The whole interface, text and everything else alike.
   *
   * `zoom`, not a font size: it takes icons, chart rings, borders and the fixed-pixel
   * widths with it, which a root font-size cannot reach. Use this to fit more on a big
   * display or make the lot legible on a small one; use `scale` when only the words are
   * too small.
   */
  uiScale: number;
  /** A `FONTS` id, or a raw Google Fonts family name the user typed. */
  font: string;
  /** A URL or data URI drawn behind the app, or empty for none. */
  background: string;
}

export const DEFAULT_APPEARANCE: Appearance = {
  scale: 1,
  uiScale: 1,
  font: "default",
  background: "",
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

  // Zoom is applied to the app's own root, never to `html` — a control that floats over
  // the page to *set* this must not be scaled by it while you drag.
  const ui = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.uiScale));
  const app = document.getElementById("root");
  if (app) app.style.zoom = String(ui);

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
  if (next.uiScale !== undefined) {
    writes.push(setSetting(SETTING_UI_SCALE, String(current.uiScale)));
  }
  if (next.font !== undefined) writes.push(setSetting(SETTING_FONT, current.font));
  if (next.background !== undefined) {
    writes.push(setSetting(SETTING_BACKGROUND, current.background));
  }
  await Promise.all(writes);
}

/** Reads what was stored at startup, before anything renders against the defaults. */
export function hydrateAppearance(settings: Map<string, string>) {
  const scale = Number(settings.get(SETTING_TEXT_SCALE));
  const uiScale = Number(settings.get(SETTING_UI_SCALE));
  applyAppearance({
    scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
    uiScale: Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1,
    font: settings.get(SETTING_FONT) ?? "default",
    background: settings.get(SETTING_BACKGROUND) ?? "",
  });
}
