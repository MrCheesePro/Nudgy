import { describe, expect, it } from "vitest";

import { placeWork, styleTiming, type PlannableDay } from "./workPlanner";

const HOUR = 3600;
const DAY_ONE = 1_789_700_000;
const DAY_TWO = DAY_ONE + 24 * HOUR;

function day(key: string, startTs: number, hours: number, commitments: PlannableDay["commitments"] = []): PlannableDay {
  return { key, startTs, endTs: startTs + hours * HOUR, commitments };
}

describe("placeWork — continuous", () => {
  it("places the whole estimate in the first slot long enough", () => {
    const result = placeWork({
      estimateSeconds: 2 * HOUR,
      mode: "continuous",
      focusSeconds: 45 * 60,
      days: [day("2026-09-18", DAY_ONE, 6)],
    });

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].endTs - result.blocks[0].startTs).toBe(2 * HOUR);
    expect(result.shortfallSeconds).toBe(0);
  });

  it("skips a day whose gaps are all too short and uses the next one", () => {
    const busy = [{ startTs: DAY_ONE + HOUR, endTs: DAY_ONE + 5 * HOUR, label: "Class" }];
    const result = placeWork({
      estimateSeconds: 3 * HOUR,
      mode: "continuous",
      focusSeconds: 45 * 60,
      days: [day("2026-09-18", DAY_ONE, 6, busy), day("2026-09-19", DAY_TWO, 6)],
    });

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].day).toBe("2026-09-19");
  });

  it("reports a shortfall instead of pretending, when no stretch is long enough", () => {
    const result = placeWork({
      estimateSeconds: 8 * HOUR,
      mode: "continuous",
      focusSeconds: 45 * 60,
      days: [day("2026-09-18", DAY_ONE, 4)],
    });

    expect(result.blocks).toHaveLength(0);
    expect(result.shortfallSeconds).toBe(8 * HOUR);
    expect(result.reason).toMatch(/pomodoro/);
  });
});

describe("placeWork — pomodoro", () => {
  it("splits the estimate into focus-length sessions", () => {
    const result = placeWork({
      estimateSeconds: 3 * HOUR,
      mode: "pomodoro",
      focusSeconds: HOUR,
      breakSeconds: 5 * 60,
      days: [day("2026-09-18", DAY_ONE, 8)],
    });

    expect(result.blocks).toHaveLength(3);
    expect(result.placedSeconds).toBe(3 * HOUR);
    expect(result.shortfallSeconds).toBe(0);
  });

  it("leaves a break between sessions", () => {
    const result = placeWork({
      estimateSeconds: 2 * HOUR,
      mode: "pomodoro",
      focusSeconds: HOUR,
      breakSeconds: 10 * 60,
      days: [day("2026-09-18", DAY_ONE, 8)],
    });

    const gap = result.blocks[1].startTs - result.blocks[0].endTs;
    expect(gap).toBe(10 * 60);
  });

  it("works around calendar events rather than through them", () => {
    const lecture = { startTs: DAY_ONE + HOUR, endTs: DAY_ONE + 2 * HOUR, label: "CS 330" };
    const result = placeWork({
      estimateSeconds: 2 * HOUR,
      mode: "pomodoro",
      focusSeconds: HOUR,
      days: [day("2026-09-18", DAY_ONE, 8, [lecture])],
    });

    for (const block of result.blocks) {
      const overlaps = block.startTs < lecture.endTs && lecture.startTs < block.endTs;
      expect(overlaps).toBe(false);
    }
    expect(result.placedSeconds).toBe(2 * HOUR);
  });

  // The gap rule is gone: a block may now start the second a commitment ends. Butting up
  // against a class is the user's call, not a rule the planner quietly enforces.
  it("places work flush against a commitment", () => {
    const lecture = { startTs: DAY_ONE + 2 * HOUR, endTs: DAY_ONE + 3 * HOUR, label: "CS 330" };
    const result = placeWork({
      estimateSeconds: 2 * HOUR,
      mode: "pomodoro",
      focusSeconds: 30 * 60,
      days: [day("2026-09-18", DAY_ONE, 8, [lecture])],
    });
    expect(result.blocks.some((block) => block.endTs === lecture.startTs)).toBe(true);
  });

  it("spills onto the next day when today runs out", () => {
    const result = placeWork({
      estimateSeconds: 5 * HOUR,
      mode: "pomodoro",
      focusSeconds: HOUR,
      days: [day("2026-09-18", DAY_ONE, 3), day("2026-09-19", DAY_TWO, 6)],
    });

    const days = new Set(result.blocks.map((block) => block.day));
    expect(days.size).toBe(2);
    expect(result.shortfallSeconds).toBe(0);
  });

  it("never schedules past the deadline, and says how much did not fit", () => {
    const result = placeWork({
      estimateSeconds: 6 * HOUR,
      mode: "pomodoro",
      focusSeconds: HOUR,
      days: [day("2026-09-18", DAY_ONE, 8)],
      dueAt: DAY_ONE + 2 * HOUR,
    });

    expect(result.blocks.every((block) => block.endTs <= DAY_ONE + 2 * HOUR)).toBe(true);
    expect(result.shortfallSeconds).toBeGreaterThan(0);
    expect(result.reason).toMatch(/part of the estimate/);
  });

  // Canvas hands back overdue-but-unsubmitted work, so a deadline in the past is common.
  // Clipping every day to it used to empty the whole week and report "no free time" on a
  // blank calendar.
  it("plans overdue work as soon as possible instead of refusing it", () => {
    const result = placeWork({
      estimateSeconds: HOUR,
      mode: "pomodoro",
      focusSeconds: HOUR,
      days: [day("2026-09-18", DAY_ONE, 8)],
      dueAt: DAY_ONE - HOUR,
    });

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].startTs).toBe(DAY_ONE);
    expect(result.overdue).toBe(true);
    expect(result.reason).toMatch(/past due/);
  });

  it("keeps overdue work inside a soft horizon rather than a week out", () => {
    const busy = (start: number) => [{ startTs: start, endTs: start + 8 * HOUR, label: "Full" }];
    const result = placeWork({
      estimateSeconds: HOUR,
      mode: "pomodoro",
      focusSeconds: HOUR,
      days: [
        day("2026-09-18", DAY_ONE, 8, busy(DAY_ONE)),
        day("2026-09-19", DAY_TWO, 8, busy(DAY_TWO)),
        day("2026-09-20", DAY_TWO + 24 * HOUR, 8, busy(DAY_TWO + 24 * HOUR)),
        day("2026-09-21", DAY_TWO + 48 * HOUR, 8),
      ],
      dueAt: DAY_ONE - HOUR,
    });

    expect(result.blocks).toHaveLength(0);
    expect(result.reason).toMatch(/past due/);
  });
});

