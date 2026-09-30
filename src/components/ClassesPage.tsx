import { memo, useEffect, useMemo, useState } from "react";
import {
  Circle,
  CircleCheckBig,
  ClipboardPaste,
  GraduationCap,
  Plus,
  Target,
  Trash2,
  X,
} from "lucide-react";

import { AnnouncementsPanel } from "./AnnouncementsPanel";
import { ConfirmDialog } from "./ConfirmDialog";
import { GradesImportDialog } from "./GradesImportDialog";
import { useGrades } from "../hooks/useGrades";
import {
  createCourse,
  deleteCourse,
  deleteGradeItem,
  saveCourse,
  saveGradeCategories,
  updateGradeItem,
  upsertGradeItems,
} from "../lib/ipc";
import type { Course, GradeCategory, GradeItem, LmsTask } from "../lib/types";
import {
  currentGrade,
  DEFAULT_SCALE,
  gpa,
  letterFor,
  neededAverage,
} from "../services/grades";
import type { ImportedItem, ImportedWeight } from "../services/gradeImport";

interface Props {
  /** Open coursework from the feed. */
  tasks: LmsTask[];
  /** Coursework already ticked off — still this class's assignments. */
  completedTasks: LmsTask[];
  /** Marks a feed assignment done, or reopens it — the same switch as the sync column. */
  onToggleTask: (task: LmsTask) => unknown;
}

/** One row of the assignment table: a saved grade, a feed assignment, or both. */
interface Row {
  key: string;
  item: GradeItem | null;
  task: LmsTask | null;
  title: string;
}

const fmt = (value: number | null, digits = 1) =>
  value === null ? "–" : `${Math.round(value * 10 ** digits) / 10 ** digits}`;

/**
 * Classes: each course's assignments, grade, grading breakdown and notes, a GPA across
 * them, and the average still needed to reach a target.
 *
 * Invariant 46: nothing here is fetched on its own authority. Scores come from a pasted
 * Canvas Grades page or from typing, weights from a pasted syllabus or from typing, and
 * the arithmetic is Canvas's own so the number agrees with the page it came from.
 */
