import type { Place, TravelRow } from "../lib/types";
import type { Commitment } from "./slotFinder";

/**
 * Turning "where" into "when you have to leave".
 *
 * Everything here is arithmetic over travel times already looked up and cached — no
 * network, no model, same as the rest of the planner. A missing number means no padding,
 * never a guess: quietly inventing a commute would be worse than ignoring one, because a
 * day the planner silently shrank is a day you cannot account for.
 */

/** Travel times keyed `originId:destinationId`, for the mode in use. */
export type TravelIndex = Map<string, number>;

export function travelKey(originId: number, destinationId: number): string {
  return `${originId}:${destinationId}`;
}

export function buildTravelIndex(rows: TravelRow[], mode = "driving"): TravelIndex {
  const index: TravelIndex = new Map();
  for (const [originId, destinationId, rowMode, seconds] of rows) {
    if (rowMode !== mode) continue;
    index.set(travelKey(originId, destinationId), seconds);
  }
  return index;
}

/**
 * Seconds from one place to another. Symmetric fallback on purpose: a round trip is
 * rarely measured in both directions, and the way back is a far better estimate of the
 * way there than zero is.
 */
export function travelBetween(
  index: TravelIndex,
  originId: number | null,
  destinationId: number | null,
): number {
  if (originId === null || destinationId === null) return 0;
  if (originId === destinationId) return 0;
  return (
    index.get(travelKey(originId, destinationId)) ??
    index.get(travelKey(destinationId, originId)) ??
    0
  );
}

/** Matches a feed's free-text LOCATION to a place the user named. */
export function matchPlace(location: string | null | undefined, places: Place[]): Place | null {
  if (!location) return null;
  const haystack = location.toLowerCase();

  // Longest name first, so "Science Library" beats "Library" on a string holding both.
  const byLength = [...places].sort((left, right) => right.name.length - left.name.length);
  for (const place of byLength) {
    const name = place.name.toLowerCase();
    // Two characters would match almost any address line.
    if (name.length >= 3 && haystack.includes(name)) return place;
  }
  // The feed often carries the address itself rather than a friendly name.
  for (const place of byLength) {
    const head = place.address.toLowerCase().split(",")[0]?.trim();
    if (head && head.length >= 4 && haystack.includes(head)) return place;
  }
  return null;
}

export interface LocatedCommitment extends Commitment {
  /** Resolved from the feed's LOCATION, or null when nothing matched. */
  placeId: number | null;
}

/**
 * Works out, for a day's commitments in order, how long before each one you have to
 * leave — and how long it takes to get back afterwards.
 *
 * The origin is whatever you were at last: the previous located commitment if it ends
 * close enough that you would go straight there, otherwise the base. That "close enough"
 * matters. Two classes back to back in the same building are one trip out and one trip
 * home; two classes six hours apart are two round trips, and pretending otherwise gives
 * back an afternoon that does not exist.
 */
export function padWithTravel(
  commitments: LocatedCommitment[],
  index: TravelIndex,
  basePlaceId: number | null,
  options: { chainGapSeconds?: number } = {},
): LocatedCommitment[] {
  // Under this gap you stay out rather than going home in between.
  const chainGap = options.chainGapSeconds ?? 3 * 60 * 60;

  const ordered = [...commitments].sort((left, right) => left.startTs - right.startTs);

  return ordered.map((commitment, position) => {
    if (commitment.placeId === null) return commitment;

    const previous = [...ordered.slice(0, position)]
      .reverse()
      .find((entry) => entry.placeId !== null) ?? null;

    const chained =
      previous !== null && commitment.startTs - previous.endTs <= chainGap;
    const origin = chained ? previous.placeId : basePlaceId;

    const next = ordered
      .slice(position + 1)
      .find((entry) => entry.placeId !== null) ?? null;
    const staysOut = next !== null && next.startTs - commitment.endTs <= chainGap;

    return {
      ...commitment,
      travelBeforeSeconds: travelBetween(index, origin, commitment.placeId),
      // Heading straight to the next place? That leg is charged to the next commitment,
      // not to this one, or the same journey would be subtracted from the day twice.
      travelAfterSeconds: staysOut
        ? 0
        : travelBetween(index, commitment.placeId, basePlaceId),
    };
  });
}

/** "leave 25 min early" — the one line the UI needs to explain a shortened slot. */
export function describeTravel(seconds: number): string {
  if (seconds <= 0) return "";
  const minutes = Math.round(seconds / 60);
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
