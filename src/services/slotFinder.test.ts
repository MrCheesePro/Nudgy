import { describe, expect, it } from "vitest";

import { findFreeSlots, mergeIntervals, totalSeconds } from "./slotFinder";

const HOUR = 3600;
const NOON = 1_789_700_000;

describe("mergeIntervals", () => {
  it("merges overlapping and touching intervals", () => {
    const merged = mergeIntervals([
      { startTs: 0, endTs: 100 },
      { startTs: 50, endTs: 200 },
      { startTs: 200, endTs: 300 },
      { startTs: 500, endTs: 600 },
    ]);
    expect(merged).toEqual([
      { startTs: 0, endTs: 300 },
      { startTs: 500, endTs: 600 },
    ]);
  });

  it("drops zero-length intervals", () => {
    expect(mergeIntervals([{ startTs: 10, endTs: 10 }])).toEqual([]);
  });
});

describe("findFreeSlots", () => {
  it("returns the whole window when nothing is committed", () => {
    const slots = findFreeSlots({ now: NOON, dayEnd: NOON + 4 * HOUR });
    expect(slots).toEqual([{ startTs: NOON, endTs: NOON + 4 * HOUR }]);
  });

  it("carves commitments out of the window", () => {
    const slots = findFreeSlots({
      now: NOON,
      dayEnd: NOON + 6 * HOUR,
      commitments: [
        { startTs: NOON + HOUR, endTs: NOON + 2 * HOUR, label: "Lecture" },
        { startTs: NOON + 3 * HOUR, endTs: NOON + 4 * HOUR, label: "Lab" },
      ],
    });
    expect(slots).toEqual([
      { startTs: NOON, endTs: NOON + HOUR },
      { startTs: NOON + 2 * HOUR, endTs: NOON + 3 * HOUR },
      { startTs: NOON + 4 * HOUR, endTs: NOON + 6 * HOUR },
    ]);
  });

  it("clips a commitment that started before now instead of ignoring it", () => {
    const slots = findFreeSlots({
      now: NOON,
      dayEnd: NOON + 2 * HOUR,
      commitments: [{ startTs: NOON - HOUR, endTs: NOON + HOUR, label: "Standup" }],
    });
    expect(slots).toEqual([{ startTs: NOON + HOUR, endTs: NOON + 2 * HOUR }]);
  });

  it("discards fragments shorter than the minimum", () => {
    const slots = findFreeSlots({
      now: NOON,
      dayEnd: NOON + HOUR,
      commitments: [{ startTs: NOON + 300, endTs: NOON + HOUR, label: "Call" }],
      minSlotSeconds: 900,
    });
    expect(slots).toEqual([]);
  });

  it("returns nothing when the day is already over", () => {
    expect(findFreeSlots({ now: NOON, dayEnd: NOON - HOUR })).toEqual([]);
    expect(totalSeconds([])).toBe(0);
  });
});
