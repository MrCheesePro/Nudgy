import { useMemo } from "react";
import { Check, Flame, Plus } from "lucide-react";

import { categoryColor } from "../lib/categories";
import { quoteForDay } from "../lib/quotes";
import { formatDuration } from "../lib/time";
import {
  activeToday,
  stateOn,
  type Commitment,
  type DayState,
  type Ledger,
} from "../services/commitments";
import { dayKey, secondsOn, streakHeat, type StreakState } from "../services/progress";

interface Props {
  commitments: Commitment[];
  ledger: Ledger;
  streaks: Record<string, StreakState>;
  /** The run of days on which everything due was kept. */
  perfect: StreakState;
  onTick: (commitment: Commitment) => void;
  onManage: (commitment?: Commitment) => void;
}

/**
 * Everything you owe today, in one row.
 *
 * One list rather than two. A habit and a target read the same — a thing you owe most
 * days, and a flame that says how long you have kept it — and splitting them into a strip
 * and a panel meant two headings, two flame columns and two places to look for the same
 * answer.
 *
 * What the chips still say is which kind each one is, because that decides what clicking
 * does. A declared chip has a tick circle and ticking it is the whole interaction. A
 * measured chip has a swatch and a figure and **cannot be ticked**: the watcher decides,
 * and a commitment you could tick your way past would not be measuring anything. Clicking
 * one opens it for editing instead.
 */
export function CommitmentStrip({
  commitments,
  ledger,
  streaks,
  perfect,
  onTick,
  onManage,
}: Props) {
  const today = new Date();
  const key = dayKey(today);
  const due = activeToday(commitments, today);

  // Stable for the whole day, so it reads as a thought rather than a slot machine.
  const quote = useMemo(() => quoteForDay(key), [key]);

  return (
    <section className="rounded-2xl border border-edge bg-surface px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="shrink-0 text-mini font-semibold tracking-widest text-ink-mute uppercase">
          Today
        </span>

        {due.length === 0 ? (
          <span className="text-xs text-ink-mute">
            {commitments.length === 0
              ? "Nothing committed to yet — add one to start a streak."
              : "Nothing due today."}
          </span>
        ) : (
          <div className="scroll-area flex min-w-0 flex-1 items-center gap-2">
            {due.map((commitment) => {
              const run = streaks[commitment.key] ?? { days: 0, lit: false };
              const state = stateOn(commitment, today, ledger, today);
              const done = state === "met";

              return (
                <button
                  key={commitment.key}
                  type="button"
                  onClick={() =>
                    commitment.kind === "declared" ? onTick(commitment) : onManage(commitment)
                  }
                  aria-pressed={commitment.kind === "declared" ? done : undefined}
                  title={label(commitment, state)}
                  className={`flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition ${
                    done
                      ? "border-edge-strong bg-rose-wash text-rose-deep"
                      : state === "missed"
                        ? "border-bad/40 text-bad"
                        : "border-edge text-ink-soft hover:border-edge-strong"
                  }`}
                >
                  {commitment.kind === "declared" ? (
                    /* The circle fills rather than the row changing shape, so a strip of
                       eight does not reflow every time one is ticked. */
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                        done ? "border-rose-deep bg-rose-deep text-white" : "border-edge-strong"
                      }`}
                    >
                      {done && <Check size={10} strokeWidth={3} />}
                    </span>
                  ) : (
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: categoryColor(commitment.target.category) }}
                    />
                  )}

                  <span className="max-w-32 truncate font-medium">{commitment.name}</span>

                  {commitment.kind === "measured" && (
                    <span className="shrink-0 font-mono text-tiny tabular-nums text-ink-mute">
                      {measured(commitment, ledger, key)}
                    </span>
                  )}

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
                </button>
              );
            })}
          </div>
        )}

        {/* The whole-day run, kept apart from the per-commitment ones: it answers a harder
            question and should not read as just another chip. */}
        {perfect.days > 0 && (
          <span
            className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-surface-sunken px-2.5 py-1 text-tiny font-semibold"
            title="Days where everything due was kept"
            style={{
              color: "var(--color-rose-deep)",
              opacity: streakHeat(perfect.days, perfect.lit),
            }}
          >
            <Flame size={11} />
            {perfect.days} perfect
          </span>
        )}

        <button
          type="button"
          onClick={() => onManage()}
          title="Add or edit commitments"
          aria-label="Add or edit commitments"
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-edge text-ink-mute transition hover:border-edge-strong hover:text-ink ${
            perfect.days > 0 ? "" : "ml-auto"
          }`}
        >
          <Plus size={14} />
        </button>
      </div>

      <p className="mt-2 truncate text-xs text-ink-soft italic">
        “{quote.text}”{" "}
        <span className="text-mini not-italic text-ink-mute">— {quote.film}</span>
      </p>
    </section>
  );
}

/** `1h 20m / 2h`, and `max` where the number is a limit rather than a goal. */
function measured(commitment: Commitment, ledger: Ledger, key: string): string {
  if (commitment.kind !== "measured") return "";
  const entry = ledger.byDay.get(key);
  const soFar = entry ? secondsOn(entry, commitment.target.category) : 0;
  const bound = formatDuration(commitment.target.secondsPerDay);
  return commitment.target.direction === "at_least"
    ? `${formatDuration(soFar)} / ${bound}`
    : `${formatDuration(soFar)} / ${bound} max`;
}

function label(commitment: Commitment, state: DayState): string {
  if (commitment.kind === "declared") {
    return state === "met" ? `Undo ${commitment.name}` : `Mark ${commitment.name} done`;
  }
  return state === "missed"
    ? `${commitment.name} is over its limit today`
    : `Edit the ${commitment.name} target`;
}
