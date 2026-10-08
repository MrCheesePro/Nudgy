import { stateOn, type Commitment, type DayState, type Ledger } from "./commitments";
import { dayKey } from "./progress";

/**
 * The Habit board's numbers: per day, per period, and who is keeping up best.
 *
 * Read off `stateOn`, so a cell and the count above it can never disagree. A day that
 * was not due, and a day nothing was recorded on, count for nothing either way —
 * invariant 45: a fortnight away from the machine is not a fortnight of failures.
 */

export interface DayTally {
  done: number;
  notDone: number;
  /** 0–100, or null for a day still to come or one nothing was owed on. */
  percent: number | null;
}

/** A day after today has not happened, so nothing about it is a state yet. */
export function isFuture(date: Date, today = new Date()): boolean {
  return dayKey(date) > dayKey(today);
}

/** `stateOn`, except a day still to come is nobody's business yet. */
export function boardState(
  commitment: Commitment,
  date: Date,
  ledger: Ledger,
  today = new Date(),
): DayState | "future" {
  return isFuture(date, today) ? "future" : stateOn(commitment, date, ledger, today);
}

export function dayTally(
  commitments: Commitment[],
  ledger: Ledger,
  date: Date,
  today = new Date(),
): DayTally {
  let done = 0;
  let notDone = 0;
  for (const commitment of commitments) {
    const state = boardState(commitment, date, ledger, today);
    if (state === "met") done += 1;
    else if (state === "missed" || state === "open") notDone += 1;
  }
  const owed = done + notDone;
  return { done, notDone, percent: owed === 0 ? null : (done / owed) * 100 };
}

/** The whole period in one number: everything kept over everything owed so far. */
export function periodPercent(tallies: DayTally[]): number | null {
  const done = tallies.reduce((sum, tally) => sum + tally.done, 0);
  const owed = tallies.reduce((sum, tally) => sum + tally.done + tally.notDone, 0);
  return owed === 0 ? null : (done / owed) * 100;
}

/** The commitments kept on the most days in the period, best first, ties by name. */
export function topHabits(
  commitments: Commitment[],
  ledger: Ledger,
  days: Date[],
  count = 5,
  today = new Date(),
): { commitment: Commitment; days: number }[] {
  return commitments
    .map((commitment) => ({
      commitment,
      days: days.filter((date) => boardState(commitment, date, ledger, today) === "met")
        .length,
    }))
    .filter((entry) => entry.days > 0)
    .sort(
      (left, right) =>
        right.days - left.days || left.commitment.name.localeCompare(right.commitment.name),
    )
    .slice(0, count);
}
