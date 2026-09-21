import { describe, expect, it } from "vitest";

import {
  applyDigit,
  formatTwelveHour,
  timeSuggestions,
  EMPTY_PARTS,
  hourComplete,
  minuteComplete,
  padTyped,
  settle,
  settleHour,
  settleMinute,
  toParts,
  toValue,
  type ClockParts,
  type Segment,
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

/**
 * What the control does per keystroke: apply the digit, and if that finished the segment,
 * settle it on the way out. The settle has to see the digit that was just typed.
 */
function type(parts: ClockParts, segment: Segment, typed: string): ClockParts {
  const step = applyDigit(parts, segment, typed);
  return step.advance ? settle(step.parts, segment) : step.parts;
}

describe("typing through the segments", () => {
  // The two symptoms of reading the segments one render late: a completed hour settled
  // from the empty copy that preceded it, and a second minute digit settled from the
  // first. Both are ordering, not rules, which is why the order is tested here.
  it("keeps an hour that completes on its first digit", () => {
    expect(type(EMPTY_PARTS, "hour", "3").hour).toBe("3");
  });

  it("keeps both minute digits rather than padding the first", () => {
    const afterFirst = type(EMPTY_PARTS, "minute", "5");
    expect(afterFirst.minute).toBe("5");
    expect(type(afterFirst, "minute", "55").minute).toBe("55");
  });

  it("types a whole time in five keystrokes", () => {
    let parts = type(EMPTY_PARTS, "hour", "1");
    parts = type(parts, "hour", "12");
    parts = type(parts, "minute", "3");
    parts = type(parts, "minute", "30");
    expect(toValue({ ...parts, meridiem: "PM" })).toBe("12:30");
  });

  it("advances only when the segment cannot take another digit", () => {
    expect(applyDigit(EMPTY_PARTS, "hour", "1").advance).toBe(false);
    expect(applyDigit(EMPTY_PARTS, "hour", "12").advance).toBe(true);
    expect(applyDigit(EMPTY_PARTS, "minute", "5").advance).toBe(false);
    expect(applyDigit(EMPTY_PARTS, "minute", "6").advance).toBe(true);
  });

  it("drops anything that is not a digit", () => {
    expect(applyDigit(EMPTY_PARTS, "hour", "a").parts.hour).toBe("");
  });
});

describe("timeSuggestions", () => {
  it("covers the whole day in quarter-hours", () => {
    const times = timeSuggestions();
    expect(times).toHaveLength(96);
    expect(times[0]).toBe("00:00");
    expect(times[1]).toBe("00:15");
    expect(times[times.length - 1]).toBe("23:45");
  });
});

describe("formatTwelveHour", () => {
  it("reads a stored time back the way it was typed", () => {
    expect(formatTwelveHour("14:30")).toBe("2:30 PM");
    expect(formatTwelveHour("00:00")).toBe("12:00 AM");
    expect(formatTwelveHour("")).toBe("");
  });
});
