import { describe, expect, it } from "vitest";

import { findFreeSlots } from "./slotFinder";
import {
  buildTravelIndex,
  matchPlace,
  padWithTravel,
  travelBetween,
  type LocatedCommitment,
} from "./travel";
import type { Place, TravelRow } from "../lib/types";

const HOME = 1;
const CAMPUS = 2;
const GYM = 3;

const rows: TravelRow[] = [
  [HOME, CAMPUS, "driving", 25 * 60],
  [CAMPUS, GYM, "driving", 10 * 60],
  [HOME, GYM, "walking", 40 * 60],
];

const index = buildTravelIndex(rows);

const places: Place[] = [
  { id: HOME, name: "Home", address: "1 Main St, Springfield", isBase: true, createdAt: 0 },
  { id: CAMPUS, name: "Campus", address: "400 College Ave, Springfield", isBase: false, createdAt: 0 },
  { id: GYM, name: "Gym", address: "22 Fitness Way, Springfield", isBase: false, createdAt: 0 },
];

/** 2026-09-21, local midnight, so the hour helper reads like a clock. */
const DAY = new Date(2026, 8, 21).getTime() / 1000;
const at = (hour: number, minute = 0) => DAY + hour * 3600 + minute * 60;

function commitment(
  label: string,
  startHour: number,
  endHour: number,
  placeId: number | null,
): LocatedCommitment {
  return { label, startTs: at(startHour), endTs: at(endHour), placeId };
}

describe("travelBetween", () => {
  it("reads a measured leg", () => {
    expect(travelBetween(index, HOME, CAMPUS)).toBe(1500);
  });

  // A round trip is rarely measured both ways, and the way back beats assuming zero.
  it("falls back to the reverse direction", () => {
    expect(travelBetween(index, CAMPUS, HOME)).toBe(1500);
  });

  it("is zero for the same place and for anything unmeasured", () => {
    expect(travelBetween(index, CAMPUS, CAMPUS)).toBe(0);
    expect(travelBetween(index, HOME, GYM)).toBe(0); // only measured for walking
    expect(travelBetween(index, null, CAMPUS)).toBe(0);
  });

  it("ignores legs measured in another mode", () => {
    expect(buildTravelIndex(rows, "walking").size).toBe(1);
  });
});

describe("matchPlace", () => {
  it("matches a place by name inside a longer location string", () => {
    expect(matchPlace("Campus — Hall 201", places)?.id).toBe(CAMPUS);
  });

  it("matches on the street line when the feed carries an address", () => {
    expect(matchPlace("400 College Ave, Springfield, IL", places)?.id).toBe(CAMPUS);
  });

  it("prefers the longer name when two could match", () => {
    const ambiguous: Place[] = [
      { id: 4, name: "Library", address: "x", isBase: false, createdAt: 0 },
      { id: 5, name: "Science Library", address: "y", isBase: false, createdAt: 0 },
    ];
    expect(matchPlace("Science Library, floor 2", ambiguous)?.id).toBe(5);
  });

  it("returns nothing rather than guessing", () => {
    expect(matchPlace("Zoom", places)).toBeNull();
    expect(matchPlace(null, places)).toBeNull();
  });
});

describe("padWithTravel", () => {
  it("charges the trip out and the trip home for a lone commitment", () => {
    const [padded] = padWithTravel([commitment("CS101", 14, 15, CAMPUS)], index, HOME);
    expect(padded.travelBeforeSeconds).toBe(1500);
    expect(padded.travelAfterSeconds).toBe(1500);
  });

  // The whole point: two classes in the same building are one trip out, not two.
  it("does not send you home between back-to-back commitments", () => {
    const padded = padWithTravel(
      [commitment("CS101", 14, 15, CAMPUS), commitment("Lab", 15, 16, CAMPUS)],
      index,
      HOME,
    );
    expect(padded[0].travelBeforeSeconds).toBe(1500);
    expect(padded[0].travelAfterSeconds).toBe(0); // stays out
    expect(padded[1].travelBeforeSeconds).toBe(0); // already there
    expect(padded[1].travelAfterSeconds).toBe(1500); // then home
  });

  it("charges the short hop between two nearby places, not a trip home", () => {
    const padded = padWithTravel(
      [commitment("CS101", 14, 15, CAMPUS), commitment("Lift", 15, 16, GYM)],
      index,
      HOME,
    );
    expect(padded[1].travelBeforeSeconds).toBe(600); // campus → gym
  });

  // Six hours apart is two separate outings, and pretending otherwise hands back an
  // afternoon that does not exist.
  it("goes home again when the gap is long", () => {
    const padded = padWithTravel(
      [commitment("CS101", 9, 10, CAMPUS), commitment("Seminar", 18, 19, CAMPUS)],
      index,
      HOME,
    );
    expect(padded[0].travelAfterSeconds).toBe(1500);
    expect(padded[1].travelBeforeSeconds).toBe(1500);
  });

  it("leaves a commitment with no location entirely alone", () => {
    const [padded] = padWithTravel([commitment("Call", 11, 12, null)], index, HOME);
    expect(padded.travelBeforeSeconds).toBeUndefined();
  });

  it("pads nothing when there is no base to measure from", () => {
    const [padded] = padWithTravel([commitment("CS101", 14, 15, CAMPUS)], index, null);
    expect(padded.travelBeforeSeconds).toBe(0);
  });
});

describe("findFreeSlots with travel", () => {
  // The headline behaviour: a 2pm class 25 minutes away ends the morning at 1:35,
  // not at 2:00.
  it("ends a slot early enough to actually leave", () => {
    const padded = padWithTravel([commitment("CS101", 14, 15, CAMPUS)], index, HOME);
    const slots = findFreeSlots({
      now: at(9),
      dayEnd: at(22),
      commitments: padded,
    });

    expect(slots[0].endTs).toBe(at(13, 35));
    expect(slots[1].startTs).toBe(at(15, 25)); // home again before the evening
  });

  it("matches the untravelled result when nothing has a location", () => {
    const plain = padWithTravel([commitment("Call", 14, 15, null)], index, HOME);
    const slots = findFreeSlots({ now: at(9), dayEnd: at(22), commitments: plain });
    expect(slots[0].endTs).toBe(at(14));
  });

  // Travel is an edge on a commitment, not a commitment of its own, so it clips with it.
  it("clips travel that runs past the end of the day", () => {
    const padded = padWithTravel([commitment("Seminar", 20, 21, CAMPUS)], index, HOME);
    const slots = findFreeSlots({ now: at(9), dayEnd: at(21), commitments: padded });
    expect(slots).toHaveLength(1);
    expect(slots[0].endTs).toBe(at(19, 35));
  });
});
