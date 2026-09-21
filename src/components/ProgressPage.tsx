import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { RANGES, useProgress, type Range } from "../hooks/useProgress";
import { TargetsPanel } from "./TargetsPanel";
import { categoryColor } from "../lib/categories";
import { usePref } from "../lib/prefs";
import { formatDuration } from "../lib/time";
import { categoriesInSeries, IDLE, secondsOn } from "../services/progress";

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

export function ProgressPage() {
  // Remembered across navigation: leaving the page and coming back should not undo a
  // choice you made about how to read it.
  const [range, setRange] = usePref<Range>("progress.range", 7);
  const [mode, setMode] = usePref<"bars" | "lines">("progress.mode", "bars");
  const [ceiling, setCeiling] = usePref<Ceiling>("progress.ceiling", 12);
  const { series, targets, error, loading } = useProgress(range);

  // Idle is tracked and worth seeing on the Overview, but a month of stacked bars is
  // dominated by it — the question here is what the *active* hours were spent on.
  const categories = useMemo(
    () => categoriesInSeries(series).filter((category) => category !== IDLE),
    [series],
  );

  const chartData = useMemo(
    () =>
      series.map((entry) => ({
        label: shortDay(entry.day),
        day: entry.day,
        ...Object.fromEntries(
          categories.map((category) => [category, secondsOn(entry, category) / 3600]),
        ),
      })),
    [series, categories],
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

  return (
    <>
      {error && (
        <p className="rounded-xl border border-bad/20 bg-bad/10 px-4 py-3 text-xs text-bad">
          {error}
        </p>
      )}

      <section className="flex min-h-[22rem] flex-1 flex-col rounded-2xl border border-edge bg-surface p-6">
        <div className="flex shrink-0 flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-mini font-semibold tracking-widest text-ink-soft uppercase">
            Last {range} days
          </h2>
          <div className="flex items-center gap-2">
            <span className="mr-1 font-mono text-xs tabular-nums text-ink-mute">
              {formatDuration(tracked)} active
            </span>
            {RANGES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setRange(option)}
                className={`rounded-lg px-2 py-1 text-mini transition ${
                  option === range
                    ? "bg-rose-wash font-medium text-rose-deep"
                    : "text-ink-mute hover:text-ink-soft"
                }`}
              >
                {option}d
              </button>
            ))}
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
            <button
              type="button"
              onClick={() => setMode(mode === "bars" ? "lines" : "bars")}
              className="rounded-lg border border-edge px-2 py-1 text-mini text-ink-soft transition hover:border-edge-strong"
            >
              {mode === "bars" ? "Lines" : "Bars"}
            </button>
          </div>
        </div>

        {loading && series.length === 0 ? (
          <p className="py-20 text-center text-sm text-ink-mute">Loading…</p>
        ) : tracked === 0 ? (
          <p className="py-20 text-center text-sm text-ink-mute">
            Nothing tracked in this window yet. Leave Nudgy running and days will start
            filling in.
          </p>
        ) : (
          <div className="mt-5 min-h-0 flex-1">
            <ResponsiveContainer width="100%" height="100%">
              {mode === "bars" ? (
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
                    />
                  ))}
                </BarChart>
              ) : (
                <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
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
                  <Tooltip content={<HoursTooltip />} isAnimationActive={false} />
                  {/* In line mode the targets are the point, so each one gets a rule it
                      can be read against. */}
                  {targets.map((target) => (
                    <ReferenceLine
                      key={`rule-${target.category}`}
                      y={target.secondsPerDay / 3600}
                      stroke={categoryColor(target.category)}
                      strokeDasharray="4 4"
                      strokeOpacity={0.7}
                    />
                  ))}
                  {(targets.length > 0
                    ? targets.map((target) => target.category)
                    : categories
                  ).map((category) => (
                    <Line
                      key={category}
                      type="monotone"
                      dataKey={category}
                      stroke={categoryColor(category)}
                      strokeWidth={2}
                      dot={false}
                    />
                  ))}
                </LineChart>
              )}
            </ResponsiveContainer>
          </div>
        )}

        {categories.length > 0 && (
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

      <div className="shrink-0">
        <TargetsPanel />
      </div>
    </>
  );
}

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
        <span className="font-mono text-mini tabular-nums text-ink-soft">
          {formatDuration(total * 3600)}
        </span>
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
