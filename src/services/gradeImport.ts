/**
 * Reading grades and weights out of text somebody pasted.
 *
 * Nothing here is trusted — invariant 46. Both readers **propose**: the dialog shows
 * every row with a checkbox and writes only the ones confirmed. They are pattern matching,
 * not understanding, so they will miss unusual layouts; the preview and hand-editing are
 * what make that survivable.
 */

export interface ImportedItem {
  title: string;
  /** The Canvas assignment group, when the paste named one. */
  category: string | null;
  /** Null for work not graded yet. */
  score: number | null;
  points: number;
}

export interface ImportedWeight {
  name: string;
  weight: number;
}

export interface GradesPage {
  items: ImportedItem[];
  weights: ImportedWeight[];
}

const NUMBER = String.raw`\d+(?:\.\d+)?`;
/** `9 / 10`, `9/10`, `- / 10`, `– /10`, `9 out of 10`. */
const SCORE_PAIR = new RegExp(String.raw`^(${NUMBER}|[-–—])\s*(?:/|out of)\s*(${NUMBER})$`, "i");
/** The second half on its own line: `/ 10`, `out of 10`. */
const SCORE_TAIL = new RegExp(String.raw`^(?:/|out of)\s*(${NUMBER})$`, "i");
const SCORE_HEAD = new RegExp(String.raw`^(${NUMBER}|[-–—])$`);
const PERCENT_CELL = new RegExp(String.raw`^(${NUMBER})\s*%$`);
const NAME_AND_PERCENT = new RegExp(String.raw`^(.+?)\s+(${NUMBER})\s*%$`);

const MONTH = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d/i;
const CLOCK = /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i;
/** Status and header words the grades table puts in cells of their own. */
const NOISE = new Set(
  [
    "name",
    "due",
    "submitted",
    "status",
    "score",
    "out of",
    "details",
    "late",
    "missing",
    "excused",
    "graded",
    "not submitted",
    "submitted late",
    "no due date",
    "total",
    "assignments",
    "grades",
    "what-if score",
    "click to test a different score",
  ].map((word) => word.toLowerCase()),
);

/** Excused work does not count, in Canvas or here. */
const EXCUSED = /^(ex|excused)$/i;

function tokens(text: string): string[] {
  return text
    .split(/\r?\n/)
    .flatMap((line) => line.split("\t"))
    .map((cell) => cell.replace(/\s+/g, " ").trim())
    .filter((cell) => cell.length > 0);
}

function titleish(token: string, groups: Set<string>): boolean {
  const lower = token.toLowerCase();
  if (NOISE.has(lower) || groups.has(lower)) return false;
  if (MONTH.test(token) || CLOCK.test(token)) return false;
  if (/^[\d.,\s/%()–—-]+$/.test(token)) return false;
  if (PERCENT_CELL.test(token)) return false;
  return token.length >= 2;
}

/**
 * Reads a copied Canvas Grades page (`…/courses/N/grades`, select all, copy).
 *
 * `knownTitles` are the course's assignment names from the feed. A row is anchored on one
 * of those whenever it can be, because "which line is the name" is the part a layout
 * change breaks, and an exact name match does not care about layout.
 */
export function readGradesPage(text: string, knownTitles: string[] = []): GradesPage {
  const cells = tokens(text);
  const weights = readWeightTable(cells);
  const groups = new Set(weights.map((entry) => entry.name.toLowerCase()));
  const known = new Map(knownTitles.map((title) => [title.toLowerCase(), title]));

  const items = new Map<string, ImportedItem>();
  let lastAnchor = -1;

  for (let index = 0; index < cells.length; index += 1) {
    let score: number | null | undefined;
    let points: number | undefined;
    let end = index;

    const pair = SCORE_PAIR.exec(cells[index]);
    if (pair) {
      score = /^[-–—]$/.test(pair[1]) ? null : Number(pair[1]);
      points = Number(pair[2]);
    } else if (SCORE_HEAD.test(cells[index]) && index + 1 < cells.length) {
      const tail = SCORE_TAIL.exec(cells[index + 1]);
      if (tail) {
        score = /^[-–—]$/.test(cells[index]) ? null : Number(cells[index]);
        points = Number(tail[1]);
        end = index + 1;
      }
    }
    if (score === undefined || points === undefined || points <= 0) continue;

    // The row runs from just after the previous score to this one.
    const row = cells.slice(lastAnchor + 1, index);
    lastAnchor = end;
    index = end;

    // A group-total row ("Homework  92%  46 / 50") names a group and carries a percentage.
    if (row.some((cell) => PERCENT_CELL.test(cell))) continue;
    if (row.some((cell) => EXCUSED.test(cell))) continue;

    let titleAt = -1;
    for (let at = row.length - 1; at >= 0; at -= 1) {
      if (known.has(row[at].toLowerCase())) {
        titleAt = at;
        break;
      }
    }
    if (titleAt < 0) {
      // No feed match: the first cell in the row that reads like a name. Canvas puts the
      // name first and its group directly under it.
      titleAt = row.findIndex((cell) => titleish(cell, groups));
    }
    if (titleAt < 0) continue;

    const rawTitle = row[titleAt];
    if (groups.has(rawTitle.toLowerCase()) || rawTitle.toLowerCase() === "total") continue;
    const title = known.get(rawTitle.toLowerCase()) ?? rawTitle;

    const after = row.slice(titleAt + 1);
    const category =
      after.find((cell) => groups.has(cell.toLowerCase())) ??
      (groups.size === 0 && after.length > 0 && titleish(after[0], groups) ? after[0] : null);

    items.set(title.toLowerCase(), { title, category, score, points });
  }

  return { items: [...items.values()], weights };
}

