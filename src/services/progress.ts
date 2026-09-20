import type { CategoryTarget, DailyTotal } from "../lib/types";

/**
 * Turning a pile of daily totals into an answer to "is this getting better".
 *
 * All of it is pure and takes its data as arguments, so the page renders and decides
 * nothing. The one idea worth holding on to: **a number moving down is not news until you
 * know which way the target points.** Less Gaming is progress, less Development is not,
 * and every comparison here is direction-aware for that reason.
 */

/** One local day, with every category's seconds on it. */
export interface DaySeries {
  /** Local `YYYY-MM-DD`, matching what SQLite's `localtime` produced. */
  day: string;
  byCategory: Record<string, number>;
  /** Everything except Idle — what the day actually contained. */
  activeSeconds: number;
}

export type Trend = "better" | "worse" | "flat";

/** A change smaller than this is noise, not a direction. */
const FLAT_BAND = 0.05;

export const IDLE = "Idle";

/** Local `YYYY-MM-DD` for a date, the same shape the backend groups by. */
export function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * The last `days` days, oldest first, with gaps filled in.
 *
 * Zero-filling is not cosmetic: a day with no samples is a day you tracked nothing, which
 * is a real and often important fact. Dropping it would silently close the gap and make a
 * week off look like a week that never happened.
 */
export function dailySeries(
  rows: DailyTotal[],
  days: number,
  today = new Date(),
): DaySeries[] {
  const byDay = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const bucket = byDay.get(row.day) ?? {};
    bucket[row.category] = (bucket[row.category] ?? 0) + row.seconds;
    byDay.set(row.day, bucket);
  }

  const series: DaySeries[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const key = dayKey(date);
    const byCategory = byDay.get(key) ?? {};
    const activeSeconds = Object.entries(byCategory)
      .filter(([category]) => category !== IDLE)
      .reduce((sum, [, seconds]) => sum + seconds, 0);
    series.push({ day: key, byCategory, activeSeconds });
  }
  return series;
}

export function secondsOn(entry: DaySeries, category: string): number {
  return entry.byCategory[category] ?? 0;
}

/** Did this day satisfy the target? A floor wants at least; a ceiling wants at most. */
export function metOn(entry: DaySeries, target: CategoryTarget): boolean {
  const seconds = secondsOn(entry, target.category);
  return target.direction === "at_least"
    ? seconds >= target.secondsPerDay
    : seconds <= target.secondsPerDay;
}

export interface StreakState {
  /** Days in the run, today included once it has been earned. */
  days: number;
  /** Today is already earned. The flame is lit. */
  lit: boolean;
}

/**
 * A Duolingo-shaped streak: it goes out at midnight and you relight it by doing the thing.
 *
 * Counting back from today:
 *
 * * **Today, under a floor.** Meeting it is an act you have completed, so it counts
 *   immediately and lights the flame. Not meeting it *yet* neither counts nor breaks —
 *   the run through yesterday still stands, unlit, until midnight takes it.
 * * **Today, under a ceiling.** Staying under a limit is not finished until the day is,
 *   so today can never add to the run. It can still end it: once you are over the limit
 *   the day is lost, and saying so now is more use than saying so at midnight.
 * * **Any earlier day** must have been both observed and met, or the run stops there.
 *
 * That last rule is why a day Nudgy did not run breaks a streak. A ceiling on something
 * you never do is satisfied by absence, so without it every untracked day would quietly
 * bank itself and a target created this morning would show a week-long run.
 */
export function streakOf(
  series: DaySeries[],
  target: CategoryTarget,
  today = new Date(),
): StreakState {
  const key = dayKey(today);
  const isFloor = target.direction === "at_least";
  let days = 0;
  let lit = false;

  for (let index = series.length - 1; index >= 0; index -= 1) {
    const entry = series[index];

    if (entry.day === key) {
      const met = metOn(entry, target);
      if (isFloor && met) {
        days += 1;
        lit = true;
      } else if (!isFloor && !met) {
        // Over the ceiling: the day is already lost, so the run is too.
        return { days: 0, lit: false };
      }
      continue;
    }

    if (entry.activeSeconds === 0) break;
    if (!metOn(entry, target)) break;
    days += 1;
  }

  return { days, lit };
}

