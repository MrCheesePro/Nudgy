import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { refreshCategories } from "../lib/categories";
import {
  clearCategoryTarget,
  flushSamples,
  getCategoryTargets,
  getDailyTotals,
  setCategoryTarget,
} from "../lib/ipc";
import type { CategoryTarget, DailyTotal } from "../lib/types";
import { dailySeries } from "../services/progress";

/** How far back the page can look. The longest one bounds what is ever fetched. */
/** At most one refresh per this many milliseconds in response to a flush. */
const FLUSH_COALESCE_MS = 30_000;

export const RANGES = [7, 14, 30] as const;
export type Range = (typeof RANGES)[number];

/**
 * History and targets, behind one `refresh`.
 *
 * The fetch always covers the longest range plus a matching window before it — `trend`
 * compares one period against the one preceding it, so asking for exactly what the chart
 * draws would leave nothing to compare against. Narrowing to 7 days is then a slice, not
 * another round trip.
 */
export function useProgress(range: Range) {
  const [rows, setRows] = useState<DailyTotal[]>([]);
  const [targets, setTargets] = useState<CategoryTarget[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (flushFirst = true) => {
    try {
      if (flushFirst) await flushSamples();
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (Math.max(...RANGES) * 2 - 1));
      const end = new Date();
      end.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() + 1);

      const [nextRows, nextTargets] = await Promise.all([
        getDailyTotals(Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000)),
        getCategoryTargets(),
        refreshCategories(),
      ]);
      setRows(nextRows);
      setTargets(nextTargets);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // The first read paints the page; the flush can wait for the one after it.
    void refresh(false);
    const timer = window.setInterval(() => void refresh(), 60_000);

    /*
     * Flushes arrive every few seconds. This page does not.
     *
     * It reads two months of daily totals, the targets and the category list, then redraws
     * a chart — and it is mounted twice, once for the page and once for the streaks on
     * Today. Answering every flush meant all of that six times a minute per instance, for
     * a chart whose bars are days: the newest one grows by a few seconds and the rest
     * cannot change at all. Coalescing to twice a minute is still far fresher than the
     * thing being drawn.
     */
    let lastFromFlush = 0;
    const unlisten = listen("nudgy://flushed", () => {
      const now = Date.now();
      if (now - lastFromFlush < FLUSH_COALESCE_MS) return;
      lastFromFlush = now;
      void refresh(false);
    });
    return () => {
      window.clearInterval(timer);
      unlisten.then((dispose) => dispose()).catch(() => undefined);
    };
  }, [refresh]);

  /** What the chart draws. */
  const series = useMemo(() => dailySeries(rows, range), [rows, range]);
  /** The full window, so `trend` has a prior period to measure against. */
  const full = useMemo(() => dailySeries(rows, Math.max(...RANGES) * 2), [rows]);

  const saveTarget = useCallback(
    async (category: string, direction: "at_least" | "at_most", secondsPerDay: number) => {
      await setCategoryTarget(category, direction, secondsPerDay);
      await refresh();
    },
    [refresh],
  );

  const removeTarget = useCallback(
    async (category: string) => {
      await clearCategoryTarget(category);
      await refresh();
    },
    [refresh],
  );

  return { series, full, targets, error, loading, refresh, saveTarget, removeTarget };
}
