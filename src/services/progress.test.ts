import { describe, expect, it } from "vitest";

import {
  average,
  behindCategories,
  dailySeries,
  dayKey,
  metOn,
  resolveTargetCategory,
  secondsOn,
  streak,
  streakOf,
  trend,
} from "./progress";
import type { CategoryTarget, DailyTotal } from "../lib/types";

const TODAY = new Date(2026, 8, 20, 14, 0, 0); // 20 Sep 2026, early afternoon
const HOUR = 3600;

/** `days` ago, as the backend would have keyed it. */
const ago = (days: number) => {
  const date = new Date(TODAY);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return dayKey(date);
};

const row = (days: number, category: string, seconds: number): DailyTotal => ({
  day: ago(days),
  category,
  seconds,
});

const floor = (seconds: number, category = "Development"): CategoryTarget => ({
  category,
  direction: "at_least",
  secondsPerDay: seconds,
  createdAt: 0,
});

const ceiling = (seconds: number, category = "Free Time"): CategoryTarget => ({
  category,
  direction: "at_most",
  secondsPerDay: seconds,
  createdAt: 0,
});

describe("dailySeries", () => {
  it("zero-fills days with no samples", () => {
    const series = dailySeries([row(0, "Development", HOUR)], 5, TODAY);
    expect(series).toHaveLength(5);
    // A week off is a fact about the week, not a gap to be closed.
    expect(series.slice(0, 4).every((entry) => entry.activeSeconds === 0)).toBe(true);
    expect(series[4].activeSeconds).toBe(HOUR);
  });

  it("is ordered oldest first, ending today", () => {
    const series = dailySeries([], 3, TODAY);
    expect(series.map((entry) => entry.day)).toEqual([ago(2), ago(1), ago(0)]);
  });

  it("sums several categories onto one day without counting idle as activity", () => {
    const series = dailySeries(
      [row(0, "Development", HOUR), row(0, "Idle", 2 * HOUR)],
      1,
      TODAY,
    );
    expect(secondsOn(series[0], "Idle")).toBe(2 * HOUR);
    expect(series[0].activeSeconds).toBe(HOUR);
  });
});

describe("metOn", () => {
  it("reads a floor and a ceiling in opposite directions", () => {
    const [day] = dailySeries([row(0, "Development", HOUR)], 1, TODAY);
    expect(metOn(day, floor(HOUR))).toBe(true);
    expect(metOn(day, floor(2 * HOUR))).toBe(false);

    const [leisure] = dailySeries([row(0, "Free Time", HOUR)], 1, TODAY);
    expect(metOn(leisure, ceiling(2 * HOUR))).toBe(true);
    expect(metOn(leisure, ceiling(30 * 60))).toBe(false);
  });

  it("counts an untouched day as meeting a ceiling", () => {
    const [day] = dailySeries([], 1, TODAY);
    expect(metOn(day, ceiling(HOUR))).toBe(true);
    expect(metOn(day, floor(HOUR))).toBe(false);
  });
});

describe("streak", () => {
  it("counts back from today and stops at the first miss", () => {
    const series = dailySeries(
      [
        row(0, "Development", 2 * HOUR),
        row(1, "Development", 2 * HOUR),
        row(2, "Development", 2 * HOUR),
        row(3, "Development", 10 * 60), // the miss
        row(4, "Development", 3 * HOUR),
      ],
      5,
      TODAY,
    );
    // Today met, plus days 1 and 2; day 3 broke it.
    expect(streak(series, floor(HOUR), TODAY)).toBe(3);
    expect(streakOf(series, floor(HOUR), TODAY).lit).toBe(true);
  });

  // Meeting a floor is an act you have finished, so it lights the flame there and then.
  it("counts today as soon as a floor is met", () => {
    const series = dailySeries([row(0, "Development", 8 * HOUR)], 3, TODAY);
    const state = streakOf(series, floor(HOUR), TODAY);
    expect(state.days).toBe(1);
    expect(state.lit).toBe(true);
  });

  // Staying under a limit is not finished until the day is.
  it("never lets today add to a ceiling streak", () => {
    const series = dailySeries(
      [row(1, "Development", HOUR), row(2, "Development", HOUR)],
      3,
      TODAY,
    );
    const state = streakOf(series, ceiling(HOUR, "Gaming"), TODAY);
    expect(state.days).toBe(2);
    expect(state.lit).toBe(false);
  });

  it("ends a ceiling streak the moment today goes over", () => {
    const series = dailySeries(
      [
        row(0, "Gaming", 3 * HOUR), // blown today
        row(1, "Development", HOUR),
        row(2, "Development", HOUR),
      ],
      3,
      TODAY,
    );
    expect(streak(series, ceiling(HOUR, "Gaming"), TODAY)).toBe(0);
  });

  // The run stands, unlit, until midnight takes it — the whole point of a streak you can
  // still go and save.
  it("holds yesterday's run while today is unmet", () => {
    const series = dailySeries(
      [row(1, "Development", 2 * HOUR), row(2, "Development", 2 * HOUR)],
      3,
      TODAY,
    );
    const state = streakOf(series, floor(HOUR), TODAY);
    expect(state.days).toBe(2);
    expect(state.lit).toBe(false);
  });

  /**
   * The bug this whole rewrite came from: a ceiling on something you never do is
   * satisfied by every untracked day, so a target nobody had thought about showed a
   * full-length streak the moment it was created.
   */
  it("breaks on a day with nothing tracked at all", () => {
    const series = dailySeries(
      [
        row(1, "Development", 2 * HOUR), // yesterday was real
        // day 2 has no samples whatsoever
        row(3, "Development", 2 * HOUR),
      ],
      5,
      TODAY,
    );
    expect(streak(series, ceiling(HOUR, "Gaming"), TODAY)).toBe(1);
    expect(streak(series, floor(HOUR), TODAY)).toBe(1);
  });

  it("counts a quiet day under a ceiling, as long as the day was observed", () => {
    const series = dailySeries(
      [
        row(1, "Development", 3 * HOUR),
        row(2, "Development", 3 * HOUR),
        row(2, "Gaming", 10 * 60),
      ],
      4,
      TODAY,
    );
    expect(streak(series, ceiling(HOUR, "Gaming"), TODAY)).toBe(2);
  });
});