/** Just the number, for callers that do not care whether today is banked yet. */
export function streak(
  series: DaySeries[],
  target: CategoryTarget,
  today = new Date(),
): number {
  return streakOf(series, target, today).days;
}

/** Whether today is currently on target. */
export function metToday(
  series: DaySeries[],
  target: CategoryTarget,
  today = new Date(),
): boolean {
  const key = dayKey(today);
  const entry = series.find((day) => day.day === key);
  return entry ? metOn(entry, target) : false;
}

/** Mean seconds per day over the last `days` entries. */
export function average(series: DaySeries[], category: string, days: number): number {
  const window = series.slice(-days);
  if (window.length === 0) return 0;
  const total = window.reduce((sum, entry) => sum + secondsOn(entry, category), 0);
  return Math.round(total / window.length);
}

export interface TrendResult {
  direction: Trend;
  /** Mean seconds per day over the recent window, today excluded. */
  current: number;
  /** The same window immediately before it. */
  previous: number;
}

/**
 * This period against the one before it.
 *
 * **Today is excluded.** A morning measured against a whole-day average always looks like
 * a collapse, so including it would report backsliding every day before lunch — the single
 * easiest way to make a progress page lie.
 *
 * With no prior period to compare against the answer is `flat`, not `better`. An
 * improvement claim needs something to have improved *from*.
 */
export function trend(
  series: DaySeries[],
  target: CategoryTarget,
  windowDays = 7,
): TrendResult {
  const settled = series.slice(0, -1);
  const current = settled.slice(-windowDays);
  const previous = settled.slice(-windowDays * 2, -windowDays);

  const mean = (entries: DaySeries[]) =>
    entries.length === 0
      ? 0
      : Math.round(
          entries.reduce((sum, entry) => sum + secondsOn(entry, target.category), 0) /
            entries.length,
        );

  const now = mean(current);
  const before = mean(previous);

  if (previous.length === 0 || before === 0) {
    return { direction: "flat", current: now, previous: before };
  }

  const change = (now - before) / before;
  if (Math.abs(change) < FLAT_BAND) {
    return { direction: "flat", current: now, previous: before };
  }

  // The whole point of the module: more is better under a floor, worse under a ceiling.
  const rising = change > 0;
  const good = target.direction === "at_least" ? rising : !rising;
  return { direction: good ? "better" : "worse", current: now, previous: before };
}

/**
 * Categories falling short of a floor right now, for the planner to prefer.
 *
 * Ceilings are deliberately absent: being over one is a reason to stop, not a reason to
 * schedule something, and the planner has nothing useful to do with it.
 */
export function behindCategories(
  series: DaySeries[],
  targets: CategoryTarget[],
): Set<string> {
  const today = series[series.length - 1];
  if (!today) return new Set();
  return new Set(
    targets
      .filter(
        (target) =>
          target.direction === "at_least" &&
          secondsOn(today, target.category) < target.secondsPerDay,
      )
      .map((target) => target.category),
  );
}

/** Every category that appears anywhere in the window, busiest first. */
export function categoriesInSeries(series: DaySeries[]): string[] {
  const totals = new Map<string, number>();
  for (const entry of series) {
    for (const [category, seconds] of Object.entries(entry.byCategory)) {
      totals.set(category, (totals.get(category) ?? 0) + seconds);
    }
  }
  return [...totals.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([category]) => category);
}

/**
 * How brightly to draw a streak flame, 0–1.
 *
 * Two things are being said at once. Length is the ramp — front-loaded, because the
 * difference between one day and three is the one worth feeling. Whether today is earned
 * is the dimming: an unlit flame still shows the run it is holding, faintly, which is the
 * nudge to go and relight it before midnight.
 */
export function streakHeat(run: number, lit = true): number {
  if (run <= 0) return 0.25;
  const heat = Math.min(1, 0.45 + Math.sqrt(run / 7) * 0.55);
  return lit ? heat : heat * 0.45;
}
