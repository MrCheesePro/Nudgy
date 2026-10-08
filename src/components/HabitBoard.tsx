import { memo, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { categoryColor } from "../lib/categories";
import type { Commitment, DayState, Ledger } from "../services/commitments";
import {
  boardState,
  dayTally,
  periodPercent,
  topHabits,
  type DayTally,
} from "../services/habitBoard";
import type { Habit, Ticks } from "../services/habits";
import { weeksOf } from "../services/period";
import { dayKey } from "../services/progress";

interface Props {
  /** Daily habits and measured targets — what a day can be kept or missed on. */
  commitments: Commitment[];
  ledger: Ledger;
  /** The period's days, oldest first. */
  days: Date[];
  /** Monthly checks, and the month whose ticks are shown — `YYYY-MM-01`. */
  monthly: Habit[];
  ticks: Ticks;
  monthKey: string;
  onAddMonthly: (name: string) => Promise<void>;
  onDeleteMonthly: (id: number) => Promise<void>;
  onToggleHabit: (habit: Habit, day: string) => void;
}

const LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * The month as a habit tracker: how much of each day you kept, every daily commitment
 * against every day.
 *
 * A grid rather than a chart, because the question is not how much but *whether* — and a
 * row of filled and empty cells answers that faster than any line. Habits and targets
 * share the grid: whether you coded for two hours on the 14th is the same question as
 * whether you went to the gym, even though one was counted and the other declared — and
 * only the declared kind can be clicked (invariant 45).
 *
 * `memo`, because the app re-renders every second and this is several hundred cells
 * (invariant 41).
 */
export const HabitBoard = memo(function HabitBoard({
  commitments,
  ledger,
  days,
  monthly,
  ticks,
  monthKey,
  onAddMonthly,
  onDeleteMonthly,
  onToggleHabit,
}: Props) {
  const today = new Date();
  const todayKey = dayKey(today);

  const tallies = useMemo(
    () => days.map((date) => dayTally(commitments, ledger, date, today)),
    // `today` is a new Date every render; the day it names is what matters.
    [commitments, ledger, days, todayKey],
  );
  const overall = periodPercent(tallies);
  const weeks = useMemo(() => weeksOf(days), [days]);
  const top = useMemo(
    () => topHabits(commitments, ledger, days, 5),
    [commitments, ledger, days],
  );
  const chart = days.map((date, index) => ({
    label: String(date.getDate()),
    percent: tallies[index].percent,
  }));

  return (
    <div className="flex min-h-0 flex-1 gap-5">
      <div className="scroll-area min-h-0 min-w-0 flex-1">
        {/* How much of each day was kept, as a shape. */}
        <div className="flex">
          <div className="w-40 shrink-0" />
          <div className="min-w-0 flex-1">
            <ResponsiveContainer width="100%" height={110}>
              <AreaChart data={chart} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize="var(--text-tiny)" />
                <YAxis
                  domain={[0, 100]}
                  ticks={[0, 25, 50, 75, 100]}
                  tickLine={false}
                  axisLine={false}
                  fontSize="var(--text-tiny)"
                  tickFormatter={(value: number) => `${value}%`}
                />
                <Tooltip
                  formatter={(value) => [`${Math.round(Number(value))}%`, "Kept"]}
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="percent"
                  stroke="var(--color-rose-deep)"
                  fill="var(--color-rose-wash)"
                  // A day still to come has no value; the line stops rather than diving.
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <table className="mt-3 w-full table-fixed border-separate border-spacing-[3px]">
          <colgroup>
            <col className="w-40" />
          </colgroup>
          <tbody>
            <TallyRow label="Tasks completed" tallies={tallies} pick={(tally) => tally.done} />
            <TallyRow
              label="Tasks not completed"
              tallies={tallies}
              pick={(tally) => tally.notDone}
            />
            <TallyRow
              label="Progress"
              tallies={tallies}
              pick={(tally) => (tally.percent === null ? null : `${Math.round(tally.percent)}%`)}
            />

            <tr>
              <td />
              {weeks.map((week, index) => (
                <td
                  key={dayKey(week[0])}
                  colSpan={week.length}
                  className="rounded bg-surface-sunken pt-2 pb-1 text-center text-tiny font-semibold tracking-wider text-ink-soft uppercase"
                >
                  Week {index + 1}
                </td>
              ))}
            </tr>
            <tr>
              <td className="pr-2 text-right text-tiny font-semibold tracking-wider text-ink-soft uppercase">
                Daily habits
              </td>
              {days.map((date) => (
                <td
                  key={dayKey(date)}
                  className={`text-center text-tiny leading-tight ${
                    dayKey(date) === todayKey ? "font-semibold text-rose-deep" : "text-ink-mute"
                  }`}
                >
                  <div>{LETTERS[date.getDay()]}</div>
                  <div className="font-mono tabular-nums">{date.getDate()}</div>
                </td>
              ))}
            </tr>

            {commitments.length === 0 && (
              <tr>
                <td colSpan={days.length + 1} className="py-6 text-center text-xs text-ink-mute">
                  No daily habits or targets yet. Add one below.
                </td>
              </tr>
            )}
            {commitments.map((commitment) => (
              <tr key={commitment.key}>
                <td className="truncate pr-2 text-right text-xs text-ink">
                  {commitment.kind === "measured" && (
                    <span
                      className="mr-1.5 inline-block h-2 w-2 rounded-full"
                      style={{ background: categoryColor(commitment.target.category) }}
                    />
                  )}
                  {commitment.name}
                </td>
                {days.map((date) => {
                  const key = dayKey(date);
                  const state = boardState(commitment, date, ledger, today);
                  return (
                    <td key={key} className="p-0">
                      <DayCell
                        state={state}
                        label={`${commitment.name}, ${key}`}
                        color={
                          commitment.kind === "measured"
                            ? categoryColor(commitment.target.category)
                            : undefined
                        }
                        // A habit can be ticked on any day it was due, for the day the app
                        // was not open. A measured day cannot: what was tracked happened.
                        onClick={
                          commitment.kind === "declared" &&
                          state !== "not-due" &&
                          state !== "future"
                            ? () => onToggleHabit(commitment.habit, key)
                            : undefined
                        }
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <aside className="flex w-48 shrink-0 flex-col gap-4">
        <div className="rounded-xl border border-ink-mute/40 bg-canvas p-4">
          <h3 className="text-center text-tiny font-semibold tracking-widest text-ink-soft uppercase">
            {days.length > 7 ? "Monthly progress" : "Weekly progress"}
          </h3>
          <Ring percent={overall} />
        </div>

        <div className="rounded-xl border border-ink-mute/40 bg-canvas p-4">
            <h3 className="text-center text-tiny font-semibold tracking-widest text-ink-soft uppercase">
              Top 5 daily habits
            </h3>
            {top.length === 0 ? (
              <p className="mt-3 text-center text-mini text-ink-mute">Nothing kept yet.</p>
            ) : (
              <ol className="mt-3 space-y-1.5">
                {top.map((entry, index) => (
                  <li key={entry.commitment.key} className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-tiny text-ink-mute">{index + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-ink">{entry.commitment.name}</span>
                    <span className="font-mono text-tiny tabular-nums text-ink-mute">
                      {entry.days}d
                    </span>
                  </li>
                ))}
              </ol>
            )}
        </div>

        <MonthlyChecks
          habits={monthly}
          ticks={ticks}
          monthKey={monthKey}
          onToggle={(habit) => onToggleHabit(habit, monthKey)}
          onAdd={onAddMonthly}
          onDelete={onDeleteMonthly}
        />
      </aside>
    </div>
  );
});

/** One count per day. The cell darkens with the day's percentage, like the sheet it is from. */
function TallyRow({
  label,
  tallies,
  pick,
}: {
  label: string;
  tallies: DayTally[];
  pick: (tally: DayTally) => number | string | null;
}) {
  return (
    <tr>
      <td className="truncate pr-2 text-right text-tiny font-semibold tracking-wider text-ink-soft uppercase">
        {label}
      </td>
      {tallies.map((tally, index) => (
        <td
          key={index}
          className="rounded py-0.5 text-center font-mono text-tiny tabular-nums text-ink"
          style={{
            background:
              tally.percent === null
                ? undefined
                : `color-mix(in srgb, var(--color-rose-deep) ${Math.round(
                    10 + tally.percent * 0.45,
                  )}%, transparent)`,
          }}
        >
          {tally.percent === null ? "" : pick(tally)}
        </td>
      ))}
    </tr>
  );
}

const WORDS: Record<DayState | "future", string> = {
  met: "done",
  missed: "missed",
  open: "still open today",
  "not-due": "not due",
  unobserved: "nothing recorded",
  future: "still to come",
};

/**
 * One day of one commitment.
 *
 * Outlines are drawn in `ink-mute`, not `edge`: the edge tokens are the picked colour
 * mixed toward white, so a pale colour makes them vanish against the card, while ink is
 * mixed toward black and stays visible whatever was picked.
 *
 * Today undone is dashed rather than hollow: it has not been missed, it simply has not
 * happened yet. A day nothing was recorded on is drawn like a rest day — it ends a
 * streak, but nobody failed it, and a fortnight away from the machine should not read as
 * a fortnight of misses.
 */
function DayCell({
  state,
  label,
  color,
  onClick,
}: {
  state: DayState | "future";
  label: string;
  color?: string;
  onClick?: () => void;
}) {
  const look =
    state === "met"
      ? "bg-rose-deep text-white"
      : state === "open"
        ? "border border-dashed border-ink-mute"
        : state === "missed"
          ? "border border-ink-mute"
          : state === "future"
            ? "border border-ink-mute/35"
            : "bg-surface-sunken/60";
  const className = `mx-auto flex h-4 w-full max-w-5 items-center justify-center rounded-[3px] ${look}`;
  const style = state === "met" && color ? { background: color } : undefined;
  const title = `${label} — ${WORDS[state]}`;

  if (!onClick) return <span title={title} className={className} style={style} />;
  return (
    <button
      type="button"
      title={`${title} (click to ${state === "met" ? "untick" : "tick"})`}
      aria-pressed={state === "met"}
      onClick={onClick}
      className={`${className} cursor-pointer transition hover:ring-1 hover:ring-rose-deep`}
    >
    </button>
  );
}

/** The period's percentage as a ring. Fixed pixels, so it exists before anything measures. */
function Ring({ percent }: { percent: number | null }) {
  const circumference = 2 * Math.PI * 42;
  const filled = percent === null ? 0 : percent / 100;
  return (
    <div className="relative mx-auto mt-3 h-28 w-28">
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle cx="50" cy="50" r="42" fill="none" strokeWidth="12" className="stroke-ink-mute/25" />
        <circle
          cx="50"
          cy="50"
          r="42"
          fill="none"
          strokeWidth="12"
          stroke="var(--color-rose-deep)"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - filled)}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-mono text-xl font-semibold tabular-nums text-ink">
        {percent === null ? "–" : `${Math.round(percent)}%`}
      </span>
    </div>
  );
}

/**
 * Things owed once a month, as plain checks — no streak, no tally, no grid. A tick is
 * keyed on the month's first day, so the box shows the month the page is on.
 */
function MonthlyChecks({
  habits,
  ticks,
  monthKey,
  onToggle,
  onAdd,
  onDelete,
}: {
  habits: Habit[];
  ticks: Ticks;
  monthKey: string;
  onToggle: (habit: Habit) => void;
  onAdd: (name: string) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  /** Deleting takes every month it was ticked, so it asks once, in place. */
  const [confirming, setConfirming] = useState<number | null>(null);
  const add = () => {
    if (!draft.trim()) return;
    void onAdd(draft.trim());
    setDraft("");
  };

  return (
    <div className="rounded-xl border border-ink-mute/40 bg-canvas p-4">
      <h3 className="text-center text-tiny font-semibold tracking-widest text-ink-soft uppercase">
        Monthly habits
      </h3>
      <ul className="mt-3 space-y-1.5">
        {habits.map((habit) => {
          const done = ticks[habit.id]?.has(monthKey) ?? false;
          // Not a month that ended before the habit existed.
          const open = habit.createdDay.slice(0, 7) <= monthKey.slice(0, 7);
          return (
            <li key={habit.id} className="group flex items-center gap-2 text-xs">
              <button
                type="button"
                disabled={!open}
                aria-pressed={done}
                aria-label={`${habit.name} this month`}
                onClick={() => onToggle(habit)}
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded transition ${
                  done
                    ? "bg-rose-deep text-white"
                    : open
                      ? "border border-ink-mute hover:border-rose-deep"
                      : "bg-surface-sunken/60"
                }`}
              >
              </button>
              <span className={`min-w-0 flex-1 truncate ${done ? "text-ink-mute line-through" : "text-ink"}`}>
                {habit.name}
              </span>
              {confirming === habit.id ? (
                <button
                  type="button"
                  onClick={() => {
                    setConfirming(null);
                    void onDelete(habit.id);
                  }}
                  onBlur={() => setConfirming(null)}
                  autoFocus
                  className="shrink-0 text-tiny font-medium text-bad"
                >
                  Delete + history?
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(habit.id)}
                  aria-label={`Remove ${habit.name}`}
                  className="shrink-0 text-ink-mute opacity-0 transition group-hover:opacity-100 hover:text-bad"
                >
                  <X size={11} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-2.5 flex items-center gap-1">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && add()}
          aria-label="New monthly habit"
          className="min-w-0 flex-1 rounded-md border border-ink-mute bg-surface px-2 py-1 text-mini text-ink outline-none select-text focus:border-rose-deep"
        />
        <button
          type="button"
          disabled={!draft.trim()}
          onClick={add}
          aria-label="Add monthly habit"
          className="shrink-0 rounded-md p-1 text-rose-deep transition hover:bg-rose-wash disabled:opacity-30"
        >
          <Plus size={13} />
        </button>
      </div>
    </div>
  );
}
