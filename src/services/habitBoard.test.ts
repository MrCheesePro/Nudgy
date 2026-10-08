import { describe, expect, it } from "vitest";

import { fromHabit, fromTarget, ledgerOf } from "./commitments";
import { dayTally, periodPercent, topHabits } from "./habitBoard";
import type { Habit } from "./habits";
import type { DaySeries } from "./progress";

/** Wednesday 7 October 2026, midday. */
const TODAY = new Date(2026, 9, 7, 12);

const habit = (id: number, name: string, weekdays: number[] = []): Habit => ({
  id,
  name,
  weekdays,
  createdDay: "2026-01-01",
  archivedDay: null,
});

const day = (key: string, coding: number): DaySeries => ({
  day: key,
  byCategory: { Development: coding },
  activeSeconds: coding,
});

const journal = fromHabit(habit(1, "Journal"));
const gym = fromHabit(habit(2, "Gym", [1])); // Mondays only
const code = fromTarget({ category: "Development", direction: "at_least", secondsPerDay: 3600, createdAt: 0 });

const ledger = ledgerOf(
  [day("2026-10-05", 7200), day("2026-10-06", 0), day("2026-10-07", 600)],
  { 1: new Set(["2026-10-05", "2026-10-07"]), 2: new Set(["2026-10-05"]) },
);

describe("dayTally", () => {
  it("counts habits and targets that were owed, and nothing else", () => {
    // Monday: journal, gym and two hours of code — all three kept.
    expect(dayTally([journal, gym, code], ledger, new Date(2026, 9, 5), TODAY)).toEqual({
      done: 3,
      notDone: 0,
      percent: 100,
    });
    // Tuesday: no journal; gym not due; nothing recorded is not a miss.
    expect(dayTally([journal, gym, code], ledger, new Date(2026, 9, 6), TODAY)).toEqual({
      done: 0,
      notDone: 1,
      percent: 0,
    });
  });

  it("counts today's unfinished floor as not done, and leaves the future blank", () => {
    expect(dayTally([journal, code], ledger, new Date(2026, 9, 7), TODAY)).toEqual({
      done: 1,
      notDone: 1,
      percent: 50,
    });
    expect(dayTally([journal, code], ledger, new Date(2026, 9, 8), TODAY).percent).toBeNull();
  });
});

describe("periodPercent", () => {
  it("weighs every owed commitment equally, not every day", () => {
    expect(
      periodPercent([
        { done: 3, notDone: 0, percent: 100 },
        { done: 0, notDone: 1, percent: 0 },
        { done: 0, notDone: 0, percent: null },
      ]),
    ).toBe(75);
    expect(periodPercent([])).toBeNull();
  });
});

describe("topHabits", () => {
  it("ranks by days kept, then by name", () => {
    const week = [5, 6, 7, 8].map((date) => new Date(2026, 9, date));
    const top = topHabits([gym, code, journal], ledger, week, 2, TODAY);
    expect(top.map((entry) => [entry.commitment.name, entry.days])).toEqual([
      ["Journal", 2],
      ["Development", 1],
    ]);
  });
});
