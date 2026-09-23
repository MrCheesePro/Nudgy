import { dayKey, type StreakState } from "./progress";

/**
 * Habits: the things no watcher can measure.
 *
 * Nudgy's category streaks run on tracked seconds, which works for "code for two hours"
 * and cannot work for "go to the gym" — nothing on this machine knows whether you went.
 * A habit is the other kind: not measured, declared. So the streak arithmetic is the same
 * *semantics* as [progress.ts](./progress.ts) and a different input, which is why it is
 * written out here rather than bent out of `streakOf`.
 */

export interface Habit {
  id: number;
  name: string;
  /** 0 is Sunday. Empty means every day. */
  weekdays: number[];
  /** `YYYY-MM-DD`, local. Days before this are not the habit's to have missed. */
  createdDay: string;
  /** `YYYY-MM-DD` when it was put away, or null while it is live. */
  archivedDay: string | null;
}

/** Which days each habit was ticked, keyed by habit id. */
export type Ticks = Record<number, Set<string>>;

/** A day the habit is asked for. Empty `weekdays` means every day. */
export function isDue(weekdays: number[], date: Date): boolean {
  return weekdays.length === 0 || weekdays.includes(date.getDay());
}

/** The same question for a whole habit, including the days it did not yet exist. */
export function dueOn(habit: Habit, date: Date): boolean {
  const key = dayKey(date);
  if (key < habit.createdDay) return false;
  if (habit.archivedDay !== null && key > habit.archivedDay) return false;
  return isDue(habit.weekdays, date);
}

/**
 * How far back to walk before giving up.
 *
 * Two years of a kept habit is far more than anybody will have, and the loop's exit
 * otherwise depends on finding a gap — a bug there should cost a short number, not a
 * hung render.
 */
const MAX_WALK_DAYS = 730;

/**
 * A habit's run, in the shape the flame already reads.
 *
 * The rules are invariant 23's, one at a time:
 *
 * - **A day it was not due is skipped.** It neither counts nor breaks — which is the whole
 *   point of choosing weekdays, because a rest day must not cost you a gym streak.
 * - **Today unticked does not break it.** Today is not lost until midnight, so the run is
 *   the due days before it and `lit` is false. That is exactly how an unbanked day is
 *   already drawn for a category.
 * - **An earlier due day unticked ends it.** That day is over and was missed.
 * - **Days before the habit existed end it**, or a habit created this morning would claim
 *   a month of streak that never happened.
 */
export function habitStreak(
  done: Set<string>,
  weekdays: number[],
  createdDay: string,
  today = new Date(),
): StreakState {
  const cursor = new Date(today);
  cursor.setHours(0, 0, 0, 0);

  let days = 0;
  let lit = false;

  for (let step = 0; step < MAX_WALK_DAYS; step += 1) {
    const key = dayKey(cursor);
    if (key < createdDay) break;

    if (isDue(weekdays, cursor)) {
      const ticked = done.has(key);
      if (ticked) {
        days += 1;
        if (step === 0) lit = true;
      } else if (step > 0) {
        // A due day in the past that was missed. The run ends there.
        break;
      }
      // Today, unticked: not banked, but not lost either.
    }

    cursor.setDate(cursor.getDate() - 1);
  }

  return { days, lit };
}

/**
 * The run of days on which everything due was done.
 *
 * "All completed", as asked for. A day counts when **every habit that was due that day and
 * already existed** was ticked. The existence check is load-bearing: adding a habit this
 * morning must not reach back and spoil yesterday, which was perfect at the time and has
 * not changed since.
 *
 * A day with nothing due is skipped rather than counted. A day you owed nothing is not an
 * achievement, and counting it would let somebody with one Sunday habit run up a streak by
 * doing nothing all week.
 */
export function perfectDayStreak(
  habits: Habit[],
  ticks: Ticks,
  today = new Date(),
): StreakState {
  const cursor = new Date(today);
  cursor.setHours(0, 0, 0, 0);

  const earliest = habits.reduce<string | null>(
    (oldest, habit) => (oldest === null || habit.createdDay < oldest ? habit.createdDay : oldest),
    null,
  );
  if (earliest === null) return { days: 0, lit: false };

  let days = 0;
  let lit = false;

  for (let step = 0; step < MAX_WALK_DAYS; step += 1) {
    const key = dayKey(cursor);
    if (key < earliest) break;

    const due = habits.filter((habit) => dueOn(habit, cursor));
    if (due.length > 0) {
      const all = due.every((habit) => ticks[habit.id]?.has(key) ?? false);
      if (all) {
        days += 1;
        if (step === 0) lit = true;
      } else if (step > 0) {
        break;
      }
    }

    cursor.setDate(cursor.getDate() - 1);
  }

  return { days, lit };
}

/** Everything due today that is not yet ticked — what the strip is really asking about. */
export function remainingToday(habits: Habit[], ticks: Ticks, today = new Date()): Habit[] {
  const key = dayKey(today);
  return habits.filter((habit) => dueOn(habit, today) && !(ticks[habit.id]?.has(key) ?? false));
}
