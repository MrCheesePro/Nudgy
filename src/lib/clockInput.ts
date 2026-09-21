/**
 * The rules a twelve-hour clock field types by.
 *
 * Kept apart from the control that draws it because "when is this segment finished?" is
 * the whole feature and it is all arithmetic. A native `<input type="time">` decides this
 * for itself on some platforms and not others; this decides it the same way everywhere.
 */

export type Meridiem = "AM" | "PM" | "";

export interface ClockParts {
  /** As typed: may be a single digit mid-entry, and "" when empty. */
  hour: string;
  minute: string;
  meridiem: Meridiem;
}

export const EMPTY_PARTS: ClockParts = { hour: "", minute: "", meridiem: "" };

/** Digits only, and never longer than two. */
export function digits(text: string): string {
  return text.replace(/\D/g, "").slice(0, 2);
}

/**
 * Splits a 24-hour `HH:MM` into what the three segments show.
 *
 * Midnight is 12 AM and noon is 12 PM — the two the modulo gets wrong if written the
 * obvious way, and the two people notice.
 */
export function toParts(value: string): ClockParts {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return EMPTY_PARTS;

  const hour24 = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour24) || hour24 > 23 || minute > 59) return EMPTY_PARTS;

  const meridiem: Meridiem = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  return {
    hour: String(hour12),
    minute: String(minute).padStart(2, "0"),
    meridiem,
  };
}

/**
 * The 24-hour `HH:MM` the rest of the app stores, or "" while the field is incomplete.
 *
 * Incomplete has to mean empty rather than a guess: a half-typed hour that resolved to a
 * real time would have the planner acting on 1:00 while somebody was still typing 1:45.
 */
export function toValue(parts: ClockParts): string {
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);

  if (!parts.hour || !parts.minute || !parts.meridiem) return "";
  if (!Number.isFinite(hour) || hour < 1 || hour > 12) return "";
  if (!Number.isFinite(minute) || minute > 59) return "";

  const hour24 = parts.meridiem === "PM" ? (hour === 12 ? 12 : hour + 12) : hour === 12 ? 0 : hour;

  return `${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Whether the hour is finished and the caret should move on.
 *
 * One digit is enough whenever a second could not make a real hour: 3 can only be 3, but
 * 1 might still become 12, so 1 waits. This is what makes typing "1230pm" work as one
 * gesture and "330pm" work as another, without either needing a key that means "next".
 */
export function hourComplete(text: string): boolean {
  if (text.length >= 2) return true;
  const digit = Number(text);
  return text.length === 1 && digit >= 2;
}

/** Same rule one place over: a leading 6 or more cannot be the first digit of a minute. */
export function minuteComplete(text: string): boolean {
  if (text.length >= 2) return true;
  const digit = Number(text);
  return text.length === 1 && digit >= 6;
}

/** What a finished segment settles to once focus leaves it. */
export function settleHour(text: string): string {
  if (!text) return "";
  const hour = Math.min(12, Math.max(1, Number(text)));
  return String(hour);
}

export function settleMinute(text: string): string {
  if (!text) return "";
  const minute = Math.min(59, Math.max(0, Number(text)));
  return String(minute).padStart(2, "0");
}

/** A single digit becomes the tens place: typing 7 into minutes means 07, not 70. */
export function padTyped(text: string): string {
  return text.length === 1 ? `0${text}` : text;
}

export type Segment = "hour" | "minute";

/**
 * One keystroke's worth of change, and whether the caret should move on.
 *
 * Here rather than in the control so the ordering is testable: the settle that follows a
 * keystroke has to run against the parts *this* returned, not against the render the
 * keystroke arrived in. Reading the stale copy is what put a completed hour back to empty
 * and turned a typed 55 into 05, and that is an ordering bug, not a rules bug — so the
 * rules and the order now live in the same place.
 */
export function applyDigit(
  parts: ClockParts,
  segment: Segment,
  typed: string,
): { parts: ClockParts; advance: boolean } {
  const next = digits(typed);

  if (segment === "hour") {
    return { parts: { ...parts, hour: next }, advance: hourComplete(next) };
  }

  const advance = minuteComplete(next);
  // Padded only once it is finished, so 5 can still become 55 rather than settling at 05.
  return { parts: { ...parts, minute: advance ? padTyped(next) : next }, advance };
}

/** What a segment settles to when focus leaves it. */
export function settle(parts: ClockParts, segment: Segment): ClockParts {
  return segment === "hour"
    ? { ...parts, hour: settleHour(parts.hour) }
    : { ...parts, minute: settleMinute(parts.minute) };
}
