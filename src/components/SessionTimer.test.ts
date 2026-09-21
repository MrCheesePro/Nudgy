import { describe, expect, it } from "vitest";

import { cyclePhase, phaseAt } from "./SessionTimer";
import type { CurrentWork } from "../hooks/useCurrentWork";

const START = 1_789_700_100;

function work(overrides: Partial<CurrentWork> = {}): CurrentWork {
  return {
    title: "Problem set",
    courseCode: null,
    blockStartTs: START,
    blockEndTs: START + 2 * 3600,
    planPercent: 0,
    workedSeconds: 0,
    estimateSeconds: 2 * 3600,
    focusSeconds: 25 * 60,
    breakSeconds: 5 * 60,
    matchingProcess: true,
    idle: false,
    paused: false,
    ...overrides,
  };
}

describe("phaseAt", () => {
  it("starts in focus with the whole session left", () => {
    const phase = phaseAt(work(), START);
    expect(phase.kind).toBe("focus");
    expect(phase.remaining).toBe(25 * 60);
  });

  it("counts down through the session", () => {
    expect(phaseAt(work(), START + 10 * 60).remaining).toBe(15 * 60);
  });

  it("moves to the break when the session ends", () => {
    const phase = phaseAt(work(), START + 25 * 60);
    expect(phase.kind).toBe("break");
    expect(phase.remaining).toBe(5 * 60);
  });

  /**
   * Derived from the clock rather than counted, so closing the app for an hour and
   * coming back lands in the right place — a counter would have to guess.
   */
  it("is right in the middle of a later cycle without having watched", () => {
    // Three full 30-minute cycles, then ten minutes in.
    const phase = phaseAt(work(), START + 3 * 30 * 60 + 10 * 60);
    expect(phase.kind).toBe("focus");
    expect(phase.remaining).toBe(15 * 60);
  });

  // A session cannot outlast the block it is inside.
  it("never counts past the end of the block", () => {
    const short = work({ blockEndTs: START + 10 * 60 });
    expect(phaseAt(short, START).remaining).toBe(10 * 60);
    expect(phaseAt(short, START + 10 * 60).remaining).toBe(0);
    expect(phaseAt(short, START + 99 * 60).remaining).toBe(0);
  });

  // One sitting, no breaks: the clock just runs out.
  it("treats a break of zero as one unbroken block", () => {
    const solid = work({ breakSeconds: 0, focusSeconds: 2 * 3600 });
    const phase = phaseAt(solid, START + 90 * 60);
    expect(phase.kind).toBe("focus");
    expect(phase.remaining).toBe(30 * 60);
  });

  it("does not divide by zero on a nonsense session length", () => {
    const broken = work({ focusSeconds: 0, breakSeconds: 0 });
    expect(phaseAt(broken, START).remaining).toBeGreaterThanOrEqual(0);
  });
});

describe("cyclePhase", () => {
  // The manual pomodoro: no block to clamp against, so the cycle simply repeats.
  it("starts in focus and counts the whole session down", () => {
    expect(cyclePhase(0, 1500, 300)).toEqual({
      kind: "focus",
      remaining: 1500,
      length: 1500,
    });
    expect(cyclePhase(60, 1500, 300).remaining).toBe(1440);
  });

  it("crosses into the break and reports the break's own length", () => {
    expect(cyclePhase(1500, 1500, 300)).toEqual({
      kind: "break",
      remaining: 300,
      length: 300,
    });
  });

  it("repeats rather than running out", () => {
    // Two whole cycles in: back to the top of a focus session.
    expect(cyclePhase(3600, 1500, 300)).toEqual({
      kind: "focus",
      remaining: 1500,
      length: 1500,
    });
  });

  // Derived, not counted: an hour with the app closed lands where the clock says.
  it("is right about a moment it never watched pass", () => {
    expect(cyclePhase(1799, 1500, 300)).toEqual({
      kind: "break",
      remaining: 1,
      length: 300,
    });
  });

  it("runs out once with no break configured", () => {
    expect(cyclePhase(1500, 1500, 0).remaining).toBe(0);
    expect(cyclePhase(9999, 1500, 0).kind).toBe("focus");
  });

  it("treats a negative elapsed as not started", () => {
    expect(cyclePhase(-10, 1500, 300).remaining).toBe(1500);
  });
});