describe("average", () => {
  it("divides by the window, so empty days pull it down", () => {
    const series = dailySeries(
      [row(0, "Development", 2 * HOUR), row(1, "Development", 2 * HOUR)],
      4,
      TODAY,
    );
    expect(average(series, "Development", 4)).toBe(HOUR);
  });
});

describe("trend", () => {
  // The test that protects the page's whole claim: the same fall in minutes is good news
  // under a ceiling and bad news under a floor.
  it("reads the target's direction", () => {
    // `trend` drops today, then compares the last 7 settled days against the 7 before
    // them — so the earlier window is days 8–14 and the recent one is days 1–7.
    const rows: DailyTotal[] = [];
    for (let day = 8; day <= 14; day += 1) rows.push(row(day, "X", 4 * HOUR)); // before
    for (let day = 1; day <= 7; day += 1) rows.push(row(day, "X", 1 * HOUR)); // after

    const series = dailySeries(rows, 15, TODAY);
    expect(trend(series, { ...floor(HOUR), category: "X" }).direction).toBe("worse");
    expect(trend(series, { ...ceiling(HOUR), category: "X" }).direction).toBe("better");
  });

  it("ignores today, so a partial morning is not a collapse", () => {
    const rows: DailyTotal[] = [];
    for (let day = 1; day <= 14; day += 1) rows.push(row(day, "X", 2 * HOUR));
    rows.push(row(0, "X", 5 * 60)); // five minutes in so far

    const series = dailySeries(rows, 15, TODAY);
    const result = trend(series, { ...floor(HOUR), category: "X" });
    expect(result.direction).toBe("flat");
    expect(result.current).toBe(2 * HOUR);
  });

  it("is flat with nothing to compare against", () => {
    const series = dailySeries([row(1, "X", 2 * HOUR)], 3, TODAY);
    expect(trend(series, { ...floor(HOUR), category: "X" }).direction).toBe("flat");
  });

  it("treats a small wobble as flat rather than a direction", () => {
    const rows: DailyTotal[] = [];
    for (let day = 8; day <= 14; day += 1) rows.push(row(day, "X", 100 * 60));
    for (let day = 1; day <= 7; day += 1) rows.push(row(day, "X", 102 * 60));

    const series = dailySeries(rows, 16, TODAY);
    expect(trend(series, { ...floor(HOUR), category: "X" }).direction).toBe("flat");
  });
});

describe("behindCategories", () => {
  it("names floors not yet met today, and ignores ceilings entirely", () => {
    const series = dailySeries(
      [row(0, "Development", 30 * 60), row(0, "Free Time", 5 * HOUR)],
      1,
      TODAY,
    );
    const behind = behindCategories(series, [floor(2 * HOUR), ceiling(HOUR)]);
    expect([...behind]).toEqual(["Development"]);
  });

  it("drops a floor once it is met", () => {
    const series = dailySeries([row(0, "Development", 3 * HOUR)], 1, TODAY);
    expect(behindCategories(series, [floor(2 * HOUR)]).size).toBe(0);
  });
});

describe("resolveTargetCategory", () => {
  const untargeted = [{ name: "Development" }, { name: "Productivity" }];

  /**
   * The bug, exactly: the dropdown shows Development, the user never touches it, and
   * `picked` is still "". With `??` that resolved to "" and the save silently did
   * nothing — which looked like "targets do not work for Development".
   */
  it("uses the first untargeted category when the dropdown is untouched", () => {
    expect(resolveTargetCategory(null, "", untargeted)).toBe("Development");
  });

  it("uses what was picked once the dropdown is touched", () => {
    expect(resolveTargetCategory(null, "Productivity", untargeted)).toBe("Productivity");
  });

  // Editing wins outright, including when the category is no longer in the list —
  // otherwise editing a target whose category was deleted would retarget a different one.
  it("keeps editing the loaded target, even one no longer offered", () => {
    expect(resolveTargetCategory("Gaming", "", untargeted)).toBe("Gaming");
    expect(resolveTargetCategory("Gaming", "Productivity", untargeted)).toBe("Gaming");
    expect(resolveTargetCategory("Reading", "", [])).toBe("Reading");
  });

  it("is undefined when every category already has a target", () => {
    expect(resolveTargetCategory(null, "", [])).toBeUndefined();
  });
});
