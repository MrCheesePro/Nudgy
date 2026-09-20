/**
 * Deterministic free-slot arithmetic. No network, no model, no opinions — just the
 * intervals that are genuinely available between now and the end of the day.
 *
 * This is the layer that decides what is *allowed*. The LLM only decides what goes where.
 */

export interface Interval {
  startTs: number;
  endTs: number;
}

export interface Commitment extends Interval {
  label: string;
  /**
   * Seconds needed to reach this commitment, and to get back afterwards.
   *
   * A class at 2pm twenty-five minutes away does not free the time up to 2pm — it frees
   * the time up to 1:35. Travel is not a commitment of its own here because it is not
   * schedulable: it is an edge on the one it belongs to, so that clipping the commitment
   * to the window clips its travel with it.
   */
  travelBeforeSeconds?: number;
  travelAfterSeconds?: number;
}

/** A commitment grown by the travel it requires — what the day is really missing. */
export function withTravel(commitment: Commitment): Interval {
  return {
    startTs: commitment.startTs - (commitment.travelBeforeSeconds ?? 0),
    endTs: commitment.endTs + (commitment.travelAfterSeconds ?? 0),
  };
}

export interface SlotOptions {
  /** Now, in epoch seconds. */
  now: number;
  /** End of the usable day (bedtime), in epoch seconds. */
  dayEnd: number;
  /** Anything already spoken for: classes, meetings, existing blocks. */
  commitments?: Commitment[];
  /** Slots shorter than this are not worth scheduling into. */
  minSlotSeconds?: number;
  /**
   * Breathing room to leave either side of a commitment.
   *
   * Defaults to none, because this function answers a geometric question — where are the
   * gaps — and a gap is a gap. Deciding you should not *use* the last five minutes of one
   * is scheduling policy, so it lives in `placeWork`, which is what actually books time.
   *
   * Only applied where a slot abuts something: the start of the day and bedtime are not
   * events you have to get away from, so those edges are left alone.
   */
  bufferSeconds?: number;
}

/** What the planner leaves around a commitment. */
export const DEFAULT_BUFFER_SECONDS = 5 * 60;

export const DEFAULT_MIN_SLOT_SECONDS = 15 * 60;

/** Merges overlapping or touching intervals into the smallest equivalent set. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals]
    .filter((interval) => interval.endTs > interval.startTs)
    .sort((left, right) => left.startTs - right.startTs);

  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.startTs <= last.endTs) {
      last.endTs = Math.max(last.endTs, interval.endTs);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/**
 * Free time between `now` and `dayEnd`, minus commitments and the travel they require.
 * Commitments that started in the past are clipped rather than dropped — a meeting
 * running until 3pm still blocks the time between now and 3pm.
 */
export function findFreeSlots(options: SlotOptions): Interval[] {
  const { now, dayEnd } = options;
  const minSlot = options.minSlotSeconds ?? DEFAULT_MIN_SLOT_SECONDS;

  if (dayEnd <= now) return [];

  const busy = mergeIntervals(
    (options.commitments ?? [])
      .map(withTravel)
      .map((interval) => ({
        startTs: Math.max(interval.startTs, now),
        endTs: Math.min(interval.endTs, dayEnd),
      }))
      .filter((interval) => interval.endTs > interval.startTs),
  );

  const buffer = Math.max(0, options.bufferSeconds ?? 0);
  const free: Interval[] = [];
  let cursor = now;
  /** Whether the gap we are about to close began at a commitment rather than at `now`. */
  let afterCommitment = false;

  for (const interval of busy) {
    if (interval.startTs > cursor) {
      free.push({
        startTs: cursor + (afterCommitment ? buffer : 0),
        endTs: interval.startTs - buffer,
      });
    }
    cursor = Math.max(cursor, interval.endTs);
    afterCommitment = true;
  }
  if (cursor < dayEnd) {
    free.push({
      startTs: cursor + (afterCommitment ? buffer : 0),
      endTs: dayEnd,
    });
  }

  return free.filter((slot) => slot.endTs - slot.startTs >= minSlot);
}

/** True when `candidate` fits entirely inside one of `slots`. */
export function fitsInSlots(candidate: Interval, slots: Interval[]): boolean {
  return slots.some(
    (slot) => candidate.startTs >= slot.startTs && candidate.endTs <= slot.endTs,
  );
}

export function totalSeconds(intervals: Interval[]): number {
  return intervals.reduce((sum, interval) => sum + (interval.endTs - interval.startTs), 0);
}
