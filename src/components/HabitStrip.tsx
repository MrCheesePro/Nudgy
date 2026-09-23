import { Check, Flame, Plus } from "lucide-react";

import { streakHeat, type StreakState } from "../services/progress";
import { dayKey } from "../services/progress";
import { dueOn, type Habit, type Ticks } from "../services/habits";

interface Props {
  habits: Habit[];
  ticks: Ticks;
  streaks: Record<number, StreakState>;
  /** The run of days on which everything due was done. */
  perfect: StreakState;
  onToggle: (habit: Habit) => void;
  onManage: () => void;
}

/**
 * The habits, on the day you are in.
 *
 * A strip rather than a panel, and on Today rather than behind a tab, because ticking a
 * habit is a one-second act and anything that takes navigating to is a thing you stop
 * doing. Today is `overflow-hidden` and has to keep fitting the viewport, so this is a
 * fixed-height row that scrolls sideways rather than a list that grows.
 *
 * Only what is due today is shown. A Mon/Wed/Fri habit on a Tuesday is not an omission —
 * it is the schedule doing its job, and listing it greyed out would make every rest day
 * look like a failure.
 */
export function HabitStrip({ habits, ticks, streaks, perfect, onToggle, onManage }: Props) {
  const today = new Date();
  const key = dayKey(today);
  const due = habits.filter((habit) => dueOn(habit, today));

  return (
    <section className="flex shrink-0 items-center gap-3 rounded-2xl border border-edge bg-surface px-4 py-3">
      <span className="shrink-0 text-mini font-semibold tracking-widest text-ink-mute uppercase">
        Habits
      </span>

      {due.length === 0 ? (
        <span className="text-xs text-ink-mute">
          {habits.length === 0
            ? "Nothing tracked yet — add one to start a streak."
            : "Nothing due today."}
        </span>
      ) : (
        <div className="scroll-area flex min-w-0 flex-1 items-center gap-2">
          {due.map((habit) => {
            const done = ticks[habit.id]?.has(key) ?? false;
            const run = streaks[habit.id] ?? { days: 0, lit: false };

            return (
              <button
                key={habit.id}
                type="button"
                onClick={() => onToggle(habit)}
                aria-pressed={done}
                title={done ? `Undo ${habit.name}` : `Mark ${habit.name} done`}
                className={`flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition ${
                  done
                    ? "border-edge-strong bg-rose-wash text-rose-deep"
                    : "border-edge text-ink-soft hover:border-edge-strong"
                }`}
              >
                {/* The circle fills rather than the row changing shape, so a strip of
                    eight habits does not reflow every time one is ticked. */}
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    done ? "border-rose-deep bg-rose-deep text-white" : "border-edge-strong"
                  }`}
                >
                  {done && <Check size={10} strokeWidth={3} />}
                </span>
                <span className="max-w-32 truncate font-medium">{habit.name}</span>
                {run.days > 0 && (
                  <span
                    className="flex shrink-0 items-center gap-0.5 font-mono text-tiny tabular-nums"
                    style={{ color: "var(--color-rose-deep)", opacity: streakHeat(run.days, run.lit) }}
                  >
                    <Flame size={10} />
                    {run.days}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* The whole-day run, kept apart from the per-habit ones: it answers a harder
          question and should not read as just another habit. */}
      {perfect.days > 0 && (
        <span
          className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-surface-sunken px-2.5 py-1 text-tiny font-semibold"
          title="Days where everything due was done"
          style={{ color: "var(--color-rose-deep)", opacity: streakHeat(perfect.days, perfect.lit) }}
        >
          <Flame size={11} />
          {perfect.days} perfect
        </span>
      )}

      <button
        type="button"
        onClick={onManage}
        title="Add or edit habits"
        aria-label="Add or edit habits"
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-edge text-ink-mute transition hover:border-edge-strong hover:text-ink ${
          perfect.days > 0 ? "" : "ml-auto"
        }`}
      >
        <Plus size={14} />
      </button>
    </section>
  );
}
