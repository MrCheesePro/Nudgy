/**
 * The rules a month/day/year field types by.
 *
 * The same shape as [clockInput.ts](./clockInput.ts) and for the same reason: "when is
 * this segment finished?" is arithmetic, and arithmetic belongs where a test can reach
 * it rather than inside a control.
 */

export type DateSegment = "month" | "day" | "year";

export interface DateParts {
  /** As typed: may be a single digit mid-entry, and "" when empty. */
  month: string;
  day: string;
  year: string;
}

export const EMPTY_DATE: DateParts = { month: "", day: "", year: "" };

const WIDTH: Record<DateSegment, number> = { month: 2, day: 2, year: 4 };

function digitsFor(segment: DateSegment, text: string): string {
  return text.replace(/\D/g, "").slice(0, WIDTH[segment]);
}

/** Splits an ISO `YYYY-MM-DD` into what the three segments show. */
export function toDateParts(value: string): DateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return EMPTY_DATE;
  return { year: match[1], month: match[2], day: match[3] };
}

/**
 * The ISO `YYYY-MM-DD` the rest of the app stores, or "" while the field is incomplete.
 *
 * A date that does not exist is incomplete, not a date: 31 February resolves to March in
 * a `Date` constructor, and a deadline that silently moves a month is worse than one that
 * refuses to be typed.
 */
export function toDateValue(parts: DateParts): string {
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);

  if (parts.year.length !== 4 || !parts.month || !parts.day) return "";
  if (!Number.isFinite(year) || year < 1) return "";
  if (month < 1 || month > 12) return "";
  if (day < 1 || day > daysIn(year, month)) return "";

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(
    day,
  ).padStart(2, "0")}`;
}

/** Days in a month, leap years included — the reason the day cannot be clamped to 31. */
export function daysIn(year: number, month: number): number {
  if (month < 1 || month > 12) return 31;
  return new Date(year, month, 0).getDate();
}

/**
 * Whether a segment is finished and the caret should move on.
 *
 * One digit is enough whenever a second could not make a real value: a month starting 2
 * can only be 2, but 1 might still become 12; a day starting 4 can only be 4, but 3 might
 * still become 31. The year always waits for four.
 */
export function segmentComplete(segment: DateSegment, text: string): boolean {
  if (text.length >= WIDTH[segment]) return true;
  if (text.length !== 1) return false;
  const digit = Number(text);
  if (segment === "month") return digit >= 2;
  if (segment === "day") return digit >= 4;
  return false;
}

/** One keystroke's worth of change, and whether the caret should move on. */
export function applyDateDigit(
  parts: DateParts,
  segment: DateSegment,
  typed: string,
): { parts: DateParts; advance: boolean } {
  const next = digitsFor(segment, typed);
  const advance = segmentComplete(segment, next);
  // Padded only once finished, so 3 can still become 31 rather than settling at 03.
  const settled = advance && segment !== "year" ? next.padStart(2, "0") : next;
  return { parts: { ...parts, [segment]: settled }, advance };
}

/**
 * What a segment settles to when focus leaves it.
 *
 * The day is clamped to the month it is in rather than to 31, so picking February and
 * then typing 30 lands on the 28th (or 29th) instead of quietly becoming March.
 */
export function settleDate(parts: DateParts, segment: DateSegment): DateParts {
  const text = parts[segment];
  if (!text) return parts;

  if (segment === "year") {
    // Two digits is the century everybody means. Anything else is left as typed.
    const year = text.length === 2 ? `20${text}` : text;
    return { ...parts, year: year.padStart(4, "0") };
  }

  if (segment === "month") {
    const month = Math.min(12, Math.max(1, Number(text)));
    return { ...parts, month: String(month).padStart(2, "0") };
  }

  const year = Number(parts.year) || new Date().getFullYear();
  const month = Number(parts.month) || 1;
  const day = Math.min(daysIn(year, month), Math.max(1, Number(text)));
  return { ...parts, day: String(day).padStart(2, "0") };
}
