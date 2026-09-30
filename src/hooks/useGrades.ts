import { useCallback, useEffect, useState } from "react";

import { listGrades } from "../lib/ipc";
import type { GradesSnapshot } from "../lib/types";

const EMPTY: GradesSnapshot = { courses: [], categories: [], items: [] };

/**
 * Every class, its grading breakdown and its grades, as one snapshot.
 *
 * One command rather than three, because a grade is meaningless without all of them and
 * three round trips is a frame where it is wrong. Writes go through the IPC wrappers
 * directly and then call `refresh` — the tables are small, and re-reading is simpler than
 * keeping a second copy of the rules that decide what a write changed.
 */
export function useGrades() {
  const [snapshot, setSnapshot] = useState<GradesSnapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await listGrades());
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Runs a write, then re-reads; a failure lands in `error` rather than throwing. */
  const run = useCallback(
    async (write: () => Promise<unknown>) => {
      try {
        await write();
        setError(null);
      } catch (cause) {
        setError(String(cause));
      }
      await refresh();
    },
    [refresh],
  );

  return { ...snapshot, loading, error, refresh, run };
}
