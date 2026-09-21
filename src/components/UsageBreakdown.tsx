import { useCallback, useRef, useState } from "react";
import { Cell, Pie, PieChart } from "recharts";

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

/**
 * Below this the chart is a ring and nothing else.
 *
 * The labels sit outside the ring and the total sits inside it, so both are budgeted out
 * of the same space the circle wants. In a small panel that budget runs out, and what you
 * get is not a smaller chart but three sets of words printed over each other. The shape
 * still reads at any size — the proportions are the point, and the numbers are all
 * spelled out again in the panel beside it.
 */
const ROOM_FOR_LABELS = { width: 340, height: 250 };

/** Ring to card edge. Enough for two lines of label and the leader line that points. */
const LABEL_MARGIN = 52;

/** Ring to card edge with no labels to place — just enough not to touch. */
const BARE_MARGIN = 8;

/** The ring is never smaller than this, whatever the panel does. */
const MIN_RADIUS = 26;

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
  /**
   * The chart's own box, measured.
   *
   * The pie is sized in pixels from this rather than handed percentages inside a
   * `ResponsiveContainer`. Percentages made the ring's existence depend on the container
   * resolving a height before the chart first painted, and when it did not the panel drew
   * nothing at all — an empty card, not a small one. A number this component computed
   * itself cannot fail that way.
   */
  const [box, setBox] = useState({ width: 0, height: 0 });

  const observer = useRef<ResizeObserver | null>(null);

  /**
   * A callback ref, not `useRef` plus an effect.
   *
   * The box it measures lives behind the "nothing tracked yet" branch, so on the first
   * render there is no node at all — an effect with an empty dependency list would run
   * once against nothing and never look again, which is how the ring came to be measured
   * as zero and drawn as nothing. A callback ref fires on the mount that actually
   * happens.
   */
  const chart = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBox({ width: Math.floor(width), height: Math.floor(height) });
    });
    observer.current.observe(node);
  }, []);

  const drawable = box.width > 0 && box.height > 0;
  const roomy =
    box.width >= ROOM_FOR_LABELS.width && box.height >= ROOM_FOR_LABELS.height;

  // The circle takes what the box gives it, less the margin its labels need. It only
  // gets smaller when the box does, and it never disappears.
  const half = Math.min(box.width, box.height) / 2;
  const outerRadius = Math.max(MIN_RADIUS, half - (roomy ? LABEL_MARGIN : BARE_MARGIN));
  const innerRadius = outerRadius * 0.7;

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
          fontSize="var(--text-xs)"
          fontWeight={600}
        >
          {name}
        </text>
        <text
          x={x}
          y={y + 9}
          textAnchor={anchor}
          fill="var(--color-ink-mute)"
          fontSize="var(--text-mini)"
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
            fontSize="var(--text-tiny)"
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
        <h2 className="text-mini font-semibold tracking-widest text-ink-soft uppercase">
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
              than a chart sat beside a list saying the same thing twice. */}
          <div ref={chart} className="relative min-h-40 flex-1">
            {drawable && (
              <PieChart width={box.width} height={box.height}>
                <Pie
                  data={slices}
                  dataKey="seconds"
                  nameKey="category"
                  cx="50%"
                  cy="50%"
                  innerRadius={innerRadius}
                  outerRadius={outerRadius}
                  paddingAngle={2}
                  stroke="none"
                  isAnimationActive={false}
                  label={roomy ? renderLabel : false}
                  labelLine={
                    roomy ? { stroke: "var(--color-edge-strong)", strokeWidth: 1 } : false
                  }
                >
                  {slices.map((entry) => (
                    <Cell key={entry.category} fill={categoryColor(entry.category)} />
                  ))}
                </Pie>
              </PieChart>
            )}

            {/* The total is already in the header as active + idle; in the middle of the
                ring it is a nicety, and the first thing to go when the ring needs the
                room. */}
            {roomy && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="font-mono text-xl tabular-nums text-ink">
                  {formatDuration(total)}
                </span>
                <span className="text-xs text-ink-mute">tracked</span>
              </div>
            )}
          </div>

          {roomy && tiny.length > 0 && (
            <ul className="mt-2 flex shrink-0 flex-wrap justify-center gap-x-4 gap-y-1">
              {tiny.map((entry) => (
                <li
                  key={entry.category}
                  className="flex items-center gap-1.5 text-mini text-ink-mute"
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
