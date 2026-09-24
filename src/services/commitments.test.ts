import { describe, expect, it } from "vitest";

import {
  fromHabit,
  fromTarget,
  ledgerOf,
  perfectStreak,
  stateOn,
  streakFor,
  type Commitment,
} from "./commitments";
import type { Habit } from "./habits";
import type { DaySeries } from "./progress";
import type { CategoryTarget } from "../lib/types";

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

function target(overrides: Partial<CategoryTarget> = {}): CategoryTarget {
  return {
    category: "Development",
    direction: "at_least",
    secondsPerDay: 2 * 3600,
    createdAt: 0,
    ...overrides,
  };
}

/** `2026-09-21` through `2026-09-23`, with whatever seconds each day is given. */
function series(...entries: [string, Record<string, number>][]): DaySeries[] {
  return entries.map(([day, byCategory]) => ({
    day,
    byCategory,
    activeSeconds: Object.entries(byCategory)
      .filter(([category]) => category !== "Idle")
      .reduce((sum, [, seconds]) => sum + seconds, 0),
  }));
}

const NOTHING = ledgerOf([], {});

describe("stateOn", () => {
  const date = (key: string) => {
    const [year, month, day] = key.split("-").map(Number);
    return new Date(year, month - 1, day, 12);
  };

  it("calls a day the habit was never due not-due, not missed", () => {
    const gym = fromHabit(habit({ id: 2, name: "Gym", weekdays: [1, 3, 5] }));
    // The 22nd is a Tuesday.
    expect(stateOn(gym, date("2026-09-22"), NOTHING, WEDNESDAY)).toBe("not-due");
  });

  it("leaves an unticked habit open today and missed yesterday", () => {
    const journal = fromHabit(habit());
    expect(stateOn(journal, date("2026-09-23"), NOTHING, WEDNESDAY)).toBe("open");
    expect(stateOn(journal, date("2026-09-22"), NOTHING, WEDNESDAY)).toBe("missed");
  });

  /**
   * The rule that makes a merged grid honest: a ceiling is never banked before midnight,
   * so under the limit today is `open` rather than `met` — but over it is lost now.
   */
  it("never banks a ceiling today, and loses it the moment it is passed", () => {
    const limit = fromTarget(target({ category: "Gaming", direction: "at_most", secondsPerDay: 3600 }));
    const under = ledgerOf(series(["2026-09-23", { Gaming: 40 * 60 }]), {});
    const over = ledgerOf(series(["2026-09-23", { Gaming: 65 * 60 }]), {});

    expect(stateOn(limit, date("2026-09-23"), under, WEDNESDAY)).toBe("open");
    expect(stateOn(limit, date("2026-09-23"), over, WEDNESDAY)).toBe("missed");
  });

  it("banks a floor the moment it is met", () => {
    const floor = fromTarget(target());
    const met = ledgerOf(series(["2026-09-23", { Development: 2 * 3600 }]), {});
    const short = ledgerOf(series(["2026-09-23", { Development: 3600 }]), {});

    expect(stateOn(floor, date("2026-09-23"), met, WEDNESDAY)).toBe("met");
    expect(stateOn(floor, date("2026-09-23"), short, WEDNESDAY)).toBe("open");
  });

  /**
   * A day Nudgy was not running is not a day you failed. It still ends a streak — invariant
   * 23 — but drawing it as a miss puts a wall of red behind anybody who shut their laptop.
   */
  it("calls a day with nothing recorded unobserved rather than missed", () => {
    const floor = fromTarget(target());
    const blank = ledgerOf(series(["2026-09-22", {}]), {});
    expect(stateOn(floor, date("2026-09-22"), blank, WEDNESDAY)).toBe("unobserved");
    // And a day the window does not cover at all says the same thing.
    expect(stateOn(floor, date("2026-09-01"), blank, WEDNESDAY)).toBe("unobserved");
  });
});

describe("streakFor", () => {
  it("dispatches to the habit arithmetic", () => {
    const journal = fromHabit(habit());
    const ledger = ledgerOf([], { 1: days("2026-09-23", "2026-09-22") });
    expect(streakFor(journal, ledger, WEDNESDAY)).toEqual({ days: 2, lit: true });
  });

  it("dispatches to the category arithmetic", () => {
    const floor = fromTarget(target());
    const ledger = ledgerOf(
      series(
        ["2026-09-22", { Development: 3 * 3600 }],
        ["2026-09-23", { Development: 2 * 3600 }],
      ),
      {},
    );
    expect(streakFor(floor, ledger, WEDNESDAY)).toEqual({ days: 2, lit: true });
  });
});

