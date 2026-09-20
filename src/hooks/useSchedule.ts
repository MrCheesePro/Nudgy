import { useCallback, useEffect, useState } from "react";

import {
  getSchedule,
  getScheduleRange,
  getSettings,
  setSetting,
  verifySchedule,
} from "../lib/ipc";
import { DAY_END_HOUR, DAY_START_HOUR } from "../lib/time";
import { SETTING_GOALS } from "../lib/types";
import type { Goal, ScheduleBlock, VerificationResult } from "../lib/types";
import type { Commitment } from "../services/slotFinder";
import { dayKey, plannableDays, type PlannableDay } from "../services/workPlanner";

/** How far ahead the planner looks, and how much of the timeline it keeps loaded. */
export const HORIZON_DAYS = 7;

/** Local calendar day, never `toISOString` — at 23:30 that would already be tomorrow. */
export function todayKey(reference = new Date()): string {
  return dayKey(reference);
}

/** The `YYYY-MM-DD` key `offset` days from today. */
export function dayKeyAt(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return dayKey(date);
}

/** Monday of the week containing `reference`. Weeks start Monday, not Sunday. */
export function weekStart(reference = new Date()): Date {
  const start = new Date(reference);
  // Sunday-anchored: `getDay()` is already 0 for Sunday, so it needs no shifting.
  start.setDate(start.getDate() - start.getDay());
  start.setHours(0, 0, 0, 0);
  return start;
}

/** The Sunday-anchored week `offset` weeks away from today. */
export function weekDaysAt(offset: number): Date[] {
  const reference = new Date();
  reference.setDate(reference.getDate() + offset * 7);
  return weekDays(reference);
}

export function weekDays(reference = new Date()): Date[] {
  const start = weekStart(reference);
  return Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(start);
    date.setDate(date.getDate() + offset);
    return date;
  });
}

/**
 * @param commitmentsIn calendar events overlapping a window. Free time is whatever is
 *        left after real obligations, so the planner has to know about them.
 */
export function useSchedule(
  commitmentsIn: (startTs: number, endTs: number) => Commitment[],
) {
  const day = todayKey();
  const [blocks, setBlocks] = useState<ScheduleBlock[]>([]);
  const [weekBlocks, setWeekBlocks] = useState<ScheduleBlock[]>([]);
  /** Today through the end of the planning horizon — what the planner must not overwrite. */
  const [horizonBlocks, setHorizonBlocks] = useState<ScheduleBlock[]>([]);
  /** 0 is this week, -1 last week, +1 next. Drives which range is loaded. */
  const [weekOffset, setWeekOffset] = useState(0);
  const [verifications, setVerifications] = useState<Record<number, VerificationResult>>({});
  const [goals, setGoals] = useState<Goal[]>([]);
  /** The planner dialog is open. Planning is now instant, so there is nothing else to wait on. */
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const days = weekDaysAt(weekOffset);
      // `load_range` compares the day strings inclusively, so the last day comes back
      // whole — the query window and the planning window cover the same set of days.
      const [today, week, horizon] = await Promise.all([
        getSchedule(day),
        getScheduleRange(todayKey(days[0]), todayKey(days[6])),
        getScheduleRange(todayKey(), dayKeyAt(HORIZON_DAYS - 1)),
      ]);
      setBlocks(today);
      setWeekBlocks(week);
      setHorizonBlocks(horizon);
    } catch (cause) {
      setError(String(cause));
    }
  }, [day, weekOffset]);

  useEffect(() => {
    void (async () => {
      const settings = new Map(await getSettings().catch(() => []));
      const rawGoals = settings.get(SETTING_GOALS);
      if (rawGoals) {
        try {
          setGoals(JSON.parse(rawGoals) as Goal[]);
        } catch {
          setGoals([]);
        }
      }
      await refresh();
    })();
  }, [refresh]);

  const saveGoals = useCallback(async (next: Goal[]) => {
    setGoals(next);
    await setSetting(SETTING_GOALS, JSON.stringify(next)).catch(() => undefined);
  }, []);

  /**
   * Opens the planner. Nothing is computed here and nothing is written: the dialog does
   * the arithmetic, asks about one slot at a time, and only writes what is agreed to.
   */
  const generate = useCallback(() => {
    setError(null);
    setNote(null);
    setPlanning(true);
  }, []);

  const closePlanner = useCallback(
    (message: string | null) => {
      setPlanning(false);
      if (message) setNote(message);
      void refresh();
    },
    [refresh],
  );

  const verify = useCallback(async () => {
    try {
      const results = await verifySchedule(day);
      // Keyed by block so the timeline can draw a progress bar per bar, not just a badge.
      setVerifications(
        Object.fromEntries(results.map((result) => [result.blockId, result])),
      );
      await refresh();
    } catch (cause) {
      setError(String(cause));
    }
  }, [day, refresh]);

  /**
   * The day windows to plan into, from now to the end of the horizon. Calendar events and
   * every block already on the timeline are commitments — including on days that are not
   * today, which is what stops the planner from double-booking tomorrow.
   */
  const plannerDays = useCallback(
    (now = Math.floor(Date.now() / 1000)): PlannableDay[] =>
      plannableDays({
        now,
        dayStartHour: DAY_START_HOUR,
        dayEndHour: DAY_END_HOUR,
        count: HORIZON_DAYS,
        commitmentsFor: (key, startTs, endTs) => [
          ...commitmentsIn(startTs, endTs),
          ...horizonBlocks
            .filter((block) => block.day === key)
            .map((block) => ({
              startTs: block.startTs,
              endTs: block.endTs,
              label: block.label,
            })),
        ],
      }),
    [commitmentsIn, horizonBlocks],
  );

  // Re-checking on a timer is what makes a bar fill and a badge flip from pending to met
  // while the user is still working, without them pressing anything.
  useEffect(() => {
    if (blocks.length === 0) return;
    void verify();
    const timer = window.setInterval(() => void verify(), 60_000);
    return () => window.clearInterval(timer);
    // `verify` refreshes blocks, so depending on the array itself would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks.length]);

  return {
    day,
    blocks,
    weekBlocks,
    horizonBlocks,
    weekOffset,
    setWeekOffset,
    refresh,
    verifications,
    goals,
    saveGoals,
    generate,
    planning,
    closePlanner,
    plannerDays,
    verify,
    busy: planning,
    error,
    note,
  };
}
