import { useEffect, useMemo, useState } from "react";

import type { LiveStatus, LmsTask, PlanProgress, ScheduleBlock } from "../lib/types";

export interface CurrentWork {
  /** The block's own label, with the course code stripped when the chip carries it. */
  title: string;
  /** `MATH241` for a Canvas assignment; null for a goal the user typed. */
  courseCode: string | null;
  blockStartTs: number;
  blockEndTs: number;
  /**
   * Measured progress on the plan this block belongs to, 0–100, or null for a standalone
   * block. Tracked time, never the clock — invariant 10.
   */
  planPercent: number | null;
  workedSeconds: number;
  estimateSeconds: number;
  /** The plan's own session shape, so the timer counts its sittings and not a guess. */
  focusSeconds: number;
  breakSeconds: number;
  /** The app this block is verified against is in front. Styling only. */
  matchingProcess: boolean;
  idle: boolean;
  paused: boolean;
}

/**
 * What the current scheduled block is for — including which class, when it came from
 * Canvas.
 *
 * Membership is decided by the clock alone. Whether the right app is in front is a
 * separate question, returned as flags: checking Discord for five seconds should change a
 * dot from green to amber, not erase what you are supposed to be working on.
 */
export function useCurrentWork(
  blocks: ScheduleBlock[],
  plans: PlanProgress[],
  tasks: LmsTask[],
  live: LiveStatus | null,
): CurrentWork | null {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return useMemo(() => {
    const block = blocks.find((entry) => now >= entry.startTs && now < entry.endTs);
    if (!block) return null;

    const plan = block.planId === null
      ? null
      : (plans.find((entry) => entry.plan.id === block.planId) ?? null);
    const task =
      plan?.plan.taskId == null
        ? null
        : (tasks.find((entry) => entry.id === plan.plan.taskId) ?? null);
    const courseCode = task?.courseCode ?? null;

    return {
      title: stripCourseCode(block.label, courseCode),
      courseCode,
      blockStartTs: block.startTs,
      blockEndTs: block.endTs,
      planPercent: plan ? Math.min(100, plan.percent) : null,
      workedSeconds: plan?.workedSeconds ?? 0,
      estimateSeconds: plan?.plan.estimateSeconds ?? 0,
      // Never longer than the block it describes. A ten-minute job laid down under
      // Classic 25/5 is a ten-minute block, and calling that a twenty-five minute focus
      // session says the sitting is longer than the time set aside for it. A standalone
      // block has no plan, and is then the whole sitting by definition.
      focusSeconds: Math.min(
        plan?.plan.focusSeconds ?? Number.MAX_SAFE_INTEGER,
        block.endTs - block.startTs,
      ),
      breakSeconds: plan?.plan.breakSeconds ?? 0,
      matchingProcess:
        live !== null &&
        (block.targetProcess === null ||
          live.processName.toLowerCase() === block.targetProcess.toLowerCase()),
      idle: live?.isIdle ?? true,
      paused: live?.paused ?? false,
    };
  }, [blocks, plans, tasks, live, now]);
}

/**
 * Blocks carry the course inside their label (`MATH241: Homework 2`). Once a chip shows
 * the code, the prefix is noise — but only a code we actually know is removed, so a title
 * that merely looks code-shaped keeps its first word.
 */
export function stripCourseCode(label: string, courseCode: string | null): string {
  if (!courseCode) return label;
  const stripped = label
    .replace(new RegExp(`^${escapeRegex(courseCode)}\\s*[:·—–-]?\\s*`, "i"), "")
    .trim();
  return stripped.length > 0 ? stripped : label;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The next block, and the gap before it. */
export interface UpcomingWork {
  title: string;
  courseCode: string | null;
  startTs: number;
  /** How long the sitting after this break runs — the block's own length. */
  focusSeconds: number;
  /** The real gap, not the plan's nominal break: the ring has to empty when it ends. */
  breakSeconds: number;
}

/**
 * The next block to start, when the gap before it is a break rather than just a wait.
 *
 * A break has two ends. A gap that is merely *short* is not one — before the first
 * sitting of a plan, "Break, 11 seconds left" describes a rest from nothing, which is
 * both wrong and unsettling. So this requires a block of the same plan to have just
 * ended, and the gap between that block and the next to be no longer than the break the
 * plan asked for. Between two sittings there is nothing to invent: the schedule already
 * says how long the break is and what comes after it.
 *
 * The slack is one tick: a block ending at 01:25 and the next starting at 01:30 is a
 * five-minute break, and the arithmetic should not decide otherwise because the clock
 * read a second late.
 */
export function useNextWork(
  blocks: ScheduleBlock[],
  plans: PlanProgress[],
  tasks: LmsTask[],
): UpcomingWork | null {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  return useMemo(() => {
    const upcoming = blocks
      .filter((entry) => entry.startTs > now)
      .sort((left, right) => left.startTs - right.startTs)[0];
    if (!upcoming) return null;

    const plan = upcoming.planId === null
      ? null
      : (plans.find((entry) => entry.plan.id === upcoming.planId) ?? null);

    const breakSeconds = plan?.plan.breakSeconds ?? 0;
    if (breakSeconds <= 0) return null;
    if (upcoming.startTs - now > breakSeconds + SLACK_SECONDS) return null;

    // The sitting this is a break *from*. Without one, the gap is a wait.
    const previous = blocks
      .filter((entry) => entry.planId === upcoming.planId && entry.endTs <= now)
      .sort((left, right) => right.endTs - left.endTs)[0];
    if (!previous) return null;
    if (upcoming.startTs - previous.endTs > breakSeconds + SLACK_SECONDS) return null;

    const task =
      plan?.plan.taskId == null
        ? null
        : (tasks.find((entry) => entry.id === plan.plan.taskId) ?? null);
    const courseCode = task?.courseCode ?? null;

    return {
      title: stripCourseCode(upcoming.label, courseCode),
      courseCode,
      startTs: upcoming.startTs,
      focusSeconds: Math.min(
        plan?.plan.focusSeconds ?? Number.MAX_SAFE_INTEGER,
        upcoming.endTs - upcoming.startTs,
      ),
      // What the gap actually is. The plan asked for five minutes; if the schedule left
      // six, the ring has to empty in six or it sits full while the break runs out.
      breakSeconds: Math.max(1, upcoming.startTs - previous.endTs),
    };
  }, [blocks, plans, tasks, now]);
}

const SLACK_SECONDS = 5;