/** The "Assignments are weighted by group" table in the Grades page sidebar. */
function readWeightTable(cells: string[]): ImportedWeight[] {
  const start = cells.findIndex((cell) => /weighted by group/i.test(cell));
  if (start < 0) return [];

  const weights: ImportedWeight[] = [];
  for (let index = start + 1; index < cells.length; index += 1) {
    const cell = cells[index];
    if (/^total\b/i.test(cell)) break;
    if (/^(group|weight)$/i.test(cell)) continue;

    const inline = NAME_AND_PERCENT.exec(cell);
    if (inline) {
      weights.push({ name: inline[1].trim(), weight: Number(inline[2]) });
      continue;
    }
    const next = cells[index + 1];
    const percent = next ? PERCENT_CELL.exec(next) : null;
    if (percent) {
      weights.push({ name: cell, weight: Number(percent[1]) });
      index += 1;
      continue;
    }
    // Anything else ends the table.
    if (weights.length > 0) break;
  }
  return weights;
}

export interface SyllabusWeights {
  weights: ImportedWeight[];
  /** Set when the weights found do not add up to 100. */
  warning: string | null;
}

/** A letter-scale line — `A 93–100%`, `B+: 87 - 89.9 %` — is a cutoff, not a weight. */
const RANGE = new RegExp(String.raw`${NUMBER}\s*[-–—]\s*${NUMBER}\s*%`);
const LETTER_START = /^[A-F][+\-−]?(\s|:|$)/;

/**
 * Category weights out of a syllabus: one name and one percentage per line.
 *
 * `Homework 20%`, `Midterm Exam (25%)`, `Final — 30 %`, `20% Participation`. A line with a
 * range or that starts with a letter grade is part of the grading scale and is skipped.
 */
export function readWeights(text: string): SyllabusWeights {
  const found = new Map<string, ImportedWeight>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || RANGE.test(line)) continue;

    const matches = [...line.matchAll(new RegExp(String.raw`(${NUMBER})\s*%`, "g"))];
    if (matches.length !== 1) continue;
    const match = matches[0];
    const weight = Number(match[1]);
    if (weight <= 0 || weight > 100) continue;

    const before = line.slice(0, match.index);
    const after = line.slice((match.index ?? 0) + match[0].length);
    let name = clean(before) || clean(after);
    if (!name) continue;
    if (LETTER_START.test(name)) continue;
    if (/^(total|grade|grading|course grade)$/i.test(name)) continue;
    // A sentence that happens to contain a percentage is not a weight.
    if (name.split(" ").length > 8 || name.length > 60) continue;
    name = name.charAt(0).toUpperCase() + name.slice(1);

    found.set(name.toLowerCase(), { name, weight });
  }

  const weights = [...found.values()];
  const sum = weights.reduce((total, entry) => total + entry.weight, 0);
  const warning =
    weights.length > 0 && Math.abs(sum - 100) > 0.5
      ? `These add up to ${Math.round(sum * 10) / 10}%, not 100%. Check for a missing or doubled line.`
      : null;
  return { weights, warning };
}

/** Strips bullets, numbering, dot leaders, brackets and separators from a name. */
function clean(part: string): string {
  return part
    .replace(/^[\s•*\-–—·\d.)]+(?=[A-Za-z])/, "")
    .replace(/[\s.:=–—\-(|,]+$/, "")
    .replace(/^[\s)|:,–—-]+/, "")
    .replace(/\s*\($/, "")
    .trim();
}
