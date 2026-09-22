import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { flushSamples, getAppTotals, getUsageBreakdown } from "../lib/ipc";
import { dayBounds } from "../lib/time";
import { dayKey } from "../services/progress";
import type { AppTotal, UsageBreakdown } from "../lib/types";

/**
 * Today's totals. Reads force a buffer flush first — otherwise the chart would lag the
 * live header by up to 45 seconds, which reads as a bug even though it is by design.
 */
export function useUsageStats() {
  const [breakdown, setBreakdown] = useState<UsageBreakdown | null>(null);
  const [apps, setApps] = useState<AppTotal[]>([]);
  const [error, setError] = useState<string | null>(null);

  /** The local day the last refresh was for, so a rollover can be noticed rather than
   *  waited out. */
  const currentDay = useRef(dayKey(new Date()));

  /**
   * `flushFirst` drains the sample buffer before reading.
   *
   * Worth it on a poll or a day rollover, where the buffer may hold seconds nothing has
   * written yet. Never worth it when the refresh was *caused* by a flush: the table
   * already has everything, and asking for another write transaction on the event that
   * announced the last one is pure cost.
   */
  const refresh = useCallback(async (flushFirst = true) => {
    try {
      if (flushFirst) await flushSamples();
      currentDay.current = dayKey(new Date());
      const { startTs, endTs } = dayBounds();
      const [nextBreakdown, nextApps] = await Promise.all([
        getUsageBreakdown(startTs, endTs),
        getAppTotals(startTs, endTs),
      ]);
      setBreakdown(nextBreakdown);
      setApps(nextApps);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    const unlisten = listen("nudgy://flushed", () => void refresh(false));

    // Midnight, and waking up after it. The interval alone would roll the day over
    // eventually, but a laptop opened at 9am would show yesterday's totals until the next
    // tick — long enough to be believed.
    const onWake = () => {
      if (dayKey(new Date()) !== currentDay.current) void refresh();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      unlisten.then((dispose) => dispose()).catch(() => undefined);
    };
  }, [refresh]);

  return { breakdown, apps, error, refresh };
}
