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
      // A standalone block has no plan; the block itself is then the whole sitting.
      focusSeconds: plan?.plan.focusSeconds ?? block.endTs - block.startTs,
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
