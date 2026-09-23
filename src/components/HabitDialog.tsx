import { useState } from "react";
import { Archive, Flame, Plus, RotateCcw, Trash2, X } from "lucide-react";

import { ConfirmDialog } from "./ConfirmDialog";
import { streakHeat, type StreakState } from "../services/progress";
import type { Habit } from "../services/habits";

interface Props {
  open: boolean;
  onClose: () => void;
  habits: Habit[];
  streaks: Record<number, StreakState>;
  onAdd: (name: string, weekdays: number[]) => Promise<void>;
  onEdit: (id: number, name: string, weekdays: number[]) => Promise<void>;
  onArchive: (id: number, archived: boolean) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

const DAYS = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * Adding, editing and putting habits away.
 *
 * Archiving and deleting are deliberately different things and are offered as different
 * buttons. Archiving stops a habit being asked for and keeps every day it recorded — a
 * month you kept something up happened, whether or not you are still doing it. Deleting
 * takes the history with it, so it goes behind a confirmation that says so.
 */
export function HabitDialog({
  open,
  onClose,
  habits,
  streaks,
  onAdd,
  onEdit,
  onArchive,
  onDelete,
}: Props) {
  const [name, setName] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<Habit | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const reset = () => {
    setName("");
    setWeekdays([]);
    setEditing(null);
  };

  const submit = async () => {
    if (!name.trim()) return;
    setError(null);
    try {
      if (editing === null) await onAdd(name.trim(), weekdays);
      else await onEdit(editing, name.trim(), weekdays);
      reset();
    } catch (cause) {
      setError(String(cause));
    }
  };

  const live = habits.filter((habit) => habit.archivedDay === null);
  const archived = habits.filter((habit) => habit.archivedDay !== null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-6">
      <div className="scroll-area max-h-full w-full max-w-md rounded-2xl border border-edge bg-surface p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">Habits</h2>
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
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && void submit()}
            placeholder="Go to the gym"
            className="w-full rounded-lg border border-edge bg-surface px-3 py-2 text-sm text-ink outline-none transition select-text focus:border-edge-strong"
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

            <span className="ml-auto flex items-center gap-2">
              {editing !== null && (
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
                disabled={!name.trim()}
                onClick={() => void submit()}
                className="flex items-center gap-1.5 rounded-lg bg-rose px-3 py-1.5 text-mini font-semibold text-white transition hover:bg-rose-deep disabled:opacity-40"
              >
                {editing === null ? <Plus size={12} /> : null}
                {editing === null ? "Add" : "Save"}
              </button>
            </span>
          </div>
        </div>

        {error && <p className="mt-2 text-xs text-bad">{error}</p>}

        <ul className="mt-4 space-y-2">
          {live.map((habit) => {
            const run = streaks[habit.id] ?? { days: 0, lit: false };
            return (
              <li
                key={habit.id}
                className="flex items-center gap-2 rounded-lg border border-edge px-3 py-2"
              >
                <button
                  type="button"
                  onClick={() => {
                    setEditing(habit.id);
                    setName(habit.name);
                    setWeekdays(habit.weekdays);
                  }}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-xs font-medium text-ink">
                    {habit.name}
                  </span>
                  <span className="block truncate text-mini text-ink-mute">
                    {habit.weekdays.length === 0
                      ? "Every day"
                      : habit.weekdays.map((day) => DAYS[day]).join(" ")}
                  </span>
                </button>

                {run.days > 0 && (
                  <span
                    className="flex shrink-0 items-center gap-0.5 font-mono text-tiny tabular-nums"
                    style={{
                      color: "var(--color-rose-deep)",
                      opacity: streakHeat(run.days, run.lit),
                    }}
                  >
                    <Flame size={10} />
                    {run.days}
                  </span>
                )}

                <button
                  type="button"
                  onClick={() => void onArchive(habit.id, true)}
                  title="Put it away, keeping its history"
                  aria-label={`Archive ${habit.name}`}
                  className="shrink-0 text-ink-mute transition hover:text-ink-soft"
                >
                  <Archive size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(habit)}
                  title="Delete it and everything it recorded"
                  aria-label={`Delete ${habit.name}`}
                  className="shrink-0 text-ink-mute transition hover:text-bad"
                >
                  <Trash2 size={13} />
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
                    onClick={() => void onArchive(habit.id, false)}
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
          if (confirming) void onDelete(confirming.id);
          setConfirming(null);
        }}
      />
    </div>
  );
}
