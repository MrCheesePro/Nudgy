import { Flame } from "lucide-react";

import { dayKey, streakHeat, type StreakState } from "../services/progress";
import { dueOn, type Habit, type Ticks } from "../services/habits";

interface Props {
  habits: Habit[];
  ticks: Ticks;
  streaks: Record<number, StreakState>;
  /** How many days to draw, ending today. */
  days: number;
}

/**
 * Every habit against every day, so "am I actually doing this daily" is one glance.
 *
 * A grid rather than a chart, because the question is not how much but *whether*, on each
 * day — and a row of filled and empty cells answers that faster than any line could.
 *
 * **Three states, not two.** A day the habit was not due looks different from a day it was
 * due and missed. Drawing them the same would paint every rest day as a failure, which is
 * the same mistake the strip on Today avoids by only listing what is due.
 */
export function HabitGrid({ habits, ticks, streaks, days }: Props) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = dayKey(today);

  const dates: Date[] = [];
  for (let step = days - 1; step >= 0; step -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - step);
    dates.push(date);
  }

  if (habits.length === 0) {
    return (
      <p className="py-16 text-center text-sm text-ink-mute">
        No habits yet. Add one below and this fills in a square at a time.
      </p>
    );
  }

  return (
    <div className="scroll-area min-h-0 flex-1">
      <table className="w-full border-separate border-spacing-y-1.5">
        <tbody>
          {habits.map((habit) => {
            const run = streaks[habit.id] ?? { days: 0, lit: false };
            const done = ticks[habit.id] ?? new Set<string>();

            return (
              <tr key={habit.id}>
                <td className="w-40 max-w-40 pr-3 align-middle">
                  <span className="block truncate text-xs font-medium text-ink">
                    {habit.name}
                  </span>
                  <span className="flex items-center gap-1 text-tiny text-ink-mute">
                    {run.days > 0 && (
                      <span
                        className="flex items-center gap-0.5 font-mono tabular-nums"
                        style={{
                          color: "var(--color-rose-deep)",
                          opacity: streakHeat(run.days, run.lit),
                        }}
                      >
                        <Flame size={9} />
                        {run.days}
                      </span>
                    )}
                    {habit.weekdays.length > 0 && <span>{habit.weekdays.length}× a week</span>}
                  </span>
                </td>

                <td className="align-middle">
                  <div className="flex items-center gap-[3px]">
                    {dates.map((date) => {
                      const key = dayKey(date);
                      const due = dueOn(habit, date);
                      const ticked = done.has(key);
                      const isToday = key === todayKey;

                      return (
                        <span
                          key={key}
                          title={`${key}${due ? (ticked ? " — done" : " — missed") : " — not due"}`}
                          className={`h-4 min-w-[0.35rem] flex-1 rounded-[3px] ${cell(
                            due,
                            ticked,
                            isToday,
                          )}`}
                        />
                      );
                    })}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * How one day of one habit is drawn.
 *
 * Today undone is dashed rather than hollow: it has not been missed, it simply has not
 * happened yet, and a day that still has hours left in it should not look like a failure.
 */
function cell(due: boolean, ticked: boolean, isToday: boolean): string {
  if (!due) return "bg-surface-sunken/60";
  if (ticked) return "bg-rose-deep";
  if (isToday) return "border border-dashed border-edge-strong";
  return "border border-edge-strong";
}
