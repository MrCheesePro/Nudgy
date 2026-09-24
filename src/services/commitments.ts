import type { CategoryTarget } from "../lib/types";
import { dueOn, habitStreak, type Habit, type Ticks } from "./habits";
import {
  dayKey,
  metOn,
  streakOf,
  type DaySeries,
  type StreakState,
} from "./progress";

/**
 * The two kinds of daily commitment, under one roof.
 *
 * A target and a habit are the same *shape* — something you owe most days, a run of days
 * you kept it, a flame that goes out at midnight — and they were drawn as two lists with
 * two flame columns because they arrived at different times, not because they are
 * different to read.
 *
 * What stays split is where the truth comes from, and that split is invariant 43. A target
 * is **measured**: the watcher counted the seconds and nobody can type their way to a
 * streak. A habit is **declared**: no watcher can tell whether you went to the gym, so you
 * say so. Merging the *stores* would mean either writing fake seconds into
 * `activity_samples` or fake ticks into `habit_days`, and both are lies the rest of the app
 * would then believe. So this module merges the reading and leaves the writing alone: it
 * dispatches to `streakOf` and `habitStreak` rather than replacing either.
 */

export type Commitment =
  | { kind: "declared"; key: string; name: string; habit: Habit }
  | { kind: "measured"; key: string; name: string; target: CategoryTarget };

export function fromHabit(habit: Habit): Commitment {
  return { kind: "declared", key: `habit:${habit.id}`, name: habit.name, habit };
}

export function fromTarget(target: CategoryTarget): Commitment {
  return {
    kind: "measured",
    key: `target:${target.category}`,
    name: target.category,
    target,
  };
}

/**
 * How one day of one commitment stands.
 *
 * Five states rather than the grid's three, because a measured commitment has one more way
 * of saying nothing: a day Nudgy was not running is not a day you failed, it is a day
 * nobody watched. It still ends a streak — invariant 23, a ceiling on something you never
 * do is satisfied by absence — but drawing it as a miss would put a wall of red behind
 * anybody who closed their laptop for a week.
 */
export type DayState =
  /** Done, met, banked. */
  | "met"
  /** The day is over and it was not. */
  | "missed"
  /** Today, still winnable. */
  | "open"
  /** Not asked for on this day. */
  | "not-due"
  /** Nothing was recorded, so nothing can be said. */
  | "unobserved";

/** Everything the two kinds need read, indexed once rather than per cell. */
export interface Ledger {
  /** The long window, so a streak is not capped by whatever the chart is showing. */
  series: DaySeries[];
  byDay: Map<string, DaySeries>;
  ticks: Ticks;
}

export function ledgerOf(series: DaySeries[], ticks: Ticks): Ledger {
  return {
    series,
    byDay: new Map(series.map((entry) => [entry.day, entry])),
    ticks,
  };
}

export function stateOn(
  commitment: Commitment,
  date: Date,
  ledger: Ledger,
  today = new Date(),
): DayState {
  const key = dayKey(date);
  const isToday = key === dayKey(today);

  if (commitment.kind === "declared") {
    if (!dueOn(commitment.habit, date)) return "not-due";
    if (ledger.ticks[commitment.habit.id]?.has(key)) return "met";
    return isToday ? "open" : "missed";
  }

  const entry = ledger.byDay.get(key);
  if (!entry) return "unobserved";
  const met = metOn(entry, commitment.target);

  if (isToday) {
    // A floor is banked the moment it is met. A ceiling can never be banked before
    // midnight — but it is lost the moment it is exceeded, and saying so now is more use
    // than saying so at midnight.
    return commitment.target.direction === "at_least"
      ? met
        ? "met"
        : "open"
      : met
        ? "open"
        : "missed";
  }

  if (entry.activeSeconds === 0) return "unobserved";
  return met ? "met" : "missed";
}

/** The run, whichever kind it is. Both arithmetics already return the same shape. */
export function streakFor(
  commitment: Commitment,
  ledger: Ledger,
  today = new Date(),
): StreakState {
  return commitment.kind === "declared"
    ? habitStreak(
        ledger.ticks[commitment.habit.id] ?? new Set(),
        commitment.habit.weekdays,
        commitment.habit.createdDay,
        today,
      )
    : streakOf(ledger.series, commitment.target, today);
}

