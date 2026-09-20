/**
 * What to plan, when to plan it, and what to say when nothing fits.
 *
 * Arithmetic only — no model, no network. `slotFinder` says what is free, `workPlanner`
 * says where the work goes, and this decides which item is asked about next and how the
 * answer is phrased. Nothing here writes: the dialog does that, once the user says yes.
 */

import { formatClock } from "../lib/time";
import type { Goal, LmsTask, PlanProgress } from "../lib/types";
import { findFreeSlots, totalSeconds, type Commitment, type Interval } from "./slotFinder";
import {
  dayKey,
  placeWork,
  type PlacedBlock,
  type Placement,
  type PlannableDay,
} from "./workPlanner";

/** Anything the queue can offer, in the shape the plan dialog already confirms. */
export interface QueueItem {
  /** Stable across a dialog run, so React keys and the accumulator agree. */
  id: string;
  taskId: number | null;
  title: string;
  /** Course code for an assignment, activity type for a goal. */
  subtitle: string | null;
  dueAt: number | null;
  category: string;
  targetProcess: string | null;
  estimateSeconds: number;
  /** Where it happens, when the user said. Null means wherever they already are. */
  placeId?: number | null;
  /** Seconds to get there from the base, when that leg has been measured. */
  travelBeforeSeconds?: number;
}

const DEFAULT_ESTIMATE_SECONDS = 60 * 60;

/**
 * The items worth proposing: everything with no active plan, soonest deadline first.
 *
 * Anything already planned is left alone — re-planning is the sidebar's job, and
 * offering it here would quietly duplicate work the user already placed.
 */
export function planQueue(
  goals: Goal[],
  tasks: LmsTask[],
  plans: PlanProgress[],
  /** Travel from the base to a place, in seconds, for goals that name one. */
  travelFromBase?: (placeId: number) => number,
  /** Categories short of a floor today. Nudges the undated tail, never the deadlines. */
  behind?: Set<string>,
): QueueItem[] {
  const plannedTitles = new Set(
    plans.filter((entry) => entry.plan.status === "active").map((entry) => entry.plan.title),
  );
  const plannedTaskIds = new Set(
    plans
      .filter((entry) => entry.plan.status === "active" && entry.plan.taskId !== null)
      .map((entry) => entry.plan.taskId as number),
  );

  const fromGoals: QueueItem[] = goals
    .filter((goal) => !plannedTitles.has(goal.label))
    .map((goal) => ({
      id: `goal-${goal.label}`,
      taskId: null,
      title: goal.label,
      subtitle: goal.category ?? null,
      // A goal with a deadline sorts among the assignments rather than after them.
      dueAt: goal.dueAt ?? null,
      category: goal.category ?? "Productivity",
      targetProcess: goal.targetProcess ?? null,
      estimateSeconds: goal.targetSeconds > 0 ? goal.targetSeconds : DEFAULT_ESTIMATE_SECONDS,
      placeId: goal.placeId ?? null,
      // Unmeasured is zero, not a guess: silently shrinking the day by an invented
      // commute is worse than ignoring a real one.
      travelBeforeSeconds:
        goal.placeId != null && travelFromBase ? travelFromBase(goal.placeId) : 0,
    }));

  const fromTasks: QueueItem[] = tasks
    .filter((task) => !task.completed && !plannedTaskIds.has(task.id))
    .map((task) => ({
      id: `task-${task.id}`,
      taskId: task.id,
      title: task.courseCode ? `${task.courseCode}: ${task.title}` : task.title,
      subtitle: task.courseCode,
      dueAt: task.dueAt,
      category: "Productivity",
      targetProcess: null,
      estimateSeconds: DEFAULT_ESTIMATE_SECONDS,
    }));

  // Deadlines first, in order; undated intentions after them.
  //
  // A target may reorder the undated tail but must never touch the dated head: something
  // due tomorrow outranks being behind on a habit, and quietly demoting it would be the
  // planner deciding a deadline matters less than a preference.
  return [...fromTasks, ...fromGoals].sort((left, right) => {
    if (left.dueAt !== right.dueAt) {
      if (left.dueAt === null) return 1;
      if (right.dueAt === null) return -1;
      return left.dueAt - right.dueAt;
    }
    if (left.dueAt === null && behind && behind.size > 0) {
      const leftBehind = behind.has(left.category);
      const rightBehind = behind.has(right.category);
      if (leftBehind !== rightBehind) return leftBehind ? -1 : 1;
    }
    return 0;
  });
}

export interface ProposalInput {
  item: QueueItem;
  days: PlannableDay[];
  mode: "continuous" | "pomodoro";
  focusSeconds: number;
  breakSeconds: number;
  longBreakSeconds?: number;
  sessionsPerLongBreak?: number;
  /** Nothing may start before this. "Try another slot" walks it forward. */
  after?: number | null;
  /** Blocks accepted earlier in this same dialog run. */
  acceptedInSession?: PlacedBlock[];
  now: number;
}

/**
 * Where this item would go, given everything already spoken for.
 *
 * `acceptedInSession` matters: `createPlan` refreshes the timeline asynchronously, so
 * without it the second item in a run is offered the slot the user just gave the first.
 * A skipped item contributes nothing, which is what makes skipping free.
 */
