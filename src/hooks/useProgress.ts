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
/**
 * One copy of the history, shared by every caller.
 *
 * This hook is mounted twice: `App` holds one from startup for the streaks on Today, and
 * the progress page mounts another when you open it. They fetch the same two months of
 * the same table — so the page opened on an empty screen and waited for a query whose
 * answer was already in memory, which is the whole of why it stalled and the other views
 * did not.
 *
 * The cache is module-level rather than a context because there is exactly one answer:
 * the window fetched does not depend on the range asked for, only the slicing does.
 */
interface Snapshot {
  rows: DailyTotal[];
  targets: CategoryTarget[];
  error: string | null;
  /** False only before the first successful read, which is the only time to show nothing. */
  loaded: boolean;
}

let cache: Snapshot = { rows: [], targets: [], error: null, loaded: false };
const listeners = new Set<(next: Snapshot) => void>();

/** The read in flight, so two callers asking at once make one round trip. */
let inflight: Promise<void> | null = null;
let lastLoadedAt = 0;

/** Below this, a second request is answered by what is already here. */
const MIN_REFETCH_MS = 2_000;

async function load(flushFirst: boolean, force: boolean): Promise<void> {
  if (inflight) return inflight;
  if (!force && cache.loaded && Date.now() - lastLoadedAt < MIN_REFETCH_MS) return;

  inflight = (async () => {
    try {
      if (flushFirst) await flushSamples();
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (Math.max(...RANGES) * 2 - 1));
      const end = new Date();
      end.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() + 1);

      const [rows, targets] = await Promise.all([
        getDailyTotals(Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000)),
        getCategoryTargets(),
        refreshCategories(),
      ]);
      cache = { rows, targets, error: null, loaded: true };
    } catch (cause) {
      cache = { ...cache, error: String(cause), loaded: true };
    } finally {
      lastLoadedAt = Date.now();
      inflight = null;
      for (const listener of listeners) listener(cache);
    }
  })();

  return inflight;
}

export function useProgress(range: Range) {
  // Seeded from the cache, so an instance mounting into a warm one renders with data on
  // its very first pass — no blank frame, nothing to wait for.
  const [{ rows, targets, error, loaded }, setSnapshot] = useState<Snapshot>(cache);

  const refresh = useCallback(
    (flushFirst = true) => load(flushFirst, flushFirst),
    [],
  );

  useEffect(() => {
    listeners.add(setSnapshot);
    // Whatever the cache holds may have moved on since this instance last looked.
    setSnapshot(cache);
    return () => {
      listeners.delete(setSnapshot);
    };
  }, []);

  const loading = !loaded;

  useEffect(() => {
    // The first read paints the page; the flush can wait for the one after it. With a
    // warm cache this is a no-op and the page is already drawn.
    void load(false, false);
    const timer = window.setInterval(() => void load(true, true), 60_000);

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
      void load(false, true);
    });
    return () => {
      window.clearInterval(timer);
      unlisten.then((dispose) => dispose()).catch(() => undefined);
    };
  }, []);

  /** What the chart draws. */
  const series = useMemo(() => dailySeries(rows, range), [rows, range]);
  /** The full window, so `trend` has a prior period to measure against. */
  const full = useMemo(() => dailySeries(rows, Math.max(...RANGES) * 2), [rows]);

  const saveTarget = useCallback(
    async (category: string, direction: "at_least" | "at_most", secondsPerDay: number) => {
      await setCategoryTarget(category, direction, secondsPerDay);
      // Forced: a target the user just set has to appear, whatever the cache thinks.
      await load(false, true);
    },
    [refresh],
  );

  const removeTarget = useCallback(
    async (category: string) => {
      await clearCategoryTarget(category);
      await load(false, true);
    },
    [refresh],
  );

  return { series, full, targets, error, loading, refresh, saveTarget, removeTarget };
}
