import { useCallback, useEffect, useState } from "react";

import { getCalendarEvents } from "../lib/ipc";
import type { CalendarEvent, Place, TravelRow } from "../lib/types";
import type { Commitment } from "../services/slotFinder";
import {
  buildTravelIndex,
  matchPlace,
  padWithTravel,
  travelBetween,
  type LocatedCommitment,
} from "../services/travel";

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
  const [places, setPlaces] = useState<Place[]>([]);
  /** Travel times already looked up. Rebuilt with the feed, read on every plan. */
  const [travel, setTravel] = useState(() => buildTravelIndex([]));
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

      const [nextEvents, nextPlaces, nextTravel] = await Promise.all([
        getCalendarEvents(
          Math.floor(start.getTime() / 1000),
          Math.floor(end.getTime() / 1000),
        ),
        // Mothballed with the travel feature: these resolve empty rather than querying,
        // so `commitmentsIn` takes its no-places path and the planner behaves exactly as
        // it did before places existed. Restore the two calls to switch it back on.
        Promise.resolve([] as Place[]),
        Promise.resolve([] as TravelRow[]),
      ]);
      setEvents(nextEvents);
      setPlaces(nextPlaces);
      setTravel(buildTravelIndex(nextTravel));
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
   * Events overlapping a window, as commitments, each grown by the travel it requires.
   *
   * All-day events are skipped: they mark the day rather than occupy it, and treating a
   * birthday as 24 busy hours would leave nowhere to schedule.
   *
   * The padding runs over the whole window rather than per event, because whether you go
   * home between two classes depends on the one after — a question a single event cannot
   * answer about itself.
   */
  const commitmentsIn = useCallback(
    (startTs: number, endTs: number): Commitment[] => {
      const inWindow: LocatedCommitment[] = events
        .filter((event) => !event.allDay && event.endTs > startTs && event.startTs < endTs)
        .map((event) => ({
          startTs: event.startTs,
          endTs: event.endTs,
          label: event.summary,
          placeId: matchPlace(event.location, places)?.id ?? null,
        }));

      const base = places.find((place) => place.isBase) ?? null;
      // No base, or nothing located: this is the behaviour from before places existed.
      if (base === null || inWindow.every((entry) => entry.placeId === null)) return inWindow;

      return padWithTravel(inWindow, travel, base.id);
    },
    [events, places, travel],
  );

  /** Seconds from the base to a place. Zero when unmeasured or when there is no base. */
  const travelFromBase = useCallback(
    (placeId: number): number => {
      const base = places.find((place) => place.isBase);
      return base ? travelBetween(travel, base.id, placeId) : 0;
    },
    [places, travel],
  );

  return { events, places, commitmentsIn, travelFromBase, refresh, error, loading };
}
