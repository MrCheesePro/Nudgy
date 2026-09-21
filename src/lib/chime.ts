/**
 * The sound a notification makes.
 *
 * Synthesised rather than bundled. Three short tones from an oscillator weigh nothing,
 * ship nothing, and cannot go missing — where three audio files would add a megabyte to
 * every installer for something most people hear twice a day.
 *
 * A sound of your own is a fourth option: any audio file on the machine, picked with the
 * system dialog. It is copied into the app's data directory and played through the asset
 * protocol, which is why the stored value is a path rather than the file you chose — the
 * original lives in Downloads, and Downloads gets emptied.
 *
 * Every call is wrapped: a browser may refuse to start audio before the page has been
 * interacted with, and a notification that cannot make a noise must still arrive.
 */

import { convertFileSrc } from "@tauri-apps/api/core";

export type ChimeId = "soft" | "bright" | "low" | "none" | "custom";

export const PREF_CHIME = "chime";
export const PREF_CHIME_URL = "chime.url";
export const PREF_VOLUME = "chime.volume";

/** Loud enough to notice across a room, quiet enough not to be the reason you flinch. */
export const DEFAULT_VOLUME = 0.6;

export interface Chime {
  id: ChimeId;
  name: string;
  /** Frequencies in hertz, played in sequence. */
  notes: number[];
}

export const CHIMES: Chime[] = [
  { id: "soft", name: "Soft", notes: [660, 880] },
  { id: "bright", name: "Bright", notes: [880, 1175, 1568] },
  { id: "low", name: "Low", notes: [330, 262] },
  { id: "none", name: "Silent", notes: [] },
  { id: "custom", name: "Your own", notes: [] },
];

const NOTE_SECONDS = 0.12;

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    // Created on first use, not at import: constructing one before any interaction is
    // what gets a page's audio suspended in the first place.
    context ??= new AudioContext();
    return context;
  } catch {
    return null;
  }
}

/**
 * Plays a chime at `volume`, 0–1.
 *
 * Silent ones, unknown ids, a custom sound with no URL set, and unavailable audio all do
 * nothing — a notification that cannot make a noise must still arrive.
 */
export function playChime(id: ChimeId, volume = DEFAULT_VOLUME, url?: string): void {
  const level = Math.min(1, Math.max(0, volume));
  if (level === 0) return;

  if (id === "custom") {
    if (!url) return;
    try {
      // A path on disk becomes an `asset:` URL the webview is allowed to load; anything
      // already a URL is played as-is.
      const src = /^[a-z]+:/i.test(url) ? url : convertFileSrc(url);
      const sound = new Audio(src);
      sound.volume = level;
      void sound.play().catch(() => undefined);
    } catch {
      // A bad URL, a format the webview will not decode, or autoplay refused.
    }
    return;
  }

  const chime = CHIMES.find((entry) => entry.id === id);
  if (!chime || chime.notes.length === 0) return;

  const ctx = audio();
  if (!ctx) return;

  try {
    void ctx.resume();
    chime.notes.forEach((frequency, index) => {
      const startsAt = ctx.currentTime + index * NOTE_SECONDS;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();

      oscillator.type = "sine";
      oscillator.frequency.value = frequency;

      // A tone that stops dead clicks; the ramp is what makes it a chime rather than a
      // beep, and keeps it quiet enough to sit behind a notification.
      gain.gain.setValueAtTime(0.0001, startsAt);
      // Never zero: an exponential ramp to zero is undefined, and the peak is scaled by
      // the volume setting rather than the setting muting a fixed peak afterwards.
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.3 * level), startsAt + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + NOTE_SECONDS);

      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(startsAt);
      oscillator.stop(startsAt + NOTE_SECONDS);
    });
  } catch {
    // Blocked, suspended or unsupported — the notification itself still arrived.
  }
}
