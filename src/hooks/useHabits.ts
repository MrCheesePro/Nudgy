import { useCallback, useEffect, useMemo, useState } from "react";

import {
  archiveHabit,
  createHabit,
  deleteHabit,
  listHabits,
  setHabitDone,
  updateHabit,
} from "../lib/ipc";
import { dayKey } from "../services/progress";
import {
  habitStreak,
  perfectDayStreak,
  type Habit,
  type Ticks,
} from "../services/habits";
import type { StreakState } from "../services/progress";

/**
 * The habits, their history, and what that adds up to.
 *
 * Ticking writes optimistically and refreshes behind it: a checkbox that waits for a round
 * trip before filling in feels broken, and the write is a single row keyed on
 * `(habit, day)` so there is no state to get wrong if the refresh disagrees.
 */
export function useHabits() {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [ticks, setTicks] = useState<Ticks>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await listHabits();
      setHabits(
        snapshot.habits.map((habit) => ({
          id: habit.id,
          name: habit.name,
          weekdays: habit.weekdays,
          createdDay: habit.createdDay,
          archivedDay: habit.archivedDay,
        })),
      );

      const grouped: Ticks = {};
      for (const [id, day] of snapshot.ticks) {
        (grouped[id] ??= new Set()).add(day);
      }
      setTicks(grouped);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = useCallback(
    async (habit: Habit, day = dayKey(new Date())) => {
      const done = !(ticks[habit.id]?.has(day) ?? false);

      setTicks((current) => {
        const next: Ticks = { ...current };
        const set = new Set(next[habit.id] ?? []);
        if (done) set.add(day);
        else set.delete(day);
        next[habit.id] = set;
        return next;
      });

      try {
        await setHabitDone(habit.id, day, done);
      } catch (cause) {
        setError(String(cause));
        await refresh();
      }
    },
    [ticks, refresh],
  );

  const add = useCallback(
    async (name: string, weekdays: number[]) => {
      await createHabit(name, weekdays);
      await refresh();
    },
    [refresh],
  );

  const edit = useCallback(
    async (id: number, name: string, weekdays: number[]) => {
      await updateHabit(id, name, weekdays);
      await refresh();
    },
    [refresh],
  );

  const setArchived = useCallback(
    async (id: number, archived: boolean) => {
      await archiveHabit(id, archived);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: number) => {
      await deleteHabit(id);
      await refresh();
    },
    [refresh],
  );

  /** What the strip shows: archived habits are history, not today's business. */
  const live = useMemo(
    () => habits.filter((habit) => habit.archivedDay === null),
    [habits],
  );

  /** Per-habit runs, keyed by id, so the strip does no arithmetic of its own. */
  const streaks = useMemo(
    () =>
      Object.fromEntries(
        live.map((habit) => [
          habit.id,
          habitStreak(ticks[habit.id] ?? new Set(), habit.weekdays, habit.createdDay),
        ]),
      ) as Record<number, StreakState>,
    [live, ticks],
  );

  /** Days on which everything due was done — the "all completed" run. */
  const perfect = useMemo(() => perfectDayStreak(live, ticks), [live, ticks]);

  return {
    habits,
    live,
    ticks,
    streaks,
    perfect,
    toggle,
    add,
    edit,
    setArchived,
    remove,
    refresh,
    error,
  };
}
