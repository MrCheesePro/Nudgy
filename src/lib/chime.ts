/**
 * The sound a notification makes.
 *
 * Synthesised rather than bundled. Three short tones from an oscillator weigh nothing,
 * ship nothing, and cannot go missing — where three audio files would add a megabyte to
 * every installer for something most people hear twice a day. Importing your own file
 * is a separate feature and needs a file picker; this is the part that works today.
 *
 * Every call is wrapped: a browser may refuse to start audio before the page has been
 * interacted with, and a notification that cannot make a noise must still arrive.
 */

export type ChimeId = "soft" | "bright" | "low" | "none";

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

/** Plays a chime. Silent ones, unknown ids and unavailable audio all do nothing. */
export function playChime(id: ChimeId): void {
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
      gain.gain.exponentialRampToValueAtTime(0.18, startsAt + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + NOTE_SECONDS);

      oscillator.connect(gain).connect(ctx.destination);
      oscillator.start(startsAt);
      oscillator.stop(startsAt + NOTE_SECONDS);
    });
  } catch {
    // Blocked, suspended or unsupported — the notification itself still arrived.
  }
}