describe("placeWork — pomodoro styles", () => {
  const HOURS_12 = { key: "2026-09-18", startTs: DAY_ONE, endTs: DAY_ONE + 12 * HOUR, commitments: [] };

  it("classic puts a long break after every fourth session", () => {
    const result = placeWork({
      estimateSeconds: 5 * 25 * 60,
      mode: "pomodoro",
      focusSeconds: 25 * 60,
      breakSeconds: 5 * 60,
      longBreakSeconds: 15 * 60,
      sessionsPerLongBreak: 4,
      days: [HOURS_12],
    });

    expect(result.blocks).toHaveLength(5);
    const gapAfter = (index: number) =>
      result.blocks[index + 1].startTs - result.blocks[index].endTs;

    expect(gapAfter(0)).toBe(5 * 60);
    expect(gapAfter(1)).toBe(5 * 60);
    expect(gapAfter(2)).toBe(5 * 60);
    // The fourth session is followed by the long one.
    expect(gapAfter(3)).toBe(15 * 60);
  });

  it("classic restarts the count after each long break", () => {
    const result = placeWork({
      estimateSeconds: 9 * 25 * 60,
      mode: "pomodoro",
      focusSeconds: 25 * 60,
      breakSeconds: 5 * 60,
      longBreakSeconds: 15 * 60,
      sessionsPerLongBreak: 4,
      days: [{ ...HOURS_12, endTs: DAY_ONE + 14 * HOUR }],
    });

    const longBreaks = result.blocks
      .slice(0, -1)
      .filter((block, index) => result.blocks[index + 1].startTs - block.endTs === 15 * 60);
    expect(longBreaks).toHaveLength(2);
  });

  it("flowmodoro rests for a fifth of the session", () => {
    const result = placeWork({
      estimateSeconds: 100 * 60,
      mode: "pomodoro",
      focusSeconds: 50 * 60,
      breakSeconds: 10 * 60,
      days: [HOURS_12],
    });

    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[1].startTs - result.blocks[0].endTs).toBe(10 * 60);
  });
});

describe("styleTiming", () => {
  it("classic ignores whatever was typed", () => {
    expect(styleTiming("classic", 90, 30)).toEqual({
      session: 25,
      break: 5,
      longBreak: 15,
      sessionsPerLongBreak: 4,
    });
  });

  it("flowmodoro derives the break from the session", () => {
    expect(styleTiming("flowmodoro", 50, 99).break).toBe(10);
    expect(styleTiming("flowmodoro", 25, 99).break).toBe(5);
    // Never zero, however short the session.
    expect(styleTiming("flowmodoro", 3, 99).break).toBe(1);
  });

  it("custom keeps both numbers", () => {
    expect(styleTiming("custom", 40, 12)).toEqual({
      session: 40,
      break: 12,
      longBreak: 0,
      sessionsPerLongBreak: 0,
    });
  });
});
