/**
 * Turns an estimate into actual blocks on actual days.
 *
 * Deterministic and offline — no model involved. It walks the free slots between now and
 * the deadline (already carved around calendar events) and lays work into them, either as
 * one continuous stretch or as pomodoro sessions with breaks between.
 */

import { findFreeSlots, type Commitment, type Interval } from "./slotFinder";

export type PlanMode = "continuous" | "pomodoro";

/**
 * How the sessions and breaks are shaped.
 *  - `classic`    25/5, with a 15-minute break after every fourth session.
 *  - `flowmodoro` you pick the session length; the break is a fifth of it.
 *  - `custom`     both lengths are yours.
 */
export type PomodoroStyle = "classic" | "flowmodoro" | "custom";

export const CLASSIC_SESSION_MINUTES = 25;
export const CLASSIC_BREAK_MINUTES = 5;
export const CLASSIC_LONG_BREAK_MINUTES = 15;
export const CLASSIC_SESSIONS_PER_LONG_BREAK = 4;
/** Flowmodoro's one rule: rest for a fifth of what you just worked. */
export const FLOWMODORO_DIVISOR = 5;

/** The session and break lengths a style implies, in minutes. */
export function styleTiming(
  style: PomodoroStyle,
  sessionMinutes: number,
  breakMinutes: number,
): {
  session: number;
  break: number;
  longBreak: number;
  sessionsPerLongBreak: number;
} {
  if (style === "classic") {
    return {
      session: CLASSIC_SESSION_MINUTES,
      break: CLASSIC_BREAK_MINUTES,
      longBreak: CLASSIC_LONG_BREAK_MINUTES,
      sessionsPerLongBreak: CLASSIC_SESSIONS_PER_LONG_BREAK,
    };
  }
  if (style === "flowmodoro") {
    return {
      session: sessionMinutes,
      break: Math.max(1, Math.round(sessionMinutes / FLOWMODORO_DIVISOR)),
      longBreak: 0,
      sessionsPerLongBreak: 0,
    };
  }
  return {
    session: sessionMinutes,
    break: breakMinutes,
    longBreak: 0,
    sessionsPerLongBreak: 0,
  };
}

export interface PlannableDay {
  /** Local `YYYY-MM-DD`, the key schedule blocks are stored under. */
  key: string;
  /** Earliest the day may be scheduled into (today: now; later days: the wake hour). */
  startTs: number;
  /** Bedtime. */
  endTs: number;
  /** Calendar events and blocks already committed on that day. */
  commitments: Commitment[];
}

export interface PlacementInput {
  estimateSeconds: number;
  mode: PlanMode;
  /** Session length in pomodoro mode. */
  focusSeconds: number;
  breakSeconds?: number;
  /** Classic's longer rest. Zero or omitted means every break is the same. */
  longBreakSeconds?: number;
  /** How many sessions earn the long break. */
  sessionsPerLongBreak?: number;
  days: PlannableDay[];
  /** Nothing is placed after this. A deadline already in the past is not a bound. */
  dueAt?: number | null;
  /** Epoch seconds. Defaults to the start of the first day, which is already floored at now. */
  now?: number;
}

/** How far out overdue work may be pushed before it stops being "as soon as possible". */
export const OVERDUE_HORIZON_DAYS = 3;

export const OVERDUE_REASON = "past due — planning it as soon as possible";

export interface PlacedBlock extends Interval {
  day: string;
  index: number;
}

export interface Placement {
  blocks: PlacedBlock[];
  placedSeconds: number;
  /** Estimate minus what fitted. Above zero means the day ran out before the work did. */
  shortfallSeconds: number;
  reason: string | null;
  /** The deadline had already passed, so it was planned as soon as possible instead. */
  overdue: boolean;
}

export const DEFAULT_BREAK_SECONDS = 5 * 60;
/**
 * Below this a *fragment* is not worth walking to the desk for.
 *
 * It is a floor on how finely a long plan may be chopped, never a floor on the work
 * itself: asked for five minutes, the planner has no business refusing because ten is its
 * idea of a sitting. So the usable slot length is this or the whole estimate, whichever
 * is smaller — which is what made "5 minutes" report no free time before its deadline on
 * an otherwise empty evening.
 */
const MIN_SESSION_SECONDS = 10 * 60;

/**
 * Blocks begin on a five-minute mark.
 *
 * A gap opens whenever the last thing happened to end, so without this a session starts
 * at 4:32 — a time nobody would ever choose and which reads as a glitch rather than a
 * plan. Rounding is always **up**: down would push a block into the commitment the gap
 * just closed, or start it before now.
 *
 * Done on epoch seconds, which works because every current timezone offset is a whole
 * number of five-minute steps — so a 300-second epoch boundary is also a local clock
 * reading ending in 0 or 5.
 */
export const START_BOUNDARY_SECONDS = 5 * 60;

function nextBoundary(ts: number): number {
  return Math.ceil(ts / START_BOUNDARY_SECONDS) * START_BOUNDARY_SECONDS;
}

