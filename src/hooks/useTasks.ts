import { useCallback, useEffect, useMemo, useState } from "react";

import { getTasks, setTaskCompleted, syncCanvas } from "../lib/ipc";
import type { LmsTask } from "../lib/types";

export function useTasks() {
  const [all, setAll] = useState<LmsTask[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // Completed rows come back too — finishing something should not make it
      // unreachable. The backend already sorts them last.
      setAll(await getTasks(true));
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const result = await syncCanvas();
      setLastSync(`${result.stored} assignments synced`);
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSyncing(false);
    }
  }, [refresh]);

  /**
   * Optimistic: completion is local state the sync deliberately never overwrites.
   *
   * The flag is flipped in place rather than the row being dropped — both states are on
   * screen now, so removing it would make un-completing impossible.
   */
  const toggle = useCallback(
    async (task: LmsTask) => {
      const completed = !task.completed;
      setAll((previous) =>
        previous.map((entry) =>
          entry.id === task.id
            ? {
                ...entry,
                completed,
                completedAt: completed ? Math.floor(Date.now() / 1000) : null,
              }
            : entry,
        ),
      );
      try {
        await setTaskCompleted(task.id, completed);
      } catch (cause) {
        setError(String(cause));
        await refresh();
      }
    },
    [refresh],
  );

  const tasks = useMemo(() => all.filter((task) => !task.completed), [all]);
  const completedTasks = useMemo(() => all.filter((task) => task.completed), [all]);

  return { tasks, completedTasks, sync, syncing, toggle, error, lastSync, refresh };
}