/** What is being asked of you today: every target, and the habits due. */
export function activeToday(commitments: Commitment[], today = new Date()): Commitment[] {
  return commitments.filter(
    (commitment) => commitment.kind === "measured" || dueOn(commitment.habit, today),
  );
}

/** A long walk should cost a short number, not a hung render. */
const MAX_WALK_DAYS = 730;

/**
 * The run of days on which everything due was done — habits and targets together.
 *
 * Two rules do the work, and the second is the one worth stating:
 *
 * - **A day where nothing could be judged is skipped**, not counted. Nothing due and
 *   nothing observed is not an achievement, and counting it would let one Sunday habit run
 *   up a streak by doing nothing all week.
 * - **A ceiling is judged in the past only.** Staying under a limit is not finished until
 *   the day is, so a ceiling can never bank today — but if every habit is ticked and every
 *   floor is met, today is as won as it can be and the flame lights. The alternative is a
 *   flame that is never lit while you are looking at it. Going *over* a ceiling still ends
 *   the run there and then, because that day is already lost.
 */
export function perfectStreak(
  commitments: Commitment[],
  ledger: Ledger,
  today = new Date(),
): StreakState {
  if (commitments.length === 0) return { days: 0, lit: false };

  const earliest = earliestJudgeableDay(commitments, ledger);
  const cursor = new Date(today);
  cursor.setHours(0, 0, 0, 0);

  let days = 0;
  let lit = false;

  for (let step = 0; step < MAX_WALK_DAYS; step += 1) {
    if (dayKey(cursor) < earliest) break;

    const states = judgeable(commitments, cursor, ledger, today, step === 0);

    if (states.length > 0) {
      if (states.every((state) => state === "met")) {
        days += 1;
        if (step === 0) lit = true;
      } else if (step === 0) {
        // Something already lost today takes the run with it, now rather than at
        // midnight. Anything merely still open holds it, unlit.
        if (states.includes("missed")) return { days: 0, lit: false };
      } else {
        // An earlier day that was not kept — or that nobody was there to see.
        break;
      }
    }

    cursor.setDate(cursor.getDate() - 1);
  }

  return { days, lit };
}

/**
 * The states that actually bear on whether a day was perfect.
 *
 * A day a commitment was not asked for never counts either way. The two exemptions below
 * apply to **today only**, and both exist so that the flame can be lit while somebody is
 * looking at it:
 *
 * - **A ceiling still under its limit.** It cannot be banked before midnight (invariant
 *   23), so requiring it to pass would mean a day with any ceiling on it never lights.
 *   Going over is a different matter and is still a miss.
 * - **A category the watcher has not written to yet.** An earlier blank day is a day
 *   nobody can vouch for and ends the run; today's is just the morning.
 */
function judgeable(
  commitments: Commitment[],
  date: Date,
  ledger: Ledger,
  today: Date,
  isToday: boolean,
): DayState[] {
  const states: DayState[] = [];

  for (const commitment of commitments) {
    const state = stateOn(commitment, date, ledger, today);
    if (state === "not-due") continue;
    if (isToday) {
      if (state === "unobserved") continue;
      if (
        state === "open" &&
        commitment.kind === "measured" &&
        commitment.target.direction === "at_most"
      ) {
        continue;
      }
    }
    states.push(state);
  }

  return states;
}

/**
 * The first day any of these could be judged.
 *
 * Without it the walk runs its full two years through days that predate every habit and
 * every recorded sample — and a target has no creation date to stop at, only the window of
 * days the database actually holds.
 */
function earliestJudgeableDay(commitments: Commitment[], ledger: Ledger): string {
  let earliest: string | null = null;
  const consider = (day: string) => {
    if (earliest === null || day < earliest) earliest = day;
  };

  for (const commitment of commitments) {
    if (commitment.kind === "declared") consider(commitment.habit.createdDay);
    else if (ledger.series.length > 0) consider(ledger.series[0].day);
  }

  return earliest ?? dayKey(new Date());
}
