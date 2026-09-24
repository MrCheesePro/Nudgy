import { describe, expect, it } from "vitest";

import { dueOn, habitStreak, remainingToday, type Habit } from "./habits";

/** A Wednesday, so weekday rules have somewhere unambiguous to stand. */
const WEDNESDAY = new Date(2026, 8, 23, 12, 0, 0);

function days(...keys: string[]): Set<string> {
  return new Set(keys);
}

function habit(overrides: Partial<Habit> = {}): Habit {
  return {
    id: 1,
    name: "Journal",
    weekdays: [],
    createdDay: "2026-01-01",
    archivedDay: null,
    ...overrides,
  };
}

describe("habitStreak", () => {
  it("counts consecutive days and lights today once it is ticked", () => {
    const streak = habitStreak(
      days("2026-09-23", "2026-09-22", "2026-09-21"),
      [],
      "2026-01-01",
      WEDNESDAY,
    );
    expect(streak).toEqual({ days: 3, lit: true });
  });

  /**
   * Today is not lost until midnight. The run so far still stands; it is simply not
   * banked, which is what `lit` says.
   */
  it("keeps the run when today is not ticked yet, but does not light it", () => {
    const streak = habitStreak(days("2026-09-22", "2026-09-21"), [], "2026-01-01", WEDNESDAY);
    expect(streak).toEqual({ days: 2, lit: false });
  });

  it("ends the run at a due day that was missed", () => {
    const streak = habitStreak(
      days("2026-09-23", "2026-09-22", "2026-09-20"),
      [],
      "2026-01-01",
      WEDNESDAY,
    );
    // The 21st was missed, so nothing before it counts.
    expect(streak.days).toBe(2);
  });

  // The whole point of choosing weekdays: a rest day is not a missed day.
  it("skips days the habit was never due", () => {
    // Mon/Wed/Fri, ticked on each of them. Tuesday and Thursday are not misses.
    const streak = habitStreak(
      days("2026-09-23", "2026-09-21", "2026-09-18", "2026-09-16"),
      [1, 3, 5],
      "2026-01-01",
      WEDNESDAY,
    );
    expect(streak).toEqual({ days: 4, lit: true });
  });

  it("does not reach back before the habit existed", () => {
    const streak = habitStreak(days("2026-09-23"), [], "2026-09-23", WEDNESDAY);
    expect(streak).toEqual({ days: 1, lit: true });
  });

  it("is zero for a habit created today and not yet done", () => {
    expect(habitStreak(days(), [], "2026-09-23", WEDNESDAY)).toEqual({ days: 0, lit: false });
  });
});

describe("dueOn", () => {
  it("is false before it existed and after it was archived", () => {
    const gym = habit({ createdDay: "2026-09-22", archivedDay: "2026-09-22" });
    expect(dueOn(gym, new Date(2026, 8, 21, 12))).toBe(false);
    expect(dueOn(gym, new Date(2026, 8, 22, 12))).toBe(true);
    expect(dueOn(gym, new Date(2026, 8, 23, 12))).toBe(false);
  });
});

describe("remainingToday", () => {
  it("lists only what is due today and not yet ticked", () => {
    const journal = habit({ id: 1 });
    const gym = habit({ id: 2, name: "Gym", weekdays: [1, 3, 5] });
    const sunday = habit({ id: 3, name: "Call home", weekdays: [0] });

    const left = remainingToday([journal, gym, sunday], { 2: days("2026-09-23") }, WEDNESDAY);
    expect(left.map((entry) => entry.name)).toEqual(["Journal"]);
  });
});
