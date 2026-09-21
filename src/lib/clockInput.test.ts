import { describe, expect, it } from "vitest";

import {
  EMPTY_PARTS,
  hourComplete,
  minuteComplete,
  padTyped,
  settleHour,
  settleMinute,
  toParts,
  toValue,
} from "./clockInput";

describe("toParts", () => {
  it("splits an afternoon time into twelve-hour segments", () => {
    expect(toParts("14:30")).toEqual({ hour: "2", minute: "30", meridiem: "PM" });
  });

  // The two the obvious modulo gets wrong, and the two people notice.
  it("calls midnight 12 AM and noon 12 PM", () => {
    expect(toParts("00:00")).toEqual({ hour: "12", minute: "00", meridiem: "AM" });
    expect(toParts("12:00")).toEqual({ hour: "12", minute: "00", meridiem: "PM" });
  });

  it("gives back nothing for anything it cannot read", () => {
    expect(toParts("")).toEqual(EMPTY_PARTS);
    expect(toParts("25:00")).toEqual(EMPTY_PARTS);
    expect(toParts("bedtime")).toEqual(EMPTY_PARTS);
  });
});

describe("toValue", () => {
  it("round-trips through the segments", () => {
    for (const value of ["00:00", "07:05", "12:00", "13:45", "23:59"]) {
      expect(toValue(toParts(value))).toBe(value);
    }
  });

  /**
   * A half-typed hour must not resolve to a real time, or the planner acts on 1:00 while
   * somebody is still typing 1:45.
   */
  it("is empty until all three segments are set", () => {
    expect(toValue({ hour: "1", minute: "", meridiem: "" })).toBe("");
    expect(toValue({ hour: "1", minute: "30", meridiem: "" })).toBe("");
    expect(toValue({ hour: "", minute: "30", meridiem: "PM" })).toBe("");
  });

  it("refuses an hour or minute outside the clock", () => {
    expect(toValue({ hour: "13", minute: "00", meridiem: "PM" })).toBe("");
    expect(toValue({ hour: "0", minute: "00", meridiem: "AM" })).toBe("");
    expect(toValue({ hour: "11", minute: "75", meridiem: "AM" })).toBe("");
  });
});

describe("hourComplete", () => {
  // One digit is enough whenever a second could not make a real hour.
  it("waits on a 1, which might still become 12", () => {
    expect(hourComplete("1")).toBe(false);
    expect(hourComplete("12")).toBe(true);
  });

  it("moves on from a digit that can only stand alone", () => {
    expect(hourComplete("3")).toBe(true);
    expect(hourComplete("9")).toBe(true);
  });

  it("waits on a leading zero", () => {
    expect(hourComplete("0")).toBe(false);
    expect(hourComplete("09")).toBe(true);
  });

  it("is never complete when empty", () => {
    expect(hourComplete("")).toBe(false);
  });
});

describe("minuteComplete", () => {
  it("waits while a second digit could still follow", () => {
    expect(minuteComplete("3")).toBe(false);
    expect(minuteComplete("30")).toBe(true);
  });

  it("moves on from a digit too large to lead", () => {
    expect(minuteComplete("6")).toBe(true);
  });
});

describe("settling", () => {
  it("clamps to the ends of the clock", () => {
    expect(settleHour("99")).toBe("12");
    expect(settleHour("0")).toBe("1");
    expect(settleMinute("88")).toBe("59");
  });

  it("leaves an empty segment empty", () => {
    expect(settleHour("")).toBe("");
    expect(settleMinute("")).toBe("");
  });

  // Typing 7 into minutes means 07, not 70.
  it("pads a lone digit into the tens place", () => {
    expect(padTyped("7")).toBe("07");
    expect(padTyped("45")).toBe("45");
  });
});
