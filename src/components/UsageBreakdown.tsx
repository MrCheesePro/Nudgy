import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

import { formatDuration } from "../lib/time";
import { CATEGORY_COLORS, type UsageBreakdown as Breakdown } from "../lib/types";

interface Props {
  breakdown: Breakdown | null;
}

export function UsageBreakdown({ breakdown }: Props) {
  const slices = (breakdown?.categories ?? []).filter((entry) => entry.seconds > 0);
  const total = breakdown?.totalSeconds ?? 0;

  return (
    <section className="rounded-2xl border border-edge bg-surface p-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[11px] font-semibold tracking-widest text-ink-soft uppercase">
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
        <div className="mt-4 flex flex-wrap items-center gap-8">
          <div className="relative h-52 w-52 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices}
                  dataKey="seconds"
                  nameKey="category"
                  innerRadius="68%"
                  outerRadius="100%"
                  paddingAngle={2}
                  stroke="none"
                  isAnimationActive={false}
                >
                  {slices.map((entry) => (
                    <Cell key={entry.category} fill={CATEGORY_COLORS[entry.category]} />
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

          <ul className="min-w-56 flex-1 space-y-2">
            {slices.map((entry) => {
              const share = total > 0 ? Math.round((entry.seconds / total) * 100) : 0;
              return (
                <li key={entry.category} className="flex items-center gap-3 text-sm">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={{ background: CATEGORY_COLORS[entry.category] }}
                  />
                  <span className="flex-1 text-ink-soft">{entry.category}</span>
                  <span className="font-mono tabular-nums text-ink">
                    {formatDuration(entry.seconds)}
                  </span>
                  <span className="w-9 text-right font-mono text-xs tabular-nums text-ink-mute">
                    {share}%
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