export const ClassesPage = memo(function ClassesPage({
  tasks,
  completedTasks,
  onToggleTask,
}: Props) {
  const grades = useGrades();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  /** What-if letters for the GPA. Not saved: a what-if is a question, not a record. */
  const [whatIf, setWhatIf] = useState<Record<number, string>>({});
  const [importing, setImporting] = useState<"grades" | "syllabus" | null>(null);
  const [addingCourse, setAddingCourse] = useState(false);
  const [newCourse, setNewCourse] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const allTasks = useMemo(() => [...tasks, ...completedTasks], [tasks, completedTasks]);

  // Keep a selection; fall back to the first class.
  useEffect(() => {
    if (grades.courses.length === 0) return;
    if (!grades.courses.some((course) => course.id === selectedId)) {
      setSelectedId(grades.courses[0].id);
    }
  }, [grades.courses, selectedId]);

  /** Each course's current grade, for the list and the GPA. */
  const summaries = useMemo(
    () =>
      new Map(
        grades.courses.map((course) => {
          const categories = grades.categories.filter((entry) => entry.courseId === course.id);
          const items = grades.items.filter((entry) => entry.courseId === course.id);
          const percent = currentGrade(categories, items);
          return [course.id, { percent, letter: percent === null ? null : letterFor(percent).letter }];
        }),
      ),
    [grades.courses, grades.categories, grades.items],
  );

  const termGpa = gpa(
    grades.courses.map((course) => ({
      credits: course.credits,
      letter: whatIf[course.id] ?? summaries.get(course.id)?.letter ?? null,
    })),
  );
  const countedCredits = grades.courses
    .filter((course) => (whatIf[course.id] ?? summaries.get(course.id)?.letter) != null)
    .reduce((sum, course) => sum + course.credits, 0);

  const course = grades.courses.find((entry) => entry.id === selectedId) ?? null;

  if (grades.loading) return null;

  return (
    <>
      {grades.error && (
        <p className="rounded-xl border border-bad/20 bg-bad/10 px-4 py-3 text-xs text-bad">
          {grades.error}
        </p>
      )}

      {/* GPA across every class that has a letter, real or what-if. */}
      <section className="shrink-0 rounded-2xl border border-edge bg-surface p-5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-mini font-semibold tracking-widest text-ink-soft uppercase">
            Term GPA
          </h2>
          <span className="text-mini text-ink-mute">
            Change a letter to see what it would do. Nothing is saved.
          </span>
        </div>
        <div className="mt-2 flex items-baseline gap-3">
          <span className="font-mono text-3xl font-semibold tabular-nums text-ink">
            {termGpa === null ? "–" : termGpa.toFixed(2)}
          </span>
          <span className="text-xs text-ink-mute">
            {countedCredits > 0 ? `over ${fmt(countedCredits)} credits` : "no graded classes yet"}
          </span>
        </div>
        {grades.courses.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-2">
            {grades.courses.map((entry) => {
              const actual = summaries.get(entry.id)?.letter ?? null;
              const shown = whatIf[entry.id] ?? actual ?? "";
              return (
                <li
                  key={entry.id}
                  className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
                    whatIf[entry.id] ? "border-rose-deep bg-rose-wash" : "border-edge"
                  }`}
                >
                  <span className="font-mono text-mini font-medium text-ink-soft">{entry.code}</span>
                  <select
                    value={shown}
                    onChange={(event) =>
                      setWhatIf((current) => {
                        const next = { ...current };
                        if (!event.target.value || event.target.value === actual) delete next[entry.id];
                        else next[entry.id] = event.target.value;
                        return next;
                      })
                    }
                    aria-label={`Letter for ${entry.code}`}
                    className="rounded border border-edge bg-canvas px-1 py-0.5 text-mini text-ink-soft outline-none"
                  >
                    <option value="">–</option>
                    {DEFAULT_SCALE.map((band) => (
                      <option key={band.letter} value={band.letter}>
                        {band.letter}
                      </option>
                    ))}
                  </select>
                  <NumberCell
                    value={entry.credits}
                    onCommit={(value) =>
                      value !== null &&
                      void grades.run(() => saveCourse({ ...entry, credits: value }))
                    }
                    label={`Credits for ${entry.code}`}
                    width="w-10"
                  />
                  <span className="text-mini text-ink-mute">cr</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="flex min-h-0 flex-1 gap-5">
        {/* The classes. */}
        <aside className="flex w-60 shrink-0 flex-col rounded-2xl border border-edge bg-surface p-3">
          <ul className="scroll-area min-h-0 flex-1 space-y-1.5">
            {grades.courses.map((entry) => {
              const summary = summaries.get(entry.id);
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(entry.id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition ${
                      entry.id === selectedId ? "bg-rose-wash" : "hover:bg-canvas"
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-ink">{entry.code}</span>
                      <span className="block truncate text-mini text-ink-mute">
                        {entry.name ?? `${fmt(entry.credits)} credits`}
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block font-mono text-xs font-semibold tabular-nums text-ink">
                        {summary?.letter ?? "–"}
                      </span>
                      <span className="block font-mono text-tiny tabular-nums text-ink-mute">
                        {summary?.percent == null ? "" : `${fmt(summary.percent)}%`}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {grades.courses.length === 0 && (
              <li className="px-2 py-6 text-center text-xs text-ink-mute">
                No classes yet. Add your Canvas calendar feed in Settings, or add one here.
              </li>
            )}
          </ul>

          {addingCourse ? (
            <div className="mt-2 flex items-center gap-1.5">
              <input
                autoFocus
                value={newCourse}
                onChange={(event) => setNewCourse(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && newCourse.trim()) {
                    void grades.run(() => createCourse(newCourse.trim(), null));
                    setNewCourse("");
                    setAddingCourse(false);
                  }
                  if (event.key === "Escape") setAddingCourse(false);
                }}
                placeholder="MATH 9A"
                className="min-w-0 flex-1 rounded-lg border border-edge bg-canvas px-2 py-1.5 text-xs text-ink outline-none select-text focus:border-edge-strong"
              />
              <button
                type="button"
                onClick={() => setAddingCourse(false)}
                aria-label="Cancel"
                className="text-ink-mute hover:text-ink"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAddingCourse(true)}
              className="mt-2 flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-edge py-1.5 text-mini text-ink-mute transition hover:border-edge-strong hover:text-ink-soft"
            >
              <Plus size={12} />
              Add a class
            </button>
          )}
        </aside>

        {course ? (
          <CourseDetail
            key={course.id}
            course={course}
            categories={grades.categories.filter((entry) => entry.courseId === course.id)}
            items={grades.items.filter((entry) => entry.courseId === course.id)}
            tasks={allTasks.filter((task) => task.courseCode === course.code)}
            run={grades.run}
            onToggleTask={onToggleTask}
            onImport={setImporting}
            onDelete={() => setConfirmDelete(true)}
          />
        ) : (
          <section className="flex flex-1 items-center justify-center rounded-2xl border border-edge bg-surface text-sm text-ink-mute">
            <GraduationCap size={16} className="mr-2" /> Pick a class
          </section>
        )}
      </div>

      {course && (
        <GradesImportDialog
          open={importing !== null}
          mode={importing ?? "grades"}
          courseCode={course.code}
          knownTitles={knownTitlesFor(allTasks, course.code)}
          onClose={() => setImporting(null)}
          onConfirm={(picked) =>
            applyImport(
              course,
              grades.categories.filter((entry) => entry.courseId === course.id),
              allTasks.filter((task) => task.courseCode === course.code),
              picked,
            ).then(() => grades.refresh())
          }
        />
      )}

      <ConfirmDialog
        open={confirmDelete && course !== null}
        title={`Remove ${course?.code ?? ""}?`}
        body="Its grading breakdown, every grade you pasted or typed, and its notes go with it. A class from your Canvas feed comes back empty the next time this page loads."
        confirmLabel="Remove it"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          if (course) void grades.run(() => deleteCourse(course.id));
        }}
      />
    </>
  );
});

/** Stable per course code, so the import dialog does not re-read on every render. */
const titleCache = new Map<string, { source: LmsTask[]; titles: string[] }>();
function knownTitlesFor(tasks: LmsTask[], code: string): string[] {
  const cached = titleCache.get(code);
  if (cached && cached.source === tasks) return cached.titles;
  const titles = tasks.filter((task) => task.courseCode === code).map((task) => task.title);
  titleCache.set(code, { source: tasks, titles });
  return titles;
}

/**
 * Writes what the import dialog confirmed: weights merged into the categories by name,
 * then the grades filed under them. A category an assignment names but the weights did not
 * is created at weight 0 — it exists, its share of the grade is not known yet.
 */
async function applyImport(
  course: Course,
  existing: GradeCategory[],
  tasks: LmsTask[],
  picked: { items: ImportedItem[]; weights: ImportedWeight[] },
) {
  const byName = new Map(existing.map((entry) => [entry.name.toLowerCase(), { ...entry }]));
  for (const weight of picked.weights) {
    const found = byName.get(weight.name.toLowerCase());
    if (found) found.weight = weight.weight;
    else
      byName.set(weight.name.toLowerCase(), {
        id: 0,
        courseId: course.id,
        name: weight.name,
        weight: weight.weight,
      });
  }
  for (const item of picked.items) {
    if (item.category && !byName.has(item.category.toLowerCase())) {
      byName.set(item.category.toLowerCase(), {
        id: 0,
        courseId: course.id,
        name: item.category,
        weight: 0,
      });
    }
  }

  const saved = await saveGradeCategories(course.id, [...byName.values()]);
  const ids = new Map(saved.map((entry) => [entry.name.toLowerCase(), entry.id]));
  const taskIds = new Map(tasks.map((task) => [task.title.toLowerCase(), task.id]));

  if (picked.items.length > 0) {
    await upsertGradeItems(
      course.id,
      picked.items.map((item) => ({
        id: 0,
        courseId: course.id,
        categoryId: item.category ? (ids.get(item.category.toLowerCase()) ?? null) : null,
        title: item.title,
        taskId: taskIds.get(item.title.toLowerCase()) ?? null,
        score: item.score,
        points: item.points,
        source: "paste",
      })),
    );
  }
}

interface DetailProps {
  course: Course;
  categories: GradeCategory[];
  items: GradeItem[];
  tasks: LmsTask[];
  run: (write: () => Promise<unknown>) => Promise<void>;
  onToggleTask: (task: LmsTask) => unknown;
  onImport: (mode: "grades" | "syllabus") => void;
  onDelete: () => void;
}

function CourseDetail({
  course,
  categories,
  items,
  tasks,
  run,
  onToggleTask,
  onImport,
  onDelete,
}: DetailProps) {
  const [notes, setNotes] = useState(course.notes ?? "");
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftWeight, setDraftWeight] = useState("");

  const percent = currentGrade(categories, items);
  const letter = percent === null ? null : letterFor(percent);
  const weightSum = categories.reduce((sum, entry) => sum + entry.weight, 0);
  /** What is left to give out. A class is worth 100% and no more. */
  const weightLeft = Math.max(0, Math.round((100 - weightSum) * 100) / 100);
  const draftNumber = Number(draftWeight);
  const draftValid =
    draftName.trim().length > 0 &&
    draftWeight.trim() !== "" &&
    Number.isFinite(draftNumber) &&
    draftNumber > 0 &&
    draftNumber <= weightLeft;

  const target = course.targetPercent;
  const needed = target === null ? null : neededAverage(categories, items, target);
  const remainingPoints = items
    .filter((item) => item.score === null && (item.points ?? 0) > 0)
    .reduce((sum, item) => sum + (item.points ?? 0), 0);

  /** Saved grades first, then feed assignments nothing has been entered for. */
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = items.map((item) => ({
      key: `item-${item.id}`,
      item,
      task: tasks.find((task) => task.id === item.taskId) ?? null,
      title: item.title,
    }));
    const covered = new Set(items.map((item) => item.title.toLowerCase()));
    const linked = new Set(items.map((item) => item.taskId).filter((id) => id !== null));
    for (const task of tasks) {
      if (linked.has(task.id) || covered.has(task.title.toLowerCase())) continue;
      out.push({ key: `task-${task.id}`, item: null, task, title: task.title });
    }
    return out.sort((left, right) => (left.task?.dueAt ?? Infinity) - (right.task?.dueAt ?? Infinity));
  }, [items, tasks]);

  const saveCategories = (next: GradeCategory[]) => run(() => saveGradeCategories(course.id, next));

  /** A feed assignment gets a grade row the first time anything is typed against it. */
  const writeRow = (row: Row, change: Partial<GradeItem>) => {
    if (row.item) return run(() => updateGradeItem({ ...row.item!, ...change }));
    return run(() =>
      upsertGradeItems(course.id, [
        {
          id: 0,
          courseId: course.id,
          categoryId: null,
          title: row.title,
          taskId: row.task?.id ?? null,
          score: null,
          points: null,
          source: "manual",
          ...change,
        },
      ]),
    );
  };

  return (
    <section className="scroll-area flex min-w-0 flex-1 flex-col gap-4 rounded-2xl border border-edge bg-surface p-6">
      {/* The class and its grade. */}
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-semibold text-ink">{course.code}</h2>
          <input
            key={`name-${course.id}`}
            defaultValue={course.name ?? ""}
            onBlur={(event) => {
              const name = event.target.value.trim() || null;
              if (name !== course.name) void run(() => saveCourse({ ...course, name }));
            }}
            placeholder="Add the class name"
            className="mt-0.5 w-full bg-transparent text-sm text-ink-soft outline-none select-text placeholder:text-ink-mute"
          />
        </div>
        <div className="text-right">
          <div className="font-mono text-3xl font-semibold tabular-nums text-ink">
            {letter?.letter ?? "–"}
          </div>
          <div className="font-mono text-xs tabular-nums text-ink-mute">
            {percent === null ? "nothing graded yet" : `${fmt(percent, 2)}%`}
          </div>
        </div>
        <button
          type="button"
          onClick={onDelete}
          title="Remove this class and its grades"
          aria-label={`Remove ${course.code}`}
          className="mt-1 shrink-0 text-ink-mute transition hover:text-bad"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <AnnouncementsPanel courseId={course.id} />

      {/* What it takes to reach a target. */}
      <div className="rounded-xl border border-edge bg-canvas p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Target size={14} className="text-rose-deep" />
          <span className="text-xs font-medium text-ink-soft">I want to finish with</span>
          <select
            value={
              target === null
                ? ""
                : (DEFAULT_SCALE.find((band) => band.min === target)?.letter ?? "custom")
            }
            onChange={(event) => {
              const band = DEFAULT_SCALE.find((entry) => entry.letter === event.target.value);
              const next = event.target.value === "" ? null : band ? band.min : (target ?? 90);
              void run(() => saveCourse({ ...course, targetPercent: next }));
            }}
            className="rounded-lg border border-edge bg-surface px-2 py-1 text-xs text-ink-soft outline-none"
          >
            <option value="">choose…</option>
            {DEFAULT_SCALE.filter((band) => band.letter !== "F").map((band) => (
              <option key={band.letter} value={band.letter}>
                {band.letter} ({band.min}%)
              </option>
            ))}
            <option value="custom">a percentage</option>
          </select>
          {target !== null && (
            <>
              <NumberCell
                value={target}
                onCommit={(value) =>
                  value !== null && void run(() => saveCourse({ ...course, targetPercent: value }))
                }
                label="Target percentage"
                width="w-14"
              />
              <span className="text-xs text-ink-mute">%</span>
            </>
          )}
        </div>
        {needed && (
          <p className="mt-2.5 text-sm text-ink">
            {needed.status === "reachable" && (
              <>
                You need <b className="font-mono">{fmt(needed.needed)}%</b> on average on
                everything left ({fmt(remainingPoints, 0)} points).
              </>
            )}
            {needed.status === "secured" && <>Secured — even zeros on what is left would still get there.</>}
            {needed.status === "impossible" && (
              <>
                Not reachable with what is left: it would take{" "}
                <b className="font-mono">{fmt(needed.needed)}%</b>.
              </>
            )}
            {needed.status === "unknown" && (
              <span className="text-ink-mute">
                Nothing left has points yet. Add the remaining work — or a placeholder like
                “Final exam, 100 points” — below.
              </span>
            )}
          </p>
        )}
      </div>

      {/* Grading breakdown: one full-width row per kind of assignment and its share. */}
      <div>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-mini font-semibold tracking-wider text-ink-soft uppercase">
            Grading breakdown
          </h3>
          {categories.length > 0 && (
            <span
              className={`font-mono text-mini tabular-nums ${
                Math.abs(weightSum - 100) > 0.5 ? "text-warn" : "text-ink-mute"
              }`}
            >
              {fmt(weightSum)}% of 100%
            </span>
          )}
        </div>

        <ul className="mt-2 space-y-1.5">
          {categories.map((category) => (
            <li
              key={category.id}
              className="flex items-center gap-2 rounded-lg border border-edge px-3 py-2 text-xs"
            >
              <input
                defaultValue={category.name}
                onBlur={(event) => {
                  const name = event.target.value.trim();
                  if (name && name !== category.name)
                    void saveCategories(
                      categories.map((entry) => (entry.id === category.id ? { ...entry, name } : entry)),
                    );
                }}
                aria-label="Type of assignment"
                className="min-w-0 flex-1 bg-transparent text-ink outline-none select-text"
              />
              <NumberCell
                value={category.weight}
                onCommit={(value) => {
                  // The others' share is fixed; this one can take what they leave.
                  const room = 100 - (weightSum - category.weight);
                  const weight = Math.min(value ?? 0, Math.max(0, room));
                  void saveCategories(
                    categories.map((entry) =>
                      entry.id === category.id ? { ...entry, weight } : entry,
                    ),
                  );
                }}
                label={`Weight of ${category.name}`}
                width="w-14"
              />
              <span className="text-mini text-ink-mute">%</span>
              <button
                type="button"
                onClick={() => void saveCategories(categories.filter((entry) => entry.id !== category.id))}
                title="Remove the category — its grades stay, uncategorised"
                aria-label={`Remove ${category.name}`}
                className="text-ink-mute transition hover:text-bad"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>

        {adding ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!draftValid) return;
              void saveCategories([
                ...categories,
                { id: 0, courseId: course.id, name: draftName.trim(), weight: draftNumber },
              ]);
              setDraftName("");
              setDraftWeight("");
              setAdding(false);
            }}
            className="mt-1.5 flex items-center gap-2 rounded-lg border border-edge-strong bg-canvas px-3 py-2 text-xs"
          >
            <input
              autoFocus
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => event.key === "Escape" && setAdding(false)}
              placeholder="Type of assignment — Homework, Quizzes, Final exam"
              aria-label="Type of assignment"
              className="min-w-0 flex-1 bg-transparent text-ink outline-none select-text placeholder:text-ink-mute"
            />
            <input
              value={draftWeight}
              onChange={(event) => setDraftWeight(event.target.value)}
              onKeyDown={(event) => event.key === "Escape" && setAdding(false)}
              inputMode="decimal"
              placeholder={String(Math.min(20, weightLeft))}
              aria-label={`Weight in percent, up to ${weightLeft}`}
              title={`Up to ${weightLeft}% is left`}
              className="w-14 rounded border border-edge bg-surface px-1.5 py-0.5 text-right font-mono tabular-nums text-ink outline-none select-text focus:border-edge-strong"
            />
            <span className="text-mini text-ink-mute">%</span>
            <button
              type="submit"
              disabled={!draftValid}
              className="rounded-lg bg-rose px-2.5 py-1 text-mini font-semibold text-white transition hover:bg-rose-deep disabled:opacity-40"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              aria-label="Cancel"
              className="text-ink-mute transition hover:text-ink"
            >
              <X size={12} />
            </button>
          </form>
        ) : weightLeft <= 0 ? (
          <p className="mt-1.5 rounded-lg border border-dashed border-edge py-2 text-center text-mini text-ink-mute">
            All 100% is given out. Lower a weight or remove a category to add another.
          </p>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-edge py-2 text-mini text-ink-mute transition hover:border-edge-strong hover:text-ink-soft"
          >
            <Plus size={12} />
            Add a category
            {categories.length > 0 && <span className="text-ink-mute">· {weightLeft}% left</span>}
          </button>
        )}
      </div>

      {/* Assignments. */}
      <div>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-mini font-semibold tracking-wider text-ink-soft uppercase">
            Assignments
          </h3>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onImport("grades")}
              className="flex items-center gap-1 rounded-lg bg-rose-wash px-2.5 py-1 text-mini font-medium text-rose-deep transition hover:bg-edge-strong"
            >
              <ClipboardPaste size={11} /> Paste grades from Canvas…
            </button>
            <button
              type="button"
              onClick={() =>
                void run(() =>
                  upsertGradeItems(course.id, [
                    {
                      id: 0,
                      courseId: course.id,
                      categoryId: null,
                      title: uniqueTitle(items, "New item"),
                      taskId: null,
                      score: null,
                      points: 100,
                      source: "manual",
                    },
                  ]),
                )
              }
              className="flex items-center gap-1 text-mini text-ink-mute transition hover:text-ink-soft"
            >
              <Plus size={11} /> Add item
            </button>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-ink-mute">
            No assignments yet. Paste this class's Canvas Grades page, or add items by hand.
          </p>
        ) : (
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="text-left text-tiny font-semibold tracking-wider text-ink-mute uppercase">
                <th className="w-6 py-1" aria-label="Done" />
                <th className="py-1 font-semibold">Name</th>
                <th className="w-56 py-1 font-semibold">Category</th>
                <th className="py-1 text-right font-semibold">Score</th>
                <th className="w-6" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-edge/60">
                  <td className="w-6 py-1.5 align-top">
                    <DoneMark row={row} onToggleTask={onToggleTask} />
                  </td>
                  <td className="max-w-0 py-1.5 pr-2">
                    {row.item ? (
                      <input
                        defaultValue={row.item.title}
                        onBlur={(event) => {
                          const title = event.target.value.trim();
                          if (title && title !== row.item!.title) void writeRow(row, { title });
                        }}
                        aria-label="Assignment name"
                        className="w-full truncate bg-transparent text-ink outline-none select-text"
                      />
                    ) : (
                      <span className="block truncate text-ink-soft">{row.title}</span>
                    )}
                    {row.task?.dueAt != null && (
                      <span className="block text-tiny text-ink-mute">
                        due{" "}
                        {new Date(row.task.dueAt * 1000).toLocaleDateString([], {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    )}
                  </td>
                  <td className="w-56 py-1.5 pr-3">
                    <select
                      value={row.item?.categoryId ?? ""}
                      onChange={(event) =>
                        void writeRow(row, {
                          categoryId: event.target.value === "" ? null : Number(event.target.value),
                        })
                      }
                      aria-label="Category"
                      className="w-full truncate rounded-md border border-edge bg-canvas px-2 py-1 text-xs text-ink-soft outline-none focus:border-edge-strong"
                    >
                      <option value="">–</option>
                      {categories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-1.5 text-right whitespace-nowrap">
                    <NumberCell
                      value={row.item?.score ?? null}
                      onCommit={(score) => void writeRow(row, { score })}
                      label="Score"
                      width="w-12"
                      placeholder="–"
                    />
                    <span className="mx-1 text-ink-mute">/</span>
                    <NumberCell
                      value={row.item?.points ?? null}
                      onCommit={(points) => void writeRow(row, { points })}
                      label="Out of"
                      width="w-12"
                      placeholder="pts"
                    />
                  </td>
                  <td className="py-1.5 text-right">
                    {row.item && (
                      <button
                        type="button"
                        onClick={() => void run(() => deleteGradeItem(row.item!.id))}
                        title={row.task ? "Clear the grade — the assignment stays" : "Delete this item"}
                        aria-label={`Remove ${row.title}`}
                        className="text-ink-mute transition hover:text-bad"
                      >
                        <X size={11} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Anything worth remembering about the class. */}
      <div>
        <h3 className="text-mini font-semibold tracking-wider text-ink-soft uppercase">Notes</h3>
        <textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          onBlur={() => {
            const next = notes.trim() ? notes : null;
            if (next !== course.notes) void run(() => saveCourse({ ...course, notes: next }));
          }}
          rows={4}
          placeholder="Exam dates, the drop policy, late work, office hours…"
          className="scroll-area mt-2 w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-xs text-ink-soft outline-none transition select-text focus:border-edge-strong"
        />
      </div>
    </section>
  );
}

/**
 * Whether an assignment is finished. Done is what you ticked — here or in the sync column,
 * it is the same switch — and a grade counts too: work that has been marked was handed in.
 * Only a feed assignment can be ticked; a typed item is done when it has a score.
 */
function DoneMark({
  row,
  onToggleTask,
}: {
  row: Row;
  onToggleTask: (task: LmsTask) => unknown;
}) {
  const ticked = row.task?.completed === true;
  const graded = row.item?.score != null;
  const done = ticked || graded;

  const mark = done ? (
    <CircleCheckBig size={14} className="text-ok" />
  ) : (
    <Circle size={14} className="text-ink-mute" />
  );

  if (!row.task) {
    return (
      <span title={graded ? "Graded" : "Not graded yet"} className="mt-0.5 inline-flex">
        {mark}
      </span>
    );
  }
  const task = row.task;
  return (
    <button
      type="button"
      onClick={() => onToggleTask(task)}
      title={
        ticked
          ? "Done — click to reopen"
          : graded
            ? "Graded — click to mark done as well"
            : "Not done — click to mark done"
      }
      aria-label={ticked ? `Reopen ${row.title}` : `Mark ${row.title} done`}
      aria-pressed={ticked}
      className="mt-0.5 inline-flex transition hover:opacity-70"
    >
      {mark}
    </button>
  );
}

function uniqueTitle(items: GradeItem[], base: string): string {
  const taken = new Set(items.map((item) => item.title.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let count = 2; ; count += 1) {
    const candidate = `${base} ${count}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * A number typed in place, committed on blur or Enter. Empty commits null — "not graded"
 * is a real value, not the absence of one.
 */
function NumberCell({
  value,
  onCommit,
  label,
  width,
  placeholder,
}: {
  value: number | null;
  onCommit: (value: number | null) => void;
  label: string;
  width: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => setText(value === null ? "" : String(value)), [value]);

  const commit = () => {
    const trimmed = text.trim();
    const next = trimmed === "" ? null : Number(trimmed);
    if (next !== null && (!Number.isFinite(next) || next < 0)) {
      setText(value === null ? "" : String(value));
      return;
    }
    if (next !== value) onCommit(next);
  };

  return (
    <input
      value={text}
      inputMode="decimal"
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
      aria-label={label}
      placeholder={placeholder}
      className={`${width} rounded border border-transparent bg-transparent px-1 py-0.5 text-right font-mono tabular-nums text-ink outline-none select-text hover:border-edge focus:border-edge-strong focus:bg-surface`}
    />
  );
}
