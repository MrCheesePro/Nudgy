/**
 * Calendar periods for the Progress page: a Sunday-start week, or a calendar month.
 *
 * Calendar rather than rolling, so "October" means the 1st to the 31st and stepping back
 * lands on September — a rolling thirty days has no name, and the page puts the name at
 * the top. Every date here is local midnight.
 */

export type PeriodKind = "week" | "month";

export interface Period {
  start: Date;
  /** The last day, inclusive. */
  end: Date;
  days: Date[];
}

const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/** The Sunday on or before `date`. A weekly habit's tick is keyed on this day. */
export function weekStart(date: Date): Date {
  const day = midnight(date);
  day.setDate(day.getDate() - day.getDay());
  return day;
}

export function periodOf(kind: PeriodKind, anchor: Date): Period {
  const start =
    kind === "week" ? weekStart(anchor) : new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const end =
    kind === "week"
      ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)
      : new Date(start.getFullYear(), start.getMonth() + 1, 0);

  const days: Date[] = [];
  for (const day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) {
    days.push(new Date(day));
  }
  return { start, end, days };
}

/** The same kind of period, `steps` before or after the one holding `anchor`. */
export function shift(kind: PeriodKind, anchor: Date, steps: number): Date {
  const start = periodOf(kind, anchor).start;
  return kind === "week"
    ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7 * steps)
    : new Date(start.getFullYear(), start.getMonth() + steps, 1);
}

const longMonth = (date: Date) => date.toLocaleDateString("en-US", { month: "long" });
const shortMonth = (date: Date) => date.toLocaleDateString("en-US", { month: "short" });

/** Just the month: `October`. */
export function monthTitle(date: Date): string {
  return longMonth(date);
}

/** `October`, `October 5–11`, or `Sep 28 – Oct 4` when a week straddles two months. */
export function periodTitle(kind: PeriodKind, period: Period): string {
  const { start, end } = period;
  if (kind === "month") return longMonth(start);
  if (start.getMonth() === end.getMonth()) {
    return `${longMonth(start)} ${start.getDate()}–${end.getDate()}`;
  }
  return `${shortMonth(start)} ${start.getDate()} – ${shortMonth(end)} ${end.getDate()}`;
}

/** Days grouped into Sunday-start weeks — the "Week N" headers and weekly-habit columns. */
export function weeksOf(days: Date[]): Date[][] {
  const weeks: Date[][] = [];
  for (const day of days) {
    if (weeks.length === 0 || day.getDay() === 0) weeks.push([]);
    weeks[weeks.length - 1].push(day);
  }
  return weeks;
}
