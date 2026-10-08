import { describe, expect, it } from "vitest";

import { periodOf, periodTitle, shift, weekStart, weeksOf } from "./period";

describe("periods", () => {
  it("starts a week on Sunday", () => {
    // Wednesday 8 October 2026.
    const week = periodOf("week", new Date(2026, 9, 8));
    expect(week.start).toEqual(new Date(2026, 9, 4));
    expect(week.days).toHaveLength(7);
    expect(week.start.getDay()).toBe(0);
    // A Sunday is its own week's start.
    expect(weekStart(new Date(2026, 9, 4))).toEqual(new Date(2026, 9, 4));
  });

  it("names a week inside one month and across two", () => {
    expect(periodTitle("week", periodOf("week", new Date(2026, 9, 8)))).toBe("October 4–10");
    expect(periodTitle("week", periodOf("week", new Date(2026, 9, 1)))).toBe("Sep 27 – Oct 3");
  });

  it("covers a whole month, leap February included", () => {
    const feb = periodOf("month", new Date(2028, 1, 10));
    expect(feb.days).toHaveLength(29);
    expect(periodTitle("month", feb)).toBe("February");
  });

  it("groups a month into Sunday weeks", () => {
    // August 2026 starts on a Saturday: a one-day week, then four full ones, then two days.
    const weeks = weeksOf(periodOf("month", new Date(2026, 7, 1)).days);
    expect(weeks.map((week) => week.length)).toEqual([1, 7, 7, 7, 7, 2]);
  });

  it("steps by whole periods", () => {
    expect(shift("month", new Date(2026, 0, 31), -1)).toEqual(new Date(2025, 11, 1));
    expect(shift("week", new Date(2026, 9, 8), 1)).toEqual(new Date(2026, 9, 11));
  });
});
