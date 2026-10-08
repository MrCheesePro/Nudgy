/**
 * Grades: what the pasted and typed numbers add up to.
 *
 * The arithmetic is Canvas's own, so the page agrees with the one it was pasted from: a
 * weighted course takes each category's percentage, weights them, and **renormalises over
 * the categories that have anything graded yet** — a class with only homework back is
 * graded on homework, not on homework plus a zero for the final nobody has sat. A course
 * with no weights is total points.
 */

export interface CategoryInput {
  id: number;
  name: string;
  /** Percent of the final grade. */
  weight: number;
}

export interface ItemInput {
  categoryId: number | null;
  /** Null until it is graded. */
  score: number | null;
  points: number | null;
}

export interface Letter {
  letter: string;
  /** Lowest percentage that earns it. */
  min: number;
  points: number;
}

/** The common US scale. A+ reads as an A for GPA, as most schools count it. */
export const DEFAULT_SCALE: Letter[] = [
  { letter: "A", min: 93, points: 4.0 },
  { letter: "A-", min: 90, points: 3.7 },
  { letter: "B+", min: 87, points: 3.3 },
  { letter: "B", min: 83, points: 3.0 },
  { letter: "B-", min: 80, points: 2.7 },
  { letter: "C+", min: 77, points: 2.3 },
  { letter: "C", min: 73, points: 2.0 },
  { letter: "C-", min: 70, points: 1.7 },
  { letter: "D+", min: 67, points: 1.3 },
  { letter: "D", min: 63, points: 1.0 },
  { letter: "D-", min: 60, points: 0.7 },
  { letter: "F", min: 0, points: 0 },
];

const graded = (item: ItemInput) =>
  item.score !== null && item.points !== null && item.points > 0;
const remaining = (item: ItemInput) =>
  item.score === null && item.points !== null && item.points > 0;

/** Weights count only when they add up to something — all zeros means "not weighted". */
function weighted(categories: CategoryInput[]): boolean {
  return categories.some((category) => category.weight > 0);
}

/** Earned and possible points over graded work, or null when none is graded. */
export function categoryPercent(items: ItemInput[]): number | null {
  const done = items.filter(graded);
  const possible = done.reduce((sum, item) => sum + (item.points ?? 0), 0);
  if (possible === 0) return null;
  const earned = done.reduce((sum, item) => sum + (item.score ?? 0), 0);
  return (earned / possible) * 100;
}

/** The course grade as Canvas shows it, or null when nothing has been graded. */
export function currentGrade(categories: CategoryInput[], items: ItemInput[]): number | null {
  if (!weighted(categories)) return categoryPercent(items);

  let total = 0;
  let weightUsed = 0;
  for (const category of categories) {
    if (category.weight <= 0) continue;
    const percent = categoryPercent(items.filter((item) => item.categoryId === category.id));
    if (percent === null) continue;
    total += percent * category.weight;
    weightUsed += category.weight;
  }
  return weightUsed === 0 ? null : total / weightUsed;
}

export function letterFor(percent: number, scale: Letter[] = DEFAULT_SCALE): Letter {
  return scale.find((entry) => percent >= entry.min) ?? scale[scale.length - 1];
}

export function pointsFor(letter: string, scale: Letter[] = DEFAULT_SCALE): number | null {
  const normalised = letter.trim().toUpperCase() === "A+" ? "A" : letter.trim().toUpperCase();
  return scale.find((entry) => entry.letter === normalised)?.points ?? null;
}

/** Credit-weighted GPA over the courses that have a letter. Null when none does. */
export function gpa(courses: { credits: number; letter: string | null }[]): number | null {
  let quality = 0;
  let credits = 0;
  for (const course of courses) {
    if (course.letter === null || course.credits <= 0) continue;
    const points = pointsFor(course.letter);
    if (points === null) continue;
    quality += points * course.credits;
    credits += course.credits;
  }
  return credits === 0 ? null : quality / credits;
}

export type NeededStatus = "reachable" | "secured" | "impossible" | "unknown";

export interface Needed {
  /** The average needed on everything not yet graded, in percent. */
  needed: number | null;
  status: NeededStatus;
}

/**
 * The average needed on every remaining item to finish at `target` percent.
 *
 * Each category ends at (earned + x·left) / (graded + left), so the final grade is a
 * straight line in x and x can be solved for directly: final(x) = base + slope·x. A weighted
 * course renormalises over the categories that will have *anything* in them by the end —
 * graded or remaining — which is what the final grade will be computed over.
 */
/**
 * A linked class (a lab section) as one entry in its parent's category: its own weighted
 * percentage, out of 100. Nothing graded yet is 100 points still to earn.
 *
 * ponytail: a partly graded lab counts as finished at its current percentage, so the
 * parent's needed-average ignores what is left in the lab. Fold the lab's remaining
 * points in proportionally if that ever matters.
 */
export function linkedItem(percent: number | null, categoryId: number): ItemInput {
  return { categoryId, score: percent, points: 100 };
}

export function neededAverage(
  categories: CategoryInput[],
  items: ItemInput[],
  target: number,
): Needed {
  let base = 0;
  let slope = 0;

  if (!weighted(categories)) {
    const done = items.filter(graded);
    const left = items.filter(remaining);
    const earned = done.reduce((sum, item) => sum + (item.score ?? 0), 0);
    const doneTotal = done.reduce((sum, item) => sum + (item.points ?? 0), 0);
    const leftTotal = left.reduce((sum, item) => sum + (item.points ?? 0), 0);
    const all = doneTotal + leftTotal;
    if (all === 0) return { needed: null, status: "unknown" };
    base = (earned / all) * 100;
    slope = leftTotal / all;
  } else {
    let weightUsed = 0;
    for (const category of categories) {
      if (category.weight <= 0) continue;
      const own = items.filter((item) => item.categoryId === category.id);
      const done = own.filter(graded);
      const left = own.filter(remaining);
      const earned = done.reduce((sum, item) => sum + (item.score ?? 0), 0);
      const doneTotal = done.reduce((sum, item) => sum + (item.points ?? 0), 0);
      const leftTotal = left.reduce((sum, item) => sum + (item.points ?? 0), 0);
      const all = doneTotal + leftTotal;
      if (all === 0) continue;
      base += (earned / all) * 100 * category.weight;
      slope += (leftTotal / all) * category.weight;
      weightUsed += category.weight;
    }
    if (weightUsed === 0) return { needed: null, status: "unknown" };
    base /= weightUsed;
    slope /= weightUsed;
  }

  // Nothing left to earn points on: the grade is what it is.
  if (slope === 0) {
    return base >= target
      ? { needed: 0, status: "secured" }
      : { needed: null, status: "unknown" };
  }

  const needed = (target - base) / slope;
  if (needed <= 0) return { needed: 0, status: "secured" };
  if (needed > 100) return { needed, status: "impossible" };
  return { needed, status: "reachable" };
}
