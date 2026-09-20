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
}

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
 * Free time between `now` and `dayEnd`, minus commitments. Commitments that started in
 * the past are clipped rather than dropped — a meeting running until 3pm still blocks
 * the time between now and 3pm.
 */
export function findFreeSlots(options: SlotOptions): Interval[] {
  const { now, dayEnd } = options;
  const minSlot = options.minSlotSeconds ?? DEFAULT_MIN_SLOT_SECONDS;

  if (dayEnd <= now) return [];

  const busy = mergeIntervals(
    (options.commitments ?? [])
      .map((commitment) => ({
        startTs: Math.max(commitment.startTs, now),
        endTs: Math.min(commitment.endTs, dayEnd),
      }))
      .filter((interval) => interval.endTs > interval.startTs),
  );

  const free: Interval[] = [];
  let cursor = now;

  for (const interval of busy) {
    if (interval.startTs > cursor) {
      free.push({ startTs: cursor, endTs: interval.startTs });
    }
    cursor = Math.max(cursor, interval.endTs);
  }
  if (cursor < dayEnd) {
    free.push({ startTs: cursor, endTs: dayEnd });
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
