import { useCallback, useEffect, useState } from "react";

import { getTasks, setTaskCompleted, syncCanvas } from "../lib/ipc";
import type { LmsTask } from "../lib/types";

export function useTasks() {
  const [tasks, setTasks] = useState<LmsTask[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setTasks(await getTasks(false));
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

  /** Optimistic: the checkbox is local state the sync deliberately never overwrites. */
  const toggle = useCallback(
    async (task: LmsTask) => {
      setTasks((previous) =>
        previous.filter((entry) => entry.id !== task.id),
      );
      try {
        await setTaskCompleted(task.id, !task.completed);
      } catch (cause) {
        setError(String(cause));
        await refresh();
      }
    },
    [refresh],
  );

  return { tasks, sync, syncing, toggle, error, lastSync, refresh };
}
