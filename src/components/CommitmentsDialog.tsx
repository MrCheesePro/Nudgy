import { useCallback, useEffect, useState } from "react";
import { Archive, Check, Flame, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";

import { ConfirmDialog } from "./ConfirmDialog";
import { categoryColor, useAssignableCategories } from "../lib/categories";
import type { CategoryTarget } from "../lib/types";
import { formatDuration } from "../lib/time";
import type { Commitment } from "../services/commitments";
import type { Habit } from "../services/habits";
import { resolveTargetCategory, streakHeat, type StreakState } from "../services/progress";

interface Props {
  open: boolean;
  onClose: () => void;
  /** The row the dialog was opened on, loaded straight into the form. */
  initial?: Commitment | null;
  /** Every habit, archived ones included — this is where they are brought back. */
  habits: Habit[];
  targets: CategoryTarget[];
  streaks: Record<string, StreakState>;
  onAddHabit: (name: string, weekdays: number[]) => Promise<void>;
  onEditHabit: (id: number, name: string, weekdays: number[]) => Promise<void>;
  onArchiveHabit: (id: number, archived: boolean) => Promise<void>;
  onDeleteHabit: (id: number) => Promise<void>;
  onSaveTarget: (
    category: string,
    direction: "at_least" | "at_most",
    secondsPerDay: number,
  ) => Promise<void>;
  onRemoveTarget: (category: string) => Promise<void>;
}

const DAYS = ["S", "M", "T", "W", "T", "F", "S"];

type Kind = "declared" | "measured";

/**
 * Adding, editing and putting commitments away — both kinds, one dialog.
 *
 * The **kind toggle** at the top is the only place the split is visible, and it has to be,
 * because it is the one thing that cannot be merged: a habit is something you will tick
 * and a target is something the watcher counts, and choosing between them decides what the
 * rest of the form asks for. Everything after that is the same idea in two vocabularies —
 * a name or a category, chosen days or a direction and a duration.
 *
 * Archiving and deleting stay deliberately different, and only habits have both. Archiving
 * stops a habit being asked for and keeps every day it recorded — a month you kept
 * something up happened, whether or not you are still doing it. Deleting takes the history
 * with it, so it lives inside the edit form rather than on the row, and goes behind a
 * confirmation that says so. A target has no history of its
 * own to lose: the seconds belong to `activity_samples` and removing the target leaves
 * every one of them where it was.
 */
export function CommitmentsDialog({
  open,
  onClose,
  initial,
  habits,
  targets,
  streaks,
  onAddHabit,
  onEditHabit,
  onArchiveHabit,
  onDeleteHabit,
  onSaveTarget,
  onRemoveTarget,
}: Props) {
  const categories = useAssignableCategories();

  const [kind, setKind] = useState<Kind>("declared");
  const [name, setName] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [category, setCategory] = useState("");
  const [direction, setDirection] = useState<"at_least" | "at_most">("at_least");
  const [hours, setHours] = useState("2");
  const [minutes, setMinutes] = useState("0");

  /** The habit id or the category currently loaded into the form, or null while adding. */
  const [editingHabit, setEditingHabit] = useState<number | null>(null);
  const [editingTarget, setEditingTarget] = useState<string | null>(null);

  const [confirming, setConfirming] = useState<Habit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadHabit = useCallback((habit: Habit) => {
    setKind("declared");
    setEditingHabit(habit.id);
    setEditingTarget(null);
    setName(habit.name);
    setWeekdays(habit.weekdays);
  }, []);

  const loadTarget = useCallback((target: CategoryTarget) => {
    setKind("measured");
    setEditingTarget(target.category);
    setEditingHabit(null);
    setCategory(target.category);
    setDirection(target.direction);
    setHours(String(Math.floor(target.secondsPerDay / 3600)));
    setMinutes(String(Math.round((target.secondsPerDay % 3600) / 60)));
  }, []);

  // Opening on a row loads it. Clicking a measured chip in the strip is the only way a
  // target is edited, so arriving with nothing selected would make that click do nothing.
  useEffect(() => {
    if (!open || !initial) return;
    if (initial.kind === "declared") loadHabit(initial.habit);
    else loadTarget(initial.target);
  }, [open, initial, loadHabit, loadTarget]);

  if (!open) return null;

  const reset = () => {
    setName("");
    setWeekdays([]);
    setCategory("");
    setEditingHabit(null);
    setEditingTarget(null);
  };

  const untargeted = categories.filter(
    (entry) => !targets.some((target) => target.category === entry.name),
  );

  // One source for both the submit and the select's value, so what is shown and what is
  // saved cannot drift apart. See `resolveTargetCategory` for the bug this closes.
  const chosenCategory = resolveTargetCategory(editingTarget, category, untargeted);

  const editing = editingHabit !== null || editingTarget !== null;
  const canSubmit =
    kind === "declared"
      ? name.trim().length > 0
      : chosenCategory !== undefined && (editingTarget !== null || untargeted.length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === "declared") {
        if (editingHabit === null) await onAddHabit(name.trim(), weekdays);
        else await onEditHabit(editingHabit, name.trim(), weekdays);
      } else {
        const seconds = Number(hours) * 3600 + Number(minutes) * 60;
        await onSaveTarget(chosenCategory as string, direction, seconds);
      }
      reset();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const live = habits.filter((habit) => habit.archivedDay === null);
  const archived = habits.filter((habit) => habit.archivedDay !== null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-6">
      <div className="scroll-area max-h-full w-full max-w-md rounded-2xl border border-edge bg-surface p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">Commitments</h2>
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            aria-label="Close"
            className="shrink-0 text-ink-mute transition hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mt-5 rounded-xl border border-edge bg-canvas p-3">
          {/* Named rather than implied: which kind you are adding decides whether you will
              be ticking it or the watcher will, and that is worth saying out loud. */}
          <div className="flex items-center rounded-lg border border-edge p-0.5">
            {(
              [
                ["declared", "I tick it"],
                ["measured", "Nudgy measures it"],
              ] as [Kind, string][]
            ).map(([id, text]) => (
              <button
                key={id}
                type="button"
                disabled={editing}
                aria-pressed={kind === id}
                onClick={() => setKind(id)}
                className={`flex-1 rounded-md px-2 py-1 text-mini transition disabled:opacity-40 ${
                  kind === id
                    ? "bg-rose-wash font-medium text-rose-deep"
                    : "text-ink-mute hover:text-ink-soft"
                }`}
              >
                {text}
              </button>
            ))}
          </div>

          {kind === "declared" ? (
            <>
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void submit()}
                placeholder="Go to the gym"
                className="mt-2.5 w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-ink outline-none transition select-text focus:border-edge-strong"
              />

              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {DAYS.map((letter, day) => (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={weekdays.includes(day)}
                    onClick={() =>
                      setWeekdays((current) =>
                        current.includes(day)
                          ? current.filter((entry) => entry !== day)
                          : [...current, day],
                      )
                    }
                    className={`h-7 w-7 rounded-full border text-tiny font-semibold transition ${
                      weekdays.includes(day)
                        ? "border-edge-strong bg-rose text-white"
                        : "border-edge text-ink-mute hover:text-ink-soft"
                    }`}
                  >
                    {letter}
                  </button>
                ))}
                {/* No days chosen is not an empty schedule — it is every day, which is what
                    most habits are and what saves the common case a click. */}
                <span className="ml-1 text-mini text-ink-mute">
                  {weekdays.length === 0 ? "every day" : "only these days"}
                </span>
              </div>
            </>
          ) : (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <select
                value={chosenCategory ?? ""}
                disabled={editingTarget !== null || untargeted.length === 0}
                onChange={(event) => setCategory(event.target.value)}
                aria-label="Category"
                className="rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-xs text-ink-soft outline-none focus:border-edge-strong disabled:opacity-60"
              >
                {editingTarget !== null ? (
                  <option value={editingTarget}>{editingTarget}</option>
                ) : (
                  untargeted.map((entry) => (
                    <option key={entry.id} value={entry.name}>
                      {entry.name}
                    </option>
                  ))
                )}
              </select>

              <select
                value={direction}
                onChange={(event) =>
                  setDirection(event.target.value as "at_least" | "at_most")
                }
                aria-label="Direction"
                className="rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-xs text-ink-soft outline-none focus:border-edge-strong"
              >
                <option value="at_least">at least</option>
                <option value="at_most">at most</option>
              </select>

              <label className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={hours}
                  onChange={(event) => setHours(event.target.value)}
                  aria-label="Hours"
                  className="w-12 rounded-lg border border-edge bg-surface px-2 py-1.5 text-right font-mono text-xs tabular-nums text-ink-soft outline-none focus:border-edge-strong"
                />
                <span className="text-mini text-ink-mute">h</span>
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="number"
                  min={0}
                  max={59}
                  step={5}
                  value={minutes}
                  onChange={(event) => setMinutes(event.target.value)}
                  aria-label="Minutes"
                  className="w-12 rounded-lg border border-edge bg-surface px-2 py-1.5 text-right font-mono text-xs tabular-nums text-ink-soft outline-none focus:border-edge-strong"
                />
                <span className="text-mini text-ink-mute">m a day</span>
              </label>

              {untargeted.length === 0 && editingTarget === null && (
                <span className="text-mini text-ink-mute">every category has one</span>
              )}
            </div>
          )}

          <div className="mt-2.5 flex items-center justify-end gap-2">
            {editingHabit !== null && (
              <button
                type="button"
                onClick={() =>
                  setConfirming(habits.find((habit) => habit.id === editingHabit) ?? null)
                }
                title="Delete it and everything it recorded"
                className="mr-auto flex items-center gap-1 text-mini text-ink-mute transition hover:text-bad"
              >
                <Trash2 size={12} />
                Delete
              </button>
            )}
            {editing && (
              <button
                type="button"
                onClick={reset}
                className="text-mini text-ink-mute transition hover:text-ink-soft"
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              disabled={!canSubmit || busy}
              onClick={() => void submit()}
              className="flex items-center gap-1.5 rounded-lg bg-rose px-3 py-1.5 text-mini font-semibold text-white transition hover:bg-rose-deep disabled:opacity-40"
            >
              {editing ? <Check size={12} /> : <Plus size={12} />}
              {editing ? "Save" : "Add"}
            </button>
          </div>
        </div>

        {error && <p className="mt-2 text-xs text-bad">{error}</p>}

        <ul className="mt-4 space-y-2">
          {live.map((habit) => {
            const run = streaks[`habit:${habit.id}`] ?? { days: 0, lit: false };
            return (
              <li
                key={`habit:${habit.id}`}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                  editingHabit === habit.id
                    ? "border-rose-deep bg-rose-wash"
                    : "border-edge"
                }`}
              >
                <button
                  type="button"
                  onClick={() => loadHabit(habit)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-xs font-medium text-ink">
                    {habit.name}
                  </span>
                  <span className="block truncate text-mini text-ink-mute">
                    {habit.weekdays.length === 0
                      ? "Every day · you tick it"
                      : `${habit.weekdays.map((day) => DAYS[day]).join(" ")} · you tick it`}
                  </span>
                </button>

                <Run state={run} />

                <button
                  type="button"
                  onClick={() => void onArchiveHabit(habit.id, true)}
                  title="Put it away, keeping its history"
                  aria-label={`Archive ${habit.name}`}
                  className="shrink-0 text-ink-mute transition hover:text-ink-soft"
                >
                  <Archive size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => loadHabit(habit)}
                  title="Edit"
                  aria-label={`Edit ${habit.name}`}
                  className="shrink-0 text-ink-mute transition hover:text-ink-soft"
                >
                  <Pencil size={13} />
                </button>
              </li>
            );
          })}

          {targets.map((target) => {
            const run = streaks[`target:${target.category}`] ?? { days: 0, lit: false };
            return (
              <li
                key={`target:${target.category}`}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                  editingTarget === target.category
                    ? "border-rose-deep bg-rose-wash"
                    : "border-edge"
                }`}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: categoryColor(target.category) }}
                />
                <button
                  type="button"
                  onClick={() => loadTarget(target)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-xs font-medium text-ink">
                    {target.category}
                  </span>
                  <span className="block truncate text-mini text-ink-mute">
                    {target.direction === "at_least" ? "At least" : "At most"}{" "}
                    {formatDuration(target.secondsPerDay)} a day · Nudgy measures it
                  </span>
                </button>

                <Run state={run} />

                {/* No archive: a target holds no record of its own, so there is nothing
                    here that removing it could destroy. */}
                <button
                  type="button"
                  onClick={() => void onRemoveTarget(target.category)}
                  title="Stop targeting this category"
                  aria-label={`Remove the ${target.category} target`}
                  className="shrink-0 text-ink-mute transition hover:text-bad"
                >
                  <X size={13} />
                </button>
              </li>
            );
          })}
        </ul>

        {archived.length > 0 && (
          <>
            <p className="mt-5 text-mini font-semibold tracking-wider text-ink-mute uppercase">
              Archived
            </p>
            <ul className="mt-2 space-y-2">
              {archived.map((habit) => (
                <li
                  key={habit.id}
                  className="flex items-center gap-2 rounded-lg border border-edge px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-mute">
                    {habit.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => void onArchiveHabit(habit.id, false)}
                    title="Start asking for it again"
                    className="flex shrink-0 items-center gap-1 text-mini text-ink-mute transition hover:text-ink-soft"
                  >
                    <RotateCcw size={11} />
                    Bring back
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirming !== null}
        title={`Delete ${confirming?.name ?? ""}?`}
        body="Every day you ticked it goes too, and the streak with it. Archiving keeps the history and just stops asking."
        confirmLabel="Delete it"
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const doomed = confirming;
          setConfirming(null);
          if (!doomed) return;
          // The form was holding it, so it goes back to adding rather than editing nothing.
          reset();
          onDeleteHabit(doomed.id).catch((cause) => setError(String(cause)));
        }}
      />
    </div>
  );
}

function Run({ state }: { state: StreakState }) {
  if (state.days === 0) return null;
  return (
    <span
      className="flex shrink-0 items-center gap-0.5 font-mono text-tiny tabular-nums"
      style={{ color: "var(--color-rose-deep)", opacity: streakHeat(state.days, state.lit) }}
    >
      <Flame size={10} />
      {state.days}
    </span>
  );
}
