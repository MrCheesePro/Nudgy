import { useCallback, useEffect, useState } from "react";

import { getCalendarEvents } from "../lib/ipc";
import type { CalendarEvent } from "../lib/types";
import type { Commitment } from "../services/slotFinder";

/**
 * How often to ask, when nothing has prompted it.
 *
 * Every few minutes rather than every ten: the request is one small file, and the cost of
 * being slow is a class the planner did not know about. The real lag is Google's — its
 * iCal export can serve a stale copy for hours after you change something, and no polling
 * interval on this side reaches that.
 */
const REFRESH_MS = 3 * 60 * 1000;
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
  /** When the feed was last actually fetched, so the UI can say rather than imply. */
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

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
      setCheckedAt(Date.now());
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

    /*
     * Coming back to the app is the moment most likely to follow a change.
     *
     * You move an event in the browser and switch to Nudgy — that switch is the signal,
     * and waiting out a timer afterwards is the difference between the calendar being
     * right when you look at it and being right a few minutes later.
     */
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
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

  return { events, commitmentsIn, refresh, error, loading, checkedAt };
}
