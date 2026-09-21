import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

import { formatDuration } from "../lib/time";
import { categoryColor } from "../lib/categories";
import { streakHeat, type StreakState } from "../services/progress";
import type { UsageBreakdown as Breakdown } from "../lib/types";

interface Props {
  breakdown: Breakdown | null;
  /** Streak state per category, for the ones with a target. */
  streaks?: Record<string, StreakState>;
}

/**
 * Below this a slice is thinner than its own label.
 *
 * Leader lines from three 1% slivers converge on the same few pixels and produce a
 * tangle that names nothing. Those categories move to a line under the chart instead —
 * still counted, still visible, just not pretending to point at anything.
 */
const LABEL_THRESHOLD = 0.04;

/** What Recharts hands a custom pie label. */
interface PieLabelProps {
  cx: number;
  cy: number;
  midAngle: number;
  outerRadius: number;
  percent: number;
  name: string;
  value: number;
}

export function UsageBreakdown({ breakdown, streaks }: Props) {
  const slices = (breakdown?.categories ?? []).filter((entry) => entry.seconds > 0);
  const total = breakdown?.totalSeconds ?? 0;
  const tiny = slices.filter(
    (entry) => total > 0 && entry.seconds / total < LABEL_THRESHOLD,
  );

  /**
   * One label per slice, placed on the ring's own angle so the leader line Recharts
   * draws actually points at the wedge it names.
   */
  const renderLabel = (props: unknown) => {
    const { cx, cy, midAngle, outerRadius, percent, name, value } = props as PieLabelProps;
    if (percent < LABEL_THRESHOLD) return null;

    const radians = Math.PI / 180;
    const radius = outerRadius + 20;
    const x = cx + radius * Math.cos(-midAngle * radians);
    const y = cy + radius * Math.sin(-midAngle * radians);
    const anchor = x >= cx ? "start" : "end";
    const state = streaks?.[name];
    const run = state?.days ?? 0;
    const lit = state?.lit ?? false;

    return (
      <g>
        <text
          x={x}
          y={y - 5}
          textAnchor={anchor}
          fill="var(--color-ink)"
          fontSize="0.75rem"
          fontWeight={600}
        >
          {name}
        </text>
        <text
          x={x}
          y={y + 9}
          textAnchor={anchor}
          fill="var(--color-ink-mute)"
          fontSize="0.6875rem"
          fontFamily="var(--font-mono)"
        >
          {`${formatDuration(value)} · ${Math.round(percent * 100)}%`}
        </text>
        {/* Only once there is a streak to report. A line saying "no streak" on every
            slice is six repetitions of nothing, and it crowds the labels that matter. */}
        {run > 0 && (
          <text
            x={x}
            y={y + 22}
            textAnchor={anchor}
            fill="var(--color-rose-deep)"
            fillOpacity={streakHeat(run, lit)}
            fontSize="0.625rem"
            fontWeight={600}
          >
            {lit
              ? `\u25B2 ${run} day${run === 1 ? "" : "s"}`
              : `\u25B3 ${run} day${run === 1 ? "" : "s"} \u2014 not yet today`}
          </text>
        )}
      </g>
    );
  };

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-edge bg-surface p-6">
      <div className="flex shrink-0 items-baseline justify-between">
        <h2 className="text-[0.6875rem] font-semibold tracking-widest text-ink-soft uppercase">
          Tracked today
        </h2>
        <span className="text-xs text-ink-mute">
          {formatDuration(breakdown?.activeSeconds ?? 0)} active ·{" "}
          {formatDuration(breakdown?.idleSeconds ?? 0)} idle
        </span>
      </div>

      {slices.length === 0 ? (
        <p className="py-16 text-center text-sm text-ink-mute">
          Nothing tracked yet today. Leave Nudgy running and this fills in within a minute.
        </p>
      ) : (
        <>
          {/* Centred, with the labels radiating out — the chart is the panel now, rather
              than a chart sat beside a list saying the same thing twice. The radii are
              percentages so the ring shrinks to leave room for its own labels instead of
              pushing them past the edge of the card. */}
          <div className="relative min-h-0 flex-1">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices}
                  dataKey="seconds"
                  nameKey="category"
                  cx="50%"
                  cy="50%"
                  innerRadius="30%"
                  outerRadius="45%"
                  paddingAngle={2}
                  stroke="none"
                  isAnimationActive={false}
                  label={renderLabel}
                  labelLine={{ stroke: "var(--color-edge-strong)", strokeWidth: 1 }}
                >
                  {slices.map((entry) => (
                    <Cell key={entry.category} fill={categoryColor(entry.category)} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>

            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="font-mono text-2xl tabular-nums text-ink">
                {formatDuration(total)}
              </span>
              <span className="text-xs text-ink-mute">tracked</span>
            </div>
          </div>

          {tiny.length > 0 && (
            <ul className="mt-2 flex shrink-0 flex-wrap justify-center gap-x-4 gap-y-1">
              {tiny.map((entry) => (
                <li
                  key={entry.category}
                  className="flex items-center gap-1.5 text-[0.6875rem] text-ink-mute"
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: categoryColor(entry.category) }}
                  />
                  {entry.category}
                  <span className="font-mono tabular-nums">
                    {formatDuration(entry.seconds)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
