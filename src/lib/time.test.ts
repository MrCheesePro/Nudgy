import { describe, expect, it } from "vitest";

import { parseTimeOfDay } from "./time";

describe("parseTimeOfDay", () => {
  it("reads 12-hour times with a suffix", () => {
    expect(parseTimeOfDay("2pm")).toBe(14 * 60);
    expect(parseTimeOfDay("2 PM")).toBe(14 * 60);
    expect(parseTimeOfDay("2:30pm")).toBe(14 * 60 + 30);
    expect(parseTimeOfDay("12am")).toBe(0);
    expect(parseTimeOfDay("12pm")).toBe(12 * 60);
  });

  it("reads 24-hour times", () => {
    expect(parseTimeOfDay("14:30")).toBe(14 * 60 + 30);
    expect(parseTimeOfDay("1430")).toBe(14 * 60 + 30);
    expect(parseTimeOfDay("9")).toBe(9 * 60);
    expect(parseTimeOfDay("09:05")).toBe(9 * 60 + 5);
  });

  it("accepts a dot as a separator", () => {
    expect(parseTimeOfDay("2.30pm")).toBe(14 * 60 + 30);
  });

  it("rejects nonsense rather than guessing", () => {
    expect(parseTimeOfDay("")).toBeNull();
    expect(parseTimeOfDay("25:00")).toBeNull();
    expect(parseTimeOfDay("2:75")).toBeNull();
    expect(parseTimeOfDay("13pm")).toBeNull();
    expect(parseTimeOfDay("lunchtime")).toBeNull();
  });
});
