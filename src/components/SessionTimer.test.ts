import { describe, expect, it } from "vitest";

import { phaseAt } from "./SessionTimer";
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
