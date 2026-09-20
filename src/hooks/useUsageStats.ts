import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  flushSamples,
  getAppTotals,
  getUsageBreakdown,
  getWindowTotals,
  listUnmappedProcesses,
} from "../lib/ipc";
import { dayBounds } from "../lib/time";
import type { AppTotal, UnmappedProcess, UsageBreakdown, WindowTotal } from "../lib/types";

/**
 * Today's totals. Reads force a buffer flush first — otherwise the chart would lag the
 * live header by up to 45 seconds, which reads as a bug even though it is by design.
 */
export function useUsageStats() {
  const [breakdown, setBreakdown] = useState<UsageBreakdown | null>(null);
  const [apps, setApps] = useState<AppTotal[]>([]);
  /** What each app was showing, so "Google Chrome" can say which page. */
  const [windows, setWindows] = useState<WindowTotal[]>([]);
  const [unmapped, setUnmapped] = useState<UnmappedProcess[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      await flushSamples();
      const { startTs, endTs } = dayBounds();
      const [nextBreakdown, nextApps, nextWindows, nextUnmapped] = await Promise.all([
        getUsageBreakdown(startTs, endTs),
        getAppTotals(startTs, endTs),
        getWindowTotals(startTs, endTs),
        listUnmappedProcesses(),
      ]);
      setBreakdown(nextBreakdown);
      setApps(nextApps);
      setWindows(nextWindows);
      setUnmapped(nextUnmapped);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    const unlisten = listen("nudgy://flushed", () => void refresh());
    return () => {
      window.clearInterval(timer);
      unlisten.then((dispose) => dispose()).catch(() => undefined);
    };
  }, [refresh]);

  return { breakdown, apps, windows, unmapped, error, refresh };
}
