/**
 * Turns an estimate into actual blocks on actual days.
 *
 * Deterministic and offline — no model involved. It walks the free slots between now and
 * the deadline (already carved around calendar events) and lays work into them, either as
 * one continuous stretch or as pomodoro sessions with breaks between.
 */

import {
  DEFAULT_BUFFER_SECONDS,
  findFreeSlots,
  type Commitment,
  type Interval,
} from "./slotFinder";

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
  /** Gap left either side of a commitment. Defaults to `DEFAULT_BUFFER_SECONDS`. */
  bufferSeconds?: number;
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
/** Below this a fragment is not worth walking to the desk for. */
const MIN_SESSION_SECONDS = 10 * 60;

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
            minSlotSeconds: MIN_SESSION_SECONDS,
            // Nothing is booked flush against a class. A block that ends the same second
            // the next thing starts is a schedule nobody can keep.
            bufferSeconds: input.bufferSeconds ?? DEFAULT_BUFFER_SECONDS,
          });

    return { key: day.key, slots };
  });

  if (input.mode === "continuous") {
    for (const day of slotsByDay) {
      const slot = day.slots.find((entry) => entry.endTs - entry.startTs >= remaining);
      if (!slot) continue;
      blocks.push({
        day: day.key,
        index: 0,
        startTs: slot.startTs,
        endTs: slot.startTs + remaining,
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
      let cursor = slot.startTs;

      while (remaining > 0 && slot.endTs - cursor >= MIN_SESSION_SECONDS) {
        const available = slot.endTs - cursor;
        const session = Math.min(input.focusSeconds, remaining, available);
        if (session < MIN_SESSION_SECONDS) break;

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

        cursor += session + (earnedLongBreak ? longBreakSeconds : breakSeconds);
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