export function placeWork(input: PlacementInput): Placement {
  const breakSeconds = input.breakSeconds ?? DEFAULT_BREAK_SECONDS;
  const blocks: PlacedBlock[] = [];
  let remaining = Math.max(0, input.estimateSeconds);

  if (remaining === 0) {
    return {
      blocks,
      placedSeconds: 0,
      shortfallSeconds: 0,
      reason: "estimate is zero",
      overdue: false,
    };
  }

  // A deadline that has already gone is not a bound — clipping every day to it would
  // empty the whole week and report "no free time" on an open calendar. Overdue work
  // gets a soft horizon instead, so it lands in the next few days rather than drifting
  // to the end of the week when today is crowded.
  const now = input.now ?? input.days[0]?.startTs ?? 0;
  const overdue = input.dueAt !== null && input.dueAt !== undefined && input.dueAt <= now;
  const horizon = overdue
    ? (input.days[OVERDUE_HORIZON_DAYS - 1] ?? input.days[input.days.length - 1])?.endTs
    : input.dueAt;

  // Free time per day, clipped to the deadline.
  const slotsByDay = input.days.map((day) => {
    const dayEnd = horizon ? Math.min(day.endTs, horizon) : day.endTs;
    const slots =
      dayEnd <= day.startTs
        ? []
        : findFreeSlots({
            now: day.startTs,
            dayEnd,
            commitments: day.commitments,
            minSlotSeconds: Math.min(MIN_SESSION_SECONDS, remaining),
          });

    return { key: day.key, slots };
  });

  if (input.mode === "continuous") {
    for (const day of slotsByDay) {
      // The boundary costs up to five minutes of the gap, so it is applied before the
      // fit is judged rather than after — otherwise a slot could pass the check and then
      // not hold the block.
      const slot = day.slots.find(
        (entry) => entry.endTs - nextBoundary(entry.startTs) >= remaining,
      );
      if (!slot) continue;
      const startTs = nextBoundary(slot.startTs);
      blocks.push({
        day: day.key,
        index: 0,
        startTs,
        endTs: startTs + remaining,
      });
      return {
        blocks,
        placedSeconds: remaining,
        shortfallSeconds: 0,
        reason: overdue ? OVERDUE_REASON : null,
        overdue,
      };
    }

    return {
      blocks: [],
      placedSeconds: 0,
      shortfallSeconds: remaining,
      reason: "no single free stretch is long enough — try pomodoro sessions instead",
      overdue,
    };
  }

  // Pomodoro: fill each slot with sessions separated by breaks, in chronological order.
  const longBreakSeconds = input.longBreakSeconds ?? 0;
  const sessionsPerLongBreak = input.sessionsPerLongBreak ?? 0;
  let sessionsSinceLongBreak = 0;

  for (const day of slotsByDay) {
    for (const slot of day.slots) {
      // Every session start is rounded, not just the first: a Flowmodoro break is a
      // fifth of the session, so 45 + 9 would walk every later block off the marks.
      let cursor = nextBoundary(slot.startTs);

      // The floor is the smaller of the minimum sitting and whatever is left to do, so
      // a five-minute job is a five-minute session and the last five minutes of a long
      // plan are placed rather than reported as a shortfall. Recomputed each pass because
      // `remaining` shrinks: the floor only relaxes once the work itself is the short
      // thing, never to justify chopping a big plan into slivers.
      while (remaining > 0 && slot.endTs - cursor >= Math.min(MIN_SESSION_SECONDS, remaining)) {
        const available = slot.endTs - cursor;
        const session = Math.min(input.focusSeconds, remaining, available);
        if (session < Math.min(MIN_SESSION_SECONDS, remaining)) break;

        blocks.push({
          day: day.key,
          index: blocks.length,
          startTs: cursor,
          endTs: cursor + session,
        });

        remaining -= session;
        sessionsSinceLongBreak += 1;

        // Every fourth session earns the long break, then the count starts over.
        const earnedLongBreak =
          sessionsPerLongBreak > 0 && sessionsSinceLongBreak >= sessionsPerLongBreak;
        if (earnedLongBreak) sessionsSinceLongBreak = 0;

        cursor = nextBoundary(
          cursor + session + (earnedLongBreak ? longBreakSeconds : breakSeconds),
        );
      }

      if (remaining === 0) break;
    }
    if (remaining === 0) break;
  }

  const placed = input.estimateSeconds - remaining;
  return {
    blocks,
    placedSeconds: placed,
    shortfallSeconds: remaining,
    reason:
      remaining > 0
        ? placed === 0
          ? overdue
            ? "past due, and nothing is free in the next few days"
            : "no free time before the deadline"
          : overdue
            ? "past due, and only part of it fits in the next few days"
            : "only part of the estimate fits before the deadline"
        : overdue
          ? OVERDUE_REASON
          : null,
    overdue,
  };
}

/** Builds the day windows to plan into: today from now, then whole days after it. */
export function plannableDays(options: {
  now: number;
  dayStartHour: number;
  dayEndHour: number;
  count: number;
  commitmentsFor: (dayKey: string, dayStart: number, dayEnd: number) => Commitment[];
}): PlannableDay[] {
  const days: PlannableDay[] = [];

  for (let offset = 0; offset < options.count; offset += 1) {
    const date = new Date(options.now * 1000);
    date.setDate(date.getDate() + offset);

    const start = new Date(date);
    start.setHours(options.dayStartHour, 0, 0, 0);
    const end = new Date(date);
    end.setHours(options.dayEndHour, 0, 0, 0);

    const startTs = Math.max(Math.floor(start.getTime() / 1000), offset === 0 ? options.now : 0);
    const endTs = Math.floor(end.getTime() / 1000);
    if (endTs <= startTs) continue;

    const key = dayKey(date);
    days.push({
      key,
      startTs,
      endTs,
      commitments: options.commitmentsFor(key, startTs, endTs),
    });
  }

  return days;
}

export function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
