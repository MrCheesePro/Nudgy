/**
 * The usable day: nothing is planned before the wake hour or after bedtime. One pair of
 * constants for every planner — a second copy is how the timeline and the dialog end up
 * disagreeing about whether an evening exists.
 */
export const DAY_START_HOUR = 8;
export const DAY_END_HOUR = 23;

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
