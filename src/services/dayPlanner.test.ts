import { describe, expect, it } from "vitest";

import {
  explainNoSlots,
  nextProposal,
  planQueue,
  scopeDays,
  type QueueItem,
} from "./dayPlanner";
import type { Goal, LmsTask, PlanProgress } from "../lib/types";
import type { PlannableDay } from "./workPlanner";

const HOUR = 3600;
const DAY_ONE = 1_789_700_000;
const DAY_TWO = DAY_ONE + 24 * HOUR;

function day(
  key: string,
  startTs: number,
  hours: number,
  commitments: PlannableDay["commitments"] = [],
): PlannableDay {
  return { key, startTs, endTs: startTs + hours * HOUR, commitments };
}

function item(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: "task-1",
    taskId: 1,
    title: "MATH241: Problem Set 4",
    subtitle: "MATH241",
    dueAt: null,
    category: "Productivity",
    targetProcess: null,
    estimateSeconds: HOUR,
    ...overrides,
  };
}

function task(overrides: Partial<LmsTask> = {}): LmsTask {
  return {
    id: 1,
    provider: "canvas",
    externalId: "1",
    courseCode: "MATH241",
    title: "Problem Set 4",
    dueAt: DAY_TWO,
    htmlUrl: null,
    completed: false,
    completedAt: null,
    ...overrides,
  };
}

function plan(overrides: Partial<PlanProgress["plan"]> = {}): PlanProgress {
  return {
    plan: {
      id: 1,
      taskId: 1,
      title: "MATH241: Problem Set 4",
      estimateSeconds: HOUR,
      mode: "pomodoro",
      pomodoroStyle: "custom",
      focusSeconds: 45 * 60,
      breakSeconds: 5 * 60,
      status: "active",
      nextCheckinSeconds: null,
      checkinCount: 0,
      dueAt: null,
      completedAt: null,
      ...overrides,
    },
    workedSeconds: 0,
    remainingSeconds: HOUR,
    percent: 0,
    checkinDue: false,
  };
}

const goal: Goal = { label: "Draw", targetSeconds: 30 * 60, category: "Creative" };

describe("planQueue", () => {
  it("offers only what has no active plan behind it", () => {
    const queue = planQueue([goal], [task()], [plan()]);
    expect(queue.map((entry) => entry.id)).toEqual(["goal-Draw"]);
  });

  it("puts deadlines first, soonest one leading", () => {
    const queue = planQueue(
      [goal],
      [task({ id: 2, externalId: "2", dueAt: DAY_TWO }), task({ id: 1, dueAt: DAY_ONE })],
      [],
    );
    expect(queue.map((entry) => entry.taskId)).toEqual([1, 2, null]);
  });

  it("offers a task again once its plan is done", () => {
    const queue = planQueue([], [task()], [plan({ status: "done" })]);
    expect(queue).toHaveLength(1);
  });
});

describe("nextProposal", () => {
  const days = [day("2026-09-18", DAY_ONE, 8), day("2026-09-19", DAY_TWO, 8)];

  it("rolls to the next day when today is full", () => {
    const full = [
      day("2026-09-18", DAY_ONE, 8, [
        { startTs: DAY_ONE, endTs: DAY_ONE + 8 * HOUR, label: "Shift" },
      ]),
      day("2026-09-19", DAY_TWO, 8),
    ];

    const placement = nextProposal({
      item: item(),
      days: full,
      mode: "pomodoro",
      focusSeconds: 45 * 60,
      breakSeconds: 5 * 60,
      now: DAY_ONE,
    });

    expect(placement.blocks[0].day).toBe("2026-09-19");
  });

  it("never returns the same start twice when asked for another slot", () => {
    const first = nextProposal({
      item: item(),
      days,
      mode: "pomodoro",
      focusSeconds: 45 * 60,
      breakSeconds: 5 * 60,
      now: DAY_ONE,
    });

    const second = nextProposal({
      item: item(),
      days,
      mode: "pomodoro",
      focusSeconds: 45 * 60,
      breakSeconds: 5 * 60,
      after: first.blocks[0].startTs + 60,
      now: DAY_ONE,
    });

    expect(second.blocks[0].startTs).toBeGreaterThan(first.blocks[0].startTs);
  });

  it("treats what was accepted this session as busy, so two items never share a gap", () => {
    const first = nextProposal({
      item: item(),
      days,
      mode: "pomodoro",
      focusSeconds: 45 * 60,
      breakSeconds: 5 * 60,
      now: DAY_ONE,
    });

    const second = nextProposal({
      item: item({ id: "goal-Draw", taskId: null, title: "Draw" }),
      days,
      mode: "pomodoro",
      focusSeconds: 45 * 60,
      breakSeconds: 5 * 60,
      acceptedInSession: first.blocks,
      now: DAY_ONE,
    });

    for (const block of second.blocks) {
      for (const taken of first.blocks) {
        expect(block.startTs < taken.endTs && taken.startTs < block.endTs).toBe(false);
      }
    }
  });

  it("leaves the gap free when an item is skipped rather than accepted", () => {
    const first = nextProposal({
      item: item(),
      days,
      mode: "pomodoro",
      focusSeconds: 45 * 60,
      breakSeconds: 5 * 60,
      now: DAY_ONE,
    });

    const afterSkip = nextProposal({
      item: item({ id: "goal-Draw", taskId: null, title: "Draw" }),
      days,
      mode: "pomodoro",
      focusSeconds: 45 * 60,
      breakSeconds: 5 * 60,
      now: DAY_ONE,
    });

    expect(afterSkip.blocks[0].startTs).toBe(first.blocks[0].startTs);
  });

  it("never proposes a start in the past", () => {
    const now = DAY_ONE + 3 * HOUR;
    const placement = nextProposal({
      item: item({ dueAt: DAY_ONE - HOUR }),
      days: [{ ...day("2026-09-18", DAY_ONE, 8) }],
      mode: "pomodoro",
      focusSeconds: 45 * 60,
      breakSeconds: 5 * 60,
      now,
    });

    expect(placement.blocks.every((block) => block.startTs >= now)).toBe(true);
  });
});

describe("scopeDays", () => {
  it("drops days that end before the floor", () => {
    const scoped = scopeDays([day("2026-09-18", DAY_ONE, 4)], null, DAY_ONE + 5 * HOUR);
    expect(scoped).toHaveLength(0);
  });
});

describe("explainNoSlots", () => {
  it("names the commitment in the way, not a bare sentence", () => {
    const busy = [
      { startTs: DAY_ONE, endTs: DAY_ONE + 2 * HOUR, label: "Standup" },
      { startTs: DAY_ONE + 2 * HOUR, endTs: DAY_ONE + 8 * HOUR, label: "CS330 Lecture" },
    ];
    const reason = explainNoSlots(
      [day("2026-09-18", DAY_ONE, 8, busy)],
      item(),
      null,
      DAY_ONE,
    );

    expect(reason).toContain("CS330 Lecture");
  });

  it("says the gap is too short when there is free time but not enough", () => {
    const busy = [{ startTs: DAY_ONE + HOUR, endTs: DAY_ONE + 8 * HOUR, label: "Shift" }];
    const reason = explainNoSlots(
      [day("2026-09-18", DAY_ONE, 8, busy)],
      item({ estimateSeconds: 4 * HOUR }),
      null,
      DAY_ONE,
    );

    expect(reason).toMatch(/60 minutes/);
  });

  it("never reports an empty window as having no free time", () => {
    expect(explainNoSlots([], item(), null, DAY_ONE)).toMatch(/planning window/);
  });
});