export function nextProposal(input: ProposalInput): Placement {
  const days = scopeDays(input.days, input.after ?? null, input.now, input.acceptedInSession);

  return placeWork({
    estimateSeconds: input.item.estimateSeconds,
    mode: input.mode,
    focusSeconds: input.focusSeconds,
    breakSeconds: input.breakSeconds,
    longBreakSeconds: input.longBreakSeconds,
    sessionsPerLongBreak: input.sessionsPerLongBreak,
    dueAt: input.item.dueAt,
    days,
    now: input.now,
    // A gap only counts if it is long enough to get there and still do the work.
    travelBeforeSeconds: input.item.travelBeforeSeconds,
  });
}

/**
 * The day windows, narrowed to what is actually offerable: never before `now`, never
 * before an explicit `after`, and never over work accepted earlier in this run.
 */
export function scopeDays(
  days: PlannableDay[],
  after: number | null,
  now: number,
  acceptedInSession: PlacedBlock[] = [],
): PlannableDay[] {
  const floor = after === null ? now : Math.max(now, after);
  const extra = new Map<string, Commitment[]>();
  for (const block of acceptedInSession) {
    const list = extra.get(block.day) ?? [];
    list.push({ startTs: block.startTs, endTs: block.endTs, label: "just planned" });
    extra.set(block.day, list);
  }

  return days
    .map((day) => ({
      ...day,
      startTs: Math.max(day.startTs, floor),
      commitments: [...day.commitments, ...(extra.get(day.key) ?? [])],
    }))
    .filter((day) => day.endTs > day.startTs);
}

/** Free time per day, as the dialog shows it: the gaps themselves, not a total. */
export function freeSlotsByDay(
  days: PlannableDay[],
  minSlotSeconds?: number,
): { key: string; startTs: number; slots: Interval[] }[] {
  return days.map((day) => ({
    key: day.key,
    startTs: day.startTs,
    slots: findFreeSlots({
      now: day.startTs,
      dayEnd: day.endTs,
      commitments: day.commitments,
      minSlotSeconds,
    }),
  }));
}

/** `["Today 1:15 PM – 3:00 PM", "Tomorrow 8:00 AM – 11:00 PM", …]`, longest gaps first. */
export function describeFreeTime(days: PlannableDay[], limit = 4): string[] {
  const labels: string[] = [];

  for (const day of freeSlotsByDay(days)) {
    for (const slot of day.slots) {
      labels.push(
        `${relativeDayLabel(day.startTs)} ${formatClock(slot.startTs)} – ${formatClock(slot.endTs)}`,
      );
    }
  }

  return labels.slice(0, limit);
}

/**
 * Why nothing could be placed, in a sentence a person can act on.
 *
 * The old planner said "No free time left today." whatever the cause — including at
 * 23:05, when the only problem was that its bedtime constant had passed. Naming the
 * obstacle is the difference between a bug report and a decision.
 */
export function explainNoSlots(
  days: PlannableDay[],
  item: QueueItem,
  placement: Placement | null,
  now: number,
): string {
  if (days.length === 0) {
    return "The planning window has run out — try again tomorrow.";
  }

  const free = freeSlotsByDay(days);
  const anyFree = free.some((day) => day.slots.length > 0);

  if (!anyFree) {
    const commitments = days.flatMap((day) => day.commitments);
    if (commitments.length > 0) {
      const longest = commitments.reduce((left, right) =>
        right.endTs - right.startTs > left.endTs - left.startTs ? right : left,
      );
      return `The next ${days.length} days are covered by ${commitments.length} commitment${
        commitments.length === 1 ? "" : "s"
      } — the longest is “${longest.label}”.`;
    }
    return "Nothing is free between now and the end of the planning window.";
  }

  const biggest = free
    .flatMap((day) => day.slots)
    .reduce((left, right) => (right.endTs - right.startTs > left.endTs - left.startTs ? right : left));
  const biggestSeconds = biggest.endTs - biggest.startTs;

  if (placement?.overdue && placement.blocks.length === 0) {
    return `“${item.title}” is already past due and the next few days are full. Plan it by hand, or free some time up.`;
  }

  if (item.dueAt !== null && item.dueAt > now) {
    const before = days.filter((day) => day.startTs < item.dueAt!);
    if (totalSeconds(before.flatMap((day) => freeSlots(day))) < item.estimateSeconds) {
      return `There is not enough free time before ${formatClock(item.dueAt)} on ${relativeDayLabel(
        item.dueAt,
      )} — shorten the estimate or move the deadline.`;
    }
  }

  return `The longest free gap is ${Math.round(biggestSeconds / 60)} minutes, shorter than what this needs. Try a smaller estimate or pomodoro sessions.`;
}

function freeSlots(day: PlannableDay): Interval[] {
  return findFreeSlots({
    now: day.startTs,
    dayEnd: day.endTs,
    commitments: day.commitments,
  });
}

/** "Today", "Tomorrow", then the weekday — the same vocabulary as the day chips. */
export function relativeDayLabel(epochSeconds: number): string {
  const key = dayKey(new Date(epochSeconds * 1000));
  const today = dayKey(new Date());
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (key === today) return "Today";
  if (key === dayKey(tomorrow)) return "Tomorrow";
  return new Date(epochSeconds * 1000).toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** The blocks of a placement, labelled for storage the way `confirmPlan` labels them. */
export function labelBlocks(item: QueueItem, blocks: PlacedBlock[]): string[] {
  return blocks.map((_, index) =>
    blocks.length > 1 ? `${item.title} (${index + 1}/${blocks.length})` : item.title,
  );
}
