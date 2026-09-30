import { describe, expect, it } from "vitest";

import {
  categoryPercent,
  currentGrade,
  gpa,
  letterFor,
  neededAverage,
  type CategoryInput,
  type ItemInput,
} from "./grades";

const item = (categoryId: number | null, score: number | null, points: number): ItemInput => ({
  categoryId,
  score,
  points,
});

const weighted: CategoryInput[] = [
  { id: 1, name: "Homework", weight: 40 },
  { id: 2, name: "Exams", weight: 60 },
];

describe("currentGrade", () => {
  it("is total points when nothing is weighted", () => {
    expect(currentGrade([], [item(null, 18, 20), item(null, 7, 10)])).toBeCloseTo((25 / 30) * 100);
  });

  it("weights categories", () => {
    const items = [item(1, 9, 10), item(2, 70, 100)];
    expect(currentGrade(weighted, items)).toBeCloseTo(90 * 0.4 + 70 * 0.6);
  });

  it("renormalises over categories that have anything graded", () => {
    // Only homework is back: the grade is the homework, not homework plus a zero.
    expect(currentGrade(weighted, [item(1, 8, 10), item(2, null, 100)])).toBeCloseTo(80);
  });

  it("is null before anything is graded", () => {
    expect(currentGrade(weighted, [item(1, null, 10)])).toBeNull();
    expect(categoryPercent([])).toBeNull();
  });
});

describe("letterFor", () => {
  it("takes the highest band the percentage reaches", () => {
    expect(letterFor(93).letter).toBe("A");
    expect(letterFor(92.99).letter).toBe("A-");
    expect(letterFor(59.9).letter).toBe("F");
  });
});

describe("gpa", () => {
  it("weights by credits and skips courses without a letter", () => {
    expect(
      gpa([
        { credits: 4, letter: "A" },
        { credits: 2, letter: "B" },
        { credits: 4, letter: null },
      ]),
    ).toBeCloseTo((4 * 4 + 3 * 2) / 6);
  });

  it("counts A+ as an A and is null with nothing to count", () => {
    expect(gpa([{ credits: 3, letter: "A+" }])).toBe(4);
    expect(gpa([])).toBeNull();
  });
});

describe("neededAverage", () => {
  it("solves for the average on what is left", () => {
    // 45/50 done, 50 left: 90% overall needs (90 - 45) / 50 = 90% on the rest.
    const result = neededAverage([], [item(null, 45, 50), item(null, null, 50)], 90);
    expect(result.status).toBe("reachable");
    expect(result.needed).toBeCloseTo(90);
  });

  it("works across weighted categories", () => {
    // Homework 40%: 10/10 done. Exams 60%: nothing done, 100 left.
    // final = 0.4·100 + 0.6·x ≥ 90  →  x ≥ 83.33
    const result = neededAverage(weighted, [item(1, 10, 10), item(2, null, 100)], 90);
    expect(result.needed).toBeCloseTo(83.333, 2);
  });

  it("says secured when zero on the rest still makes it", () => {
    expect(neededAverage([], [item(null, 95, 100), item(null, null, 5)], 90).status).toBe(
      "secured",
    );
  });

  it("says impossible past a hundred percent", () => {
    expect(neededAverage([], [item(null, 10, 100), item(null, null, 10)], 90).status).toBe(
      "impossible",
    );
  });

  it("says unknown when nothing left has points", () => {
    expect(neededAverage([], [item(null, 50, 100)], 90).status).toBe("unknown");
    expect(neededAverage([], [], 90).status).toBe("unknown");
  });
});
