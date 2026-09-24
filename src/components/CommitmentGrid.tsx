import { Flame } from "lucide-react";

import { categoryColor } from "../lib/categories";
import { formatDuration } from "../lib/time";
import { stateOn, type Commitment, type DayState, type Ledger } from "../services/commitments";
import { dayKey, secondsOn, streakHeat, type StreakState } from "../services/progress";

interface Props {
  commitments: Commitment[];
  ledger: Ledger;
  streaks: Record<string, StreakState>;
  /** How many days to draw, ending today. */
  days: number;
}

/**
 * Every commitment against every day, so "am I actually keeping these" is one glance.
 *
 * A grid rather than a chart, because the question is not how much but *whether*, on each
 * day — and a row of filled and empty cells answers that faster than any line could. Both
 * kinds of commitment get a row: whether you coded for two hours on the 14th is the same
 * question as whether you went to the gym, and they belong on the same wall even though
 * one was counted and the other was declared.
 */
export function CommitmentGrid({ commitments, ledger, streaks, days }: Props) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dates: Date[] = [];
  for (let step = days - 1; step >= 0; step -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - step);
    dates.push(date);
  }

  if (commitments.length === 0) {
    return (
      <p className="py-16 text-center text-sm text-ink-mute">
        Nothing committed to yet. Add one below and this fills in a square at a time.
      </p>
    );
  }

  return (
    <div className="scroll-area min-h-0 flex-1">
      <table className="w-full border-separate border-spacing-y-1.5">
        <tbody>
          {commitments.map((commitment) => {
            const run = streaks[commitment.key] ?? { days: 0, lit: false };

            return (
              <tr key={commitment.key}>
                <td className="w-44 max-w-44 pr-3 align-middle">
                  <span className="flex items-center gap-1.5">
                    {/* A measured row is tied to a category, and the swatch is the same
                        one the chart above and the legend under it already use. */}
                    {commitment.kind === "measured" && (
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: categoryColor(commitment.target.category) }}
                      />
                    )}
                    <span className="truncate text-xs font-medium text-ink">
                      {commitment.name}
                    </span>
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
                    <span className="truncate">{subtitle(commitment, ledger)}</span>
                  </span>
                </td>

                <td className="align-middle">
                  <div className="flex items-center gap-[3px]">
                    {dates.map((date) => {
                      const state = stateOn(commitment, date, ledger, today);
                      const key = dayKey(date);

                      return (
                        <span
                          key={key}
                          title={`${key} — ${WORDS[state]}`}
                          className={`h-4 min-w-[0.35rem] flex-1 rounded-[3px] ${cell(state)}`}
                          style={
                            state === "met" && commitment.kind === "measured"
                              ? { background: categoryColor(commitment.target.category) }
                              : undefined
                          }
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

/** What each row is asking for, in the units that row is asked in. */
function subtitle(commitment: Commitment, ledger: Ledger): string {
  if (commitment.kind === "declared") {
    return commitment.habit.weekdays.length > 0
      ? `${commitment.habit.weekdays.length}× a week`
      : "every day";
  }

  const { target } = commitment;
  const today = ledger.byDay.get(dayKey(new Date()));
  const soFar = today ? secondsOn(today, target.category) : 0;
  const limit = formatDuration(target.secondsPerDay);
  return target.direction === "at_least"
    ? `${formatDuration(soFar)} / ${limit}`
    : `${formatDuration(soFar)} / ${limit} max`;
}

const WORDS: Record<DayState, string> = {
  met: "done",
  missed: "missed",
  open: "still open today",
  "not-due": "not due",
  unobserved: "nothing recorded",
};

/**
 * How one day of one commitment is drawn.
 *
 * Today undone is dashed rather than hollow: it has not been missed, it simply has not
 * happened yet, and a day that still has hours left in it should not look like a failure.
 * A day nothing was recorded on is drawn like a rest day for the same reason in reverse —
 * it ends a streak, but nobody failed it, and a fortnight away from the machine should not
 * read as a fortnight of misses.
 */
function cell(state: DayState): string {
  switch (state) {
    case "met":
      return "bg-rose-deep";
    case "open":
      return "border border-dashed border-edge-strong";
    case "missed":
      return "border border-edge-strong";
    default:
      return "bg-surface-sunken/60";
  }
}
