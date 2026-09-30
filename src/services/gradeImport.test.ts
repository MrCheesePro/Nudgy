import { describe, expect, it } from "vitest";

import { readGradesPage, readWeights } from "./gradeImport";

/** Roughly what select-all, copy gives on a Canvas student Grades page. */
const GRADES_PAGE = `Grades for Sam Student
Course
CS 100 - Software Construction
Arrange By
Due Date
Name\tDue\tSubmitted\tStatus\tScore
Lab 1
Labs
Sep 30 by 11:59pm\tSep 29 at 4:02pm\t\t9 / 10
Lab 2
Labs
Oct 7 by 11:59pm\tOct 7 at 11:50pm\tlate\t7.5 / 10
Midterm
Exams
Oct 20 by 2pm\t\t\t- / 100
Participation week 1
Participation
Oct 1 by 11:59pm\t\t\tEX / 5
Labs
90.5%\t16.50 / 20.00
Exams
N/A\t0.00 / 0.00
Total\t82.5%\t16.50 / 20.00
Assignments are weighted by group:
Group\tWeight
Labs\t30%
Exams\t60%
Participation\t10%
Total\t100%`;

describe("readGradesPage", () => {
  const page = readGradesPage(GRADES_PAGE, ["Lab 1", "Lab 2", "Midterm"]);

  it("reads the weight table", () => {
    expect(page.weights).toEqual([
      { name: "Labs", weight: 30 },
      { name: "Exams", weight: 60 },
      { name: "Participation", weight: 10 },
    ]);
  });

  it("reads graded and ungraded rows with their groups", () => {
    expect(page.items).toEqual([
      { title: "Lab 1", category: "Labs", score: 9, points: 10 },
      { title: "Lab 2", category: "Labs", score: 7.5, points: 10 },
      { title: "Midterm", category: "Exams", score: null, points: 100 },
    ]);
  });

  it("skips group totals and the grand total", () => {
    expect(page.items.some((entry) => entry.title === "Labs" || entry.title === "Total")).toBe(
      false,
    );
  });

  it("reads a score split over two cells, without known titles", () => {
    const split = readGradesPage(`Essay draft\nWriting\n18\n/ 20`);
    expect(split.items).toEqual([
      { title: "Essay draft", category: "Writing", score: 18, points: 20 },
    ]);
  });
});

describe("readWeights", () => {
  it("reads the common layouts", () => {
    const { weights, warning } = readWeights(`Grading
• Homework ............ 20%
Midterm Exam (25%)
Final — 30 %
25% Participation`);
    expect(weights).toEqual([
      { name: "Homework", weight: 20 },
      { name: "Midterm Exam", weight: 25 },
      { name: "Final", weight: 30 },
      { name: "Participation", weight: 25 },
    ]);
    expect(warning).toBeNull();
  });

  it("skips the letter scale", () => {
    const { weights } = readWeights(`A 93–100%\nB+: 87 - 89.9 %\nA- 90%\nQuizzes 15%`);
    expect(weights).toEqual([{ name: "Quizzes", weight: 15 }]);
  });

  it("warns when the weights do not add up", () => {
    expect(readWeights(`Labs 30%\nExams 60%`).warning).toContain("90%");
  });
});
