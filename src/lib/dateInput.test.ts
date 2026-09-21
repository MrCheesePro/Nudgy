import { describe, expect, it } from "vitest";

import {
  applyDateDigit,
  daysIn,
  EMPTY_DATE,
  segmentComplete,
  settleDate,
  toDateParts,
  toDateValue,
  type DateParts,
  type DateSegment,
} from "./dateInput";

describe("toDateParts", () => {
  it("splits an ISO date into segments", () => {
    expect(toDateParts("2026-02-09")).toEqual({ year: "2026", month: "02", day: "09" });
  });

  it("gives back nothing for anything it cannot read", () => {
    expect(toDateParts("")).toEqual(EMPTY_DATE);
    expect(toDateParts("9/2/26")).toEqual(EMPTY_DATE);
  });
});

describe("toDateValue", () => {
  it("round-trips", () => {
    for (const value of ["2026-01-01", "2026-12-31", "2024-02-29"]) {
      expect(toDateValue(toDateParts(value))).toBe(value);
    }
  });

  it("is empty until every segment is set", () => {
    expect(toDateValue({ month: "02", day: "09", year: "" })).toBe("");
    expect(toDateValue({ month: "02", day: "", year: "2026" })).toBe("");
    expect(toDateValue({ month: "", day: "09", year: "2026" })).toBe("");
  });

  it("waits for all four digits of the year", () => {
    expect(toDateValue({ month: "02", day: "09", year: "202" })).toBe("");
  });

  /**
   * A `Date` constructor rolls 31 February into March. A deadline that silently moves a
   * month is worse than one that refuses to be typed.
   */
  it("refuses a day the month does not have", () => {
    expect(toDateValue({ month: "02", day: "31", year: "2026" })).toBe("");
    expect(toDateValue({ month: "02", day: "29", year: "2025" })).toBe("");
    expect(toDateValue({ month: "02", day: "29", year: "2024" })).toBe("2024-02-29");
  });

  it("refuses a month outside the year", () => {
    expect(toDateValue({ month: "13", day: "01", year: "2026" })).toBe("");
    expect(toDateValue({ month: "00", day: "01", year: "2026" })).toBe("");
  });
});

describe("daysIn", () => {
  it("knows the short months and the leap years", () => {
    expect(daysIn(2026, 2)).toBe(28);
    expect(daysIn(2024, 2)).toBe(29);
    expect(daysIn(2026, 4)).toBe(30);
    expect(daysIn(2026, 12)).toBe(31);
  });
});

describe("segmentComplete", () => {
  // One digit is enough whenever a second could not make a real value.
  it("waits on a month that might still become 12", () => {
    expect(segmentComplete("month", "1")).toBe(false);
    expect(segmentComplete("month", "12")).toBe(true);
    expect(segmentComplete("month", "2")).toBe(true);
  });

  it("waits on a day that might still become 31", () => {
    expect(segmentComplete("day", "3")).toBe(false);
    expect(segmentComplete("day", "31")).toBe(true);
    expect(segmentComplete("day", "4")).toBe(true);
  });

  it("always waits for four digits of year", () => {
    expect(segmentComplete("year", "202")).toBe(false);
    expect(segmentComplete("year", "2026")).toBe(true);
  });
});

/** Apply the digit, and if it finished the segment, settle it on the way out. */
function type(parts: DateParts, segment: DateSegment, typed: string): DateParts {
  const step = applyDateDigit(parts, segment, typed);
  return step.advance ? settleDate(step.parts, segment) : step.parts;
}

describe("typing through the segments", () => {
  it("types a whole date, advancing as it goes", () => {
    let parts = type(EMPTY_DATE, "month", "9");
    expect(parts.month).toBe("09");
    parts = type(parts, "day", "2");
    expect(parts.day).toBe("2");
    parts = type(parts, "day", "21");
    parts = type(parts, "year", "2026");
    expect(toDateValue(parts)).toBe("2026-09-21");
  });

  it("keeps both day digits rather than padding the first", () => {
    const afterFirst = type(EMPTY_DATE, "day", "1");
    expect(afterFirst.day).toBe("1");
    expect(type(afterFirst, "day", "15").day).toBe("15");
  });

  it("drops anything that is not a digit", () => {
    expect(applyDateDigit(EMPTY_DATE, "month", "x").parts.month).toBe("");
  });
});

describe("settleDate", () => {
  it("clamps the month to the year", () => {
    expect(settleDate({ ...EMPTY_DATE, month: "99" }, "month").month).toBe("12");
    expect(settleDate({ ...EMPTY_DATE, month: "0" }, "month").month).toBe("01");
  });

  // Not to 31: picking February and typing 30 should land on the 28th, not next month.
  it("clamps the day to the month it is in", () => {
    const february = { month: "02", day: "30", year: "2026" };
    expect(settleDate(february, "day").day).toBe("28");
    expect(settleDate({ ...february, year: "2024" }, "day").day).toBe("29");
  });

  it("reads two year digits as this century", () => {
    expect(settleDate({ ...EMPTY_DATE, year: "26" }, "year").year).toBe("2026");
  });

  it("leaves an empty segment alone", () => {
    expect(settleDate(EMPTY_DATE, "day")).toEqual(EMPTY_DATE);
  });
});
