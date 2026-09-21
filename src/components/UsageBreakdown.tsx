import { useCallback, useRef, useState } from "react";
import { Cell, Pie, PieChart } from "recharts";

import { formatDuration } from "../lib/time";
import { categoryColor } from "../lib/categories";
import type { UsageBreakdown as Breakdown } from "../lib/types";

interface Props {
  breakdown: Breakdown | null;
}

/**
 * Below this the total in the middle of the ring is dropped.
 *
 * It is the one thing still competing with the circle for space, and it is already in
 * the header as active plus idle, so it goes first when the panel gets small.
 */
const ROOM_FOR_TOTAL = { width: 220, height: 200 };

/** Ring to box edge. The circle is the whole chart now, so this is only breathing room. */
const RING_MARGIN = 10;

/** The ring is never smaller than this, whatever the panel does. */
const MIN_RADIUS = 26;

export function UsageBreakdown({ breakdown }: Props) {
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
  const roomForTotal =
    box.width >= ROOM_FOR_TOTAL.width && box.height >= ROOM_FOR_TOTAL.height;

  // The circle takes what the box gives it. Nothing is placed outside the ring any more,
  // so the only margin it owes is breathing room.
  const half = Math.min(box.width, box.height) / 2;
  const outerRadius = Math.max(MIN_RADIUS, half - RING_MARGIN);
  const innerRadius = outerRadius * 0.66;

  const slices = (breakdown?.categories ?? []).filter((entry) => entry.seconds > 0);
  const total = breakdown?.totalSeconds ?? 0;

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
                  // No labels on the chart itself. Leader lines from six wedges converge
                  // on the same few pixels and produce a tangle that names nothing; the
                  // legend under the ring says the same thing in a straight line.
                  label={false}
                  labelLine={false}
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
            {roomForTotal && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="font-mono text-xl tabular-nums text-ink">
                  {formatDuration(total)}
                </span>
                <span className="text-xs text-ink-mute">tracked</span>
              </div>
            )}
          </div>

          {/* Every category, in one line under the chart. A swatch and a percentage in
              reading order beats six labels pointing inward from six angles — and a 1%
              sliver gets the same legible row as a 40% wedge, which a label on the ring
              could never give it. */}
          <ul className="mt-3 flex shrink-0 flex-wrap justify-center gap-x-4 gap-y-1.5">
            {slices.map((entry) => (
              <li
                key={entry.category}
                className="flex items-center gap-1.5 text-mini text-ink-soft"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: categoryColor(entry.category) }}
                />
                {entry.category}
                <span className="font-mono tabular-nums text-ink-mute">
                  {total > 0 ? Math.round((entry.seconds / total) * 100) : 0}%
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
