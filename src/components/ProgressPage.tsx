import { memo, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { FETCH_DAYS, useProgress } from "../hooks/useProgress";
import { HabitBoard } from "./HabitBoard";
import { CommitmentStrip } from "./CommitmentStrip";
import { CommitmentsDialog } from "./CommitmentsDialog";
import { useHabits } from "../hooks/useHabits";
import { categoryColor } from "../lib/categories";
import { usePref } from "../lib/prefs";
import { formatDuration } from "../lib/time";
import {
  fromHabit,
  fromTarget,
  ledgerOf,
  perfectStreak,
  streakFor,
  type Commitment,
} from "../services/commitments";
import {
  monthTitle,
  periodOf,
  periodTitle,
  shift,
  type PeriodKind,
} from "../services/period";
import {
  categoriesInSeries,
  dayKey,
  IDLE,
  secondsOn,
  type StreakState,
} from "../services/progress";

/**
 * Whether it is actually getting better.
 *
 * The Overview answers "where did today go". This answers the question that only exists
 * once you have a few days: is the shape of my week moving the way I wanted. Everything
 * shown is measured — there is no self-reporting anywhere on this page, which is the same
 * reason plans measure worked time rather than asking how it went.
 */
/**
 * The top of the axis, in hours. `null` fits the busiest day.
 *
 * Gridlines are always one hour, so a bar's height means the same thing whichever ceiling
 * is chosen — only how much headroom is shown changes. Picking a fixed ceiling is what
 * makes days comparable across a week; picking `Fit` is for when everything is squashed
 * into the bottom inch.
 */
const CEILINGS = [6, 12, 24, null] as const;
type Ceiling = (typeof CEILINGS)[number];

/**
 * Wrapped in `memo` because it takes no props and its parent re-renders every second.
 *
 * `useLiveActivity` ticks once a second so the session clock counts, which re-renders
 * `App` and everything inside it. For a page built out of a few hundred SVG elements that
 * meant redrawing the whole chart every second to show the same bars — the lag was not in
 * fetching anything, it was in drawing it over and over. With no props there is nothing
 * to compare, so `memo` skips the render entirely and the page redraws only when its own
 * data changes.
 */
/** How the days are drawn: hours by category, or the habit board. */
type Mode = "bars" | "habit";

const MODES: [Mode, string][] = [
  ["bars", "Bars"],
  ["habit", "Habit"],
];

const PERIODS: [PeriodKind, string][] = [
  ["week", "Weekly"],
  ["month", "Monthly"],
];

export const ProgressPage = memo(function ProgressPage() {
  // Remembered across navigation: leaving the page and coming back should not undo a
  // choice you made about how to read it.
  const [storedMode, setMode] = usePref<string>("progress.mode", "bars");
  // Older builds stored "lines" and "commitments"; they read as the views that replaced them.
  const mode: Mode = storedMode === "habit" || storedMode === "commitments" ? "habit" : "bars";
  const [kind, setKind] = usePref<PeriodKind>("progress.period", "week");
  const [ceiling, setCeiling] = usePref<Ceiling>("progress.ceiling", 12);

  /*
   * Which period is shown. Session state, not a pref: opening the page should land on
   * this week or this month, not wherever you were browsing last Tuesday.
   */
  const [anchor, setAnchor] = useState(() => new Date());
  const period = useMemo(() => periodOf(kind, anchor), [kind, anchor]);
  const now = new Date();
  const atLatest = period.end >= new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // The fetch reaches FETCH_DAYS back; a period wholly before that would be blank.
  const earliest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - FETCH_DAYS + 1);
  const atEarliest = shift(kind, anchor, -1) < periodOf(kind, earliest).start;

  const { series, full, targets, error, loading, saveTarget, removeTarget } = useProgress(
    period.days.length,
    dayKey(period.end),
  );
  const habits = useHabits();
  const [manageOpen, setManageOpen] = useState(false);
  /** The row the dialog was opened on, so a measured chip can be clicked to edit it. */
  const [managing, setManaging] = useState<Commitment | null>(null);

  /*
   * The two kinds, read as one list.
   *
   * Habits first because they are the ones you act on here — a tick is a click, and a
   * target moves only when the watcher says so. `full` rather than `series` is what the
   * ledger is built on: the chart shows a week but a streak should not be capped by it.
   */
  const commitments = useMemo<Commitment[]>(
    () => [...habits.live.map(fromHabit), ...targets.map(fromTarget)],
    [habits.live, targets],
  );
  const ledger = useMemo(() => ledgerOf(full, habits.ticks), [full, habits.ticks]);

  const streaks = useMemo(
    () =>
      Object.fromEntries(
        commitments.map((commitment) => [commitment.key, streakFor(commitment, ledger)]),
      ) as Record<string, StreakState>,
    [commitments, ledger],
  );
  const perfect = useMemo(() => perfectStreak(commitments, ledger), [commitments, ledger]);

  const openManage = (commitment?: Commitment) => {
    setManaging(commitment ?? null);
    setManageOpen(true);
  };

  // Idle is tracked and worth seeing on the Overview, but a month of stacked bars is
  // dominated by it — the question here is what the *active* hours were spent on.
  const categories = useMemo(
    () => categoriesInSeries(series).filter((category) => category !== IDLE),
    [series],
  );


  const chartData = useMemo(
    () =>
      series.map((entry) => ({
        // Seven days have room for "Sun 4"; thirty-one only for the number.
        label: kind === "week" ? shortDay(entry.day) : String(Number(entry.day.slice(8))),
        day: entry.day,
        ...Object.fromEntries(
          categories.map((category) => [category, secondsOn(entry, category) / 3600]),
        ),
      })),
    [series, categories, kind],
  );

  const tracked = series.reduce((sum, entry) => sum + entry.activeSeconds, 0);


  /** The tallest stack in view, so `Fit` has something to fit to. */
  const busiestHours = useMemo(
    () =>
      series.reduce((most, entry) => {
        const stacked = categories.reduce(
          (sum, category) => sum + secondsOn(entry, category),
          0,
        );
        return Math.max(most, stacked / 3600);
      }, 0),
    [series, categories],
  );

  const top = ceiling ?? Math.max(1, Math.ceil(busiestHours));
  // One gridline an hour, until that would be unreadable — past twelve they thin out so
  // the labels do not collide, which is a rendering limit, not a change of scale.
  const tickStep = top <= 12 ? 1 : 2;
  const ticks = useMemo(() => {
    const marks: number[] = [];
    for (let hour = 0; hour <= top; hour += tickStep) marks.push(hour);
    return marks;
  }, [top, tickStep]);

  /**
   * Nothing until the first read lands.
   *
   * The page animates its panels as they mount, and these two are the only views that
   * fetch when you arrive rather than reading state the app already holds. Rendering the
   * empty shell first spent the whole animation on a blank card and then painted the real
   * content, unanimated, once the query came back — which is why switching here looked
   * like nothing happened. Mounting on the data instead means the panels animate when
   * there is something to see.
   *
   * Safe because `loading` is one-way: it starts true and is only ever set false, so a
   * later refresh updates in place rather than replaying the entrance.
   */
  if (loading) return null;

  return (
    <>
      {error && (
        <p className="rounded-xl border border-bad/20 bg-bad/10 px-4 py-3 text-xs text-bad">
          {error}
        </p>
      )}

      <section className="flex min-h-[22rem] flex-1 flex-col rounded-2xl border border-edge bg-surface p-6">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          {/* The period by name. The habit board is a month's page, so it is only ever
              the month; the bars say exactly which days they cover. */}
          <h2 className="text-2xl font-semibold text-ink">
            {mode === "habit" ? monthTitle(period.start) : periodTitle(kind, period)}
          </h2>
          <div className="flex items-center gap-2">
            <span className="mr-1 font-mono text-xs tabular-nums text-ink-mute">
              {mode === "habit"
                ? `${perfect.days} perfect ${perfect.days === 1 ? "day" : "days"}`
                : `${formatDuration(tracked)} total`}
            </span>

            <span className="flex items-center">
              <button
                type="button"
                disabled={atEarliest}
                onClick={() => setAnchor(shift(kind, anchor, -1))}
                aria-label={kind === "week" ? "Previous week" : "Previous month"}
                className="rounded-lg p-1 text-ink-mute transition hover:text-ink disabled:opacity-30"
              >
                <ChevronLeft size={15} />
              </button>
              <button
                type="button"
                disabled={atLatest}
                onClick={() => setAnchor(shift(kind, anchor, 1))}
                aria-label={kind === "week" ? "Next week" : "Next month"}
                className="rounded-lg p-1 text-ink-mute transition hover:text-ink disabled:opacity-30"
              >
                <ChevronRight size={15} />
              </button>
            </span>

            <span className="flex items-center rounded-lg border border-edge p-0.5">
              {PERIODS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setKind(id)}
                  aria-pressed={kind === id}
                  className={`rounded-md px-2 py-0.5 text-mini transition ${
                    kind === id
                      ? "bg-rose-wash font-medium text-rose-deep"
                      : "text-ink-mute hover:text-ink-soft"
                  }`}
                >
                  {label}
                </button>
              ))}
            </span>

            {/* Only the bars have an hours axis. */}
            {mode === "bars" && (
            <select
              value={ceiling ?? "fit"}
              onChange={(event) =>
                setCeiling(
                  event.target.value === "fit" ? null : (Number(event.target.value) as Ceiling),
                )
              }
              aria-label="Top of the hours axis"
              className="rounded-lg border border-edge bg-canvas px-1.5 py-1 text-mini text-ink-soft outline-none focus:border-edge-strong"
            >
              {CEILINGS.map((option) => (
                <option key={option ?? "fit"} value={option ?? "fit"}>
                  {option === null ? "Fit" : `${option}h max`}
                </option>
              ))}
            </select>
            )}

            {/* Two ways of reading the same days, named rather than cycled: with a
                toggle you have to click to find out what is on the other side. */}
            <span className="flex items-center rounded-lg border border-edge p-0.5">
              {MODES.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setMode(id)}
                  aria-pressed={mode === id}
                  className={`rounded-md px-2 py-0.5 text-mini transition ${
                    mode === id
                      ? "bg-rose-wash font-medium text-rose-deep"
                      : "text-ink-mute hover:text-ink-soft"
                  }`}
                >
                  {label}
                </button>
              ))}
            </span>
          </div>
        </div>

        {mode === "habit" ? (
          <div className="mt-5 flex min-h-0 flex-1 flex-col">
            <HabitBoard
              commitments={commitments}
              ledger={ledger}
              days={period.days}
              monthly={habits.monthly}
              ticks={habits.ticks}
              monthKey={dayKey(period.start).slice(0, 8) + "01"}
              onAddMonthly={habits.addMonthly}
              onDeleteMonthly={habits.remove}
              onToggleHabit={(habit, day) => void habits.toggle(habit, day)}
            />
          </div>
        ) : loading && series.length === 0 ? (
          <p className="py-20 text-center text-sm text-ink-mute">Loading…</p>
        ) : tracked === 0 ? (
          <p className="py-20 text-center text-sm text-ink-mute">
            Nothing tracked in this window yet. Leave Nudgy running and days will start
            filling in.
          </p>
        ) : (
          <div className="mt-5 min-h-0 flex-1">
            <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
                  <CartesianGrid vertical={false} stroke="currentColor" className="text-edge" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize="var(--text-tiny)" />
                  <YAxis
                    domain={[0, top]}
                    ticks={ticks}
                    interval={0}
                    tickLine={false}
                    axisLine={false}
                    fontSize="var(--text-tiny)"
                    width={34}
                    tickFormatter={(value: number) => `${value}h`}
                  />
                  <Tooltip
                    content={<HoursTooltip />}
                    cursor={{ fill: "transparent" }}
                    isAnimationActive={false}
                  />
                  {categories.map((category, index) => (
                    <Bar
                      key={category}
                      dataKey={category}
                      stackId="day"
                      fill={categoryColor(category)}
                      // Only the top segment is rounded, or every band looks detached.
                      radius={index === categories.length - 1 ? [4, 4, 0, 0] : undefined}
                      // Every refresh re-animates every bar otherwise, and this redraws on
                      // a timer — the newest day grows by seconds and the rest cannot have
                      // changed at all, so there is nothing worth animating and a lot to
                      // pay for it.
                      isAnimationActive={false}
                    />
                  ))}
                </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {mode === "bars" && categories.length > 0 && (
          <ul className="mt-4 flex shrink-0 flex-wrap gap-x-4 gap-y-1.5">
            {categories.map((category) => (
              <li key={category} className="flex items-center gap-1.5 text-mini text-ink-soft">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: categoryColor(category) }}
                />
                {category}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Today's row, under the chart that draws its history. Both kinds together: they
          are the same question asked of the same day, and two panels with two flame
          columns made them look like two subjects. */}
      <div className="shrink-0">
        <CommitmentStrip
          commitments={commitments}
          ledger={ledger}
          streaks={streaks}
          perfect={perfect}
          onTick={(commitment) =>
            commitment.kind === "declared" && void habits.toggle(commitment.habit)
          }
          onManage={openManage}
        />
      </div>

      <CommitmentsDialog
        open={manageOpen}
        onClose={() => {
          setManageOpen(false);
          setManaging(null);
        }}
        initial={managing}
        habits={habits.habits}
        targets={targets}
        streaks={streaks}
        onAddHabit={habits.add}
        onEditHabit={habits.edit}
        onArchiveHabit={habits.setArchived}
        onDeleteHabit={habits.remove}
        onSaveTarget={saveTarget}
        onRemoveTarget={removeTarget}
      />
    </>
  );
});

/** `Mon 15` — enough to find a day without crowding thirty of them onto an axis. */
function shortDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const parsed = new Date(year, month - 1, date);
  return parsed.toLocaleDateString([], { weekday: "short", day: "numeric" });
}

interface TooltipEntry {
  name?: string;
  value?: number;
  color?: string;
  dataKey?: string | number;
}


function HoursTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((entry) => (entry.value ?? 0) > 0);
  if (rows.length === 0) return null;

  // The stack's own height, which the segments make you add up in your head otherwise.
  const total = rows.reduce((sum, entry) => sum + (entry.value ?? 0), 0);

  return (
    <div className="rounded-xl border border-edge bg-surface px-3 py-2 shadow-lg">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-mini font-semibold text-ink">{label}</span>
        {total > 0 && (
          <span className="font-mono text-mini tabular-nums text-ink-soft">
            {formatDuration(total * 3600)}
          </span>
        )}
      </div>
      <ul className="mt-1 space-y-0.5">
        {rows.map((entry) => (
          <li key={entry.name} className="flex items-center gap-2 text-mini">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: entry.color }}
            />
            <span className="text-ink-soft">{entry.name}</span>
            <span className="ml-auto font-mono tabular-nums text-ink-mute">
              {formatDuration((entry.value ?? 0) * 3600)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
