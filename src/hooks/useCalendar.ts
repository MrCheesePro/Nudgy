import { useCallback, useEffect, useState } from "react";

import { getCalendarEvents } from "../lib/ipc";
import type { CalendarEvent } from "../lib/types";
import type { Commitment } from "../services/slotFinder";

const REFRESH_MS = 10 * 60 * 1000;
/** Wide enough that stepping a few weeks either way still has events. */
const HORIZON_DAYS = 42;
const LOOKBACK_DAYS = 7;

/**
 * The calendar feed, covering today through the planning horizon. Everything in here
 * becomes a commitment the planner refuses to schedule over.
 */
export function useCalendar() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - LOOKBACK_DAYS);
      const end = new Date();
      end.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() + HORIZON_DAYS);

      setEvents(
        await getCalendarEvents(
          Math.floor(start.getTime() / 1000),
          Math.floor(end.getTime() / 1000),
        ),
      );
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  /**
   * Events overlapping a window, as commitments. All-day events are skipped: they mark
   * the day rather than occupy it, and treating a birthday as 24 busy hours would leave
   * nowhere to schedule.
   */
  const commitmentsIn = useCallback(
    (startTs: number, endTs: number): Commitment[] =>
      events
        .filter((event) => !event.allDay && event.endTs > startTs && event.startTs < endTs)
        .map((event) => ({
          startTs: event.startTs,
          endTs: event.endTs,
          label: event.summary,
        })),
    [events],
  );

  return { events, commitmentsIn, refresh, error, loading };
}
