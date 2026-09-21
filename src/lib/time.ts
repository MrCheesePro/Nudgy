/**
 * The planning window: the whole day, midnight to midnight.
 *
 * It used to be 08:00 to 23:00, on the theory that nobody wants work scheduled at four in
 * the morning. But people keep hours the app has no business having an opinion about, and
 * the cost of being wrong was silent: an early riser was told a day was full when six of
 * its hours had simply been declared not to exist, and `explainNoSlots` could not name the
 * real reason because it did not know one.
 *
 * The bounds stay as constants rather than being deleted because the arithmetic is written
 * in terms of a window, and a window of the whole day is one honest value rather than a
 * special case threaded through `plannableDays`. `DAY_END_HOUR` is exclusive: 24 is
 * midnight at the end of the day, which `setHours` rolls over correctly.
 *
 * One pair for every planner — a second copy is how the timeline and the dialog end up
 * disagreeing about whether an evening exists.
 */
export const DAY_START_HOUR = 0;
export const DAY_END_HOUR = 24;

/** Local-day bounds in epoch seconds. The backend stores UTC seconds and stays
 *  timezone-agnostic; deciding what "today" means is the frontend's job. */
export function dayBounds(reference = new Date()): { startTs: number; endTs: number } {
  const start = new Date(reference);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    startTs: Math.floor(start.getTime() / 1000),
    endTs: Math.floor(end.getTime() / 1000),
  };
}

/** `2h 14m`, `14m 05s`, `42s` — compact enough for a dense dashboard. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${rest}s`;
}

export function formatClock(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Parses a time the way a person types one: "2pm", "2:30 pm", "14:30", "9".
 * Returns minutes since midnight, or null when it cannot tell.
 */
export function parseTimeOfDay(input: string): number | null {
  const text = input.trim().toLowerCase().replace(/\./g, ":");
  if (!text) return null;

  const match = text.match(/^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  const suffix = match[3];

  if (minutes > 59) return null;

  if (suffix) {
    if (hours < 1 || hours > 12) return null;
    if (suffix === "pm" && hours !== 12) hours += 12;
    if (suffix === "am" && hours === 12) hours = 0;
  } else if (hours > 23) {
    return null;
  }

  return hours * 60 + minutes;
}