describe("perfectStreak", () => {
  const journal = fromHabit(habit({ id: 1 }));
  const gym = fromHabit(habit({ id: 2, name: "Gym", weekdays: [1, 3, 5] }));

  it("counts a day where everything due was done", () => {
    const ledger = ledgerOf([], {
      1: days("2026-09-23", "2026-09-22"),
      2: days("2026-09-23", "2026-09-21"),
    });
    // Wednesday: both due, both done. Tuesday: only the journal is due, and it was done.
    expect(perfectStreak([journal, gym], ledger, WEDNESDAY)).toEqual({ days: 2, lit: true });
  });

  it("ends at a day where one of them was missed", () => {
    const ledger = ledgerOf([], { 1: days("2026-09-23"), 2: days("2026-09-23") });
    // The journal was missed on the 22nd.
    expect(perfectStreak([journal, gym], ledger, WEDNESDAY).days).toBe(1);
  });

  /**
   * The check that stops history being rewritten: a habit added this morning must not
   * reach back and spoil a day that was perfect at the time.
   */
  it("does not let a new habit spoil yesterday", () => {
    const fresh = fromHabit(habit({ id: 3, name: "Stretch", createdDay: "2026-09-23" }));
    const ledger = ledgerOf([], {
      1: days("2026-09-23", "2026-09-22", "2026-09-21"),
      3: days("2026-09-23"),
    });
    expect(perfectStreak([journal, fresh], ledger, WEDNESDAY).days).toBe(3);
  });

  // A day you owed nothing is not an achievement — one Sunday habit must not bank a week.
  it("skips a day with nothing due rather than counting it", () => {
    const sunday = fromHabit(habit({ id: 4, name: "Call home", weekdays: [0] }));
    const ledger = ledgerOf([], { 4: days("2026-09-20") });
    expect(perfectStreak([sunday], ledger, WEDNESDAY)).toEqual({ days: 1, lit: false });
  });

  it("is zero with nothing committed to at all", () => {
    expect(perfectStreak([], NOTHING, WEDNESDAY)).toEqual({ days: 0, lit: false });
  });

  it("holds while today is still unfinished", () => {
    const ledger = ledgerOf([], { 1: days("2026-09-22", "2026-09-21") });
    expect(perfectStreak([journal], ledger, WEDNESDAY)).toEqual({ days: 2, lit: false });
  });

  /**
   * The choice the merge forced: a ceiling cannot be banked before midnight, so if it had
   * to *pass* before today counted, the flame would never be lit while anybody was looking
   * at it. Ceilings are judged in the past; today they only ever take the run away.
   */
  it("lights today on ticks and floors alone, with a ceiling still open", () => {
    const limit = fromTarget(
      target({ category: "Gaming", direction: "at_most", secondsPerDay: 3600 }),
    );
    const ledger = ledgerOf(
      series(
        ["2026-09-22", { Gaming: 30 * 60 }],
        ["2026-09-23", { Gaming: 40 * 60 }],
      ),
      { 1: days("2026-09-23", "2026-09-22") },
    );
    expect(perfectStreak([journal, limit], ledger, WEDNESDAY)).toEqual({ days: 2, lit: true });
  });

  it("takes the run away the moment a ceiling is passed today", () => {
    const limit = fromTarget(
      target({ category: "Gaming", direction: "at_most", secondsPerDay: 3600 }),
    );
    const ledger = ledgerOf(
      series(
        ["2026-09-22", { Gaming: 30 * 60 }],
        ["2026-09-23", { Gaming: 65 * 60 }],
      ),
      { 1: days("2026-09-23", "2026-09-22") },
    );
    expect(perfectStreak([journal, limit], ledger, WEDNESDAY)).toEqual({ days: 0, lit: false });
  });

  /**
   * Invariant 23, carried over intact: a day Nudgy did not run is a day nobody can vouch
   * for, and a ceiling on something you never do would otherwise bank itself.
   */
  it("ends the run at an earlier day nothing was recorded on", () => {
    const floor = fromTarget(target());
    const ledger = ledgerOf(
      series(
        ["2026-09-21", { Development: 3 * 3600 }],
        ["2026-09-22", {}],
        ["2026-09-23", { Development: 2 * 3600 }],
      ),
      {},
    );
    const commitments: Commitment[] = [floor];
    // Today is met, the 22nd is blank, and the 21st beyond it never gets counted.
    expect(perfectStreak(commitments, ledger, WEDNESDAY)).toEqual({ days: 1, lit: true });
  });
});
