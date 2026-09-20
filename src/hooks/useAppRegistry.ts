import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { refreshCategories } from "../lib/categories";
import {
  flushSamples,
  getAppRules,
  getAppTotals,
  listUnmappedProcesses,
} from "../lib/ipc";
import { dayBounds } from "../lib/time";
import type { AppRule, AppTotal, UnmappedProcess } from "../lib/types";

/**
 * Everything the App registry tab draws, behind one `refresh`.
 *
 * Rules and totals load together on purpose: the question the tab answers is "what does
 * Nudgy know about, and where did today's time go in it", and that is one question. A
 * flush comes first for the same reason `useUsageStats` does it — otherwise an app opened
 * a minute ago is missing from a screen whose whole job is to list it.
 */
export function useAppRegistry() {
  const [rules, setRules] = useState<AppRule[]>([]);
  const [totals, setTotals] = useState<AppTotal[]>([]);
  const [unmapped, setUnmapped] = useState<UnmappedProcess[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      await flushSamples();
      const { startTs, endTs } = dayBounds();
      const [nextRules, nextTotals, nextUnmapped] = await Promise.all([
        getAppRules(),
        getAppTotals(startTs, endTs, 200),
        listUnmappedProcesses(),
        refreshCategories(),
      ]);
      setRules(nextRules);
      setTotals(nextTotals);
      setUnmapped(nextUnmapped);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unlisten = listen("nudgy://flushed", () => void refresh());
    return () => {
      unlisten.then((dispose) => dispose()).catch(() => undefined);
    };
  }, [refresh]);

  return { rules, totals, unmapped, error, loading, refresh };
}
