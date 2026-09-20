import { useMemo } from "react";

import { formatDuration } from "../lib/time";
import { CATEGORY_COLORS, type AppTotal, type Category } from "../lib/types";

interface Props {
  apps: AppTotal[];
}

interface CategoryGroup {
  category: Category;
  seconds: number;
  rows: AppTotal[];
}

/**
 * Where the time went, by category first.
 *
 * An app is not an answer on its own — Chrome on Canvas and Chrome on YouTube are
 * different kinds of hour, and the registry has already decided which is which. So the
 * category leads and the things inside it explain the number.
 */
export function TopApps({ apps }: Props) {
  const groups = useMemo<CategoryGroup[]>(() => {
    const byCategory = new Map<Category, CategoryGroup>();

    for (const entry of apps) {
      const group = byCategory.get(entry.category) ?? {
        category: entry.category,
        seconds: 0,
        rows: [],
      };
      group.seconds += entry.seconds;
      group.rows.push(entry);
      byCategory.set(entry.category, group);
    }

    for (const group of byCategory.values()) {
      group.rows.sort((left, right) => right.seconds - left.seconds);
    }

    return [...byCategory.values()].sort((left, right) => right.seconds - left.seconds);
  }, [apps]);

  const total = groups.reduce((sum, group) => sum + group.seconds, 0);

  return (
    <section className="rounded-2xl border border-edge bg-surface p-6">
      <h2 className="text-[11px] font-semibold tracking-widest text-ink-soft uppercase">
        Where the time went
      </h2>

      {groups.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-mute">No active time recorded yet.</p>
      ) : (
        <ul className="mt-4 space-y-4">
          {groups.map((group) => {
            const color = CATEGORY_COLORS[group.category];

            return (
              <li key={group.category}>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: color }}
                    />
                    {group.category}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-ink">
                    {formatDuration(group.seconds)}
                  </span>
                </div>

                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: total > 0 ? `${Math.max(2, (group.seconds / total) * 100)}%` : "0%",
                      background: color,
                    }}
                  />
                </div>

                <ul className="mt-2 space-y-1 pl-4">
                  {group.rows.map((row) => (
                    <li
                      key={`${row.processName}:${row.context ?? ""}`}
                      className="flex items-baseline justify-between gap-3 text-xs text-ink-soft"
                    >
                      {/* "Google Chrome · YouTube" — the browser plus the site that put
                          this row in this category. */}
                      <span className="truncate">
                        {row.appName}
                        {row.context && (
                          <span className="text-ink-mute"> · {row.context}</span>
                        )}
                      </span>
                      <span className="shrink-0 font-mono tabular-nums text-ink-mute">
                        {formatDuration(row.seconds)}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
