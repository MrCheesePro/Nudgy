import { useMemo, useState } from "react";
import { ChevronRight, Flame } from "lucide-react";

import { formatDuration } from "../lib/time";
import { streakHeat, type StreakState } from "../services/progress";
import { categoryColor } from "../lib/categories";
import type { AppTotal, Category } from "../lib/types";

interface Props {
  apps: AppTotal[];
  /** Streak state per category, for the ones with a target. */
  streaks?: Record<string, StreakState>;
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
/** What the flame means, in words, for the tooltip. */
function streakTitle(state: StreakState | undefined): string {
  if (!state || state.days === 0) return "No streak yet";
  if (state.lit) return `${state.days} day${state.days === 1 ? "" : "s"} — today is done`;
  return `${state.days} day${state.days === 1 ? "" : "s"} — not yet today, keep it alive`;
}

export function TopApps({ apps, streaks }: Props) {
  // Collapsed by default. The category totals are the answer to "where did today go";
  // the apps inside are the follow-up question, and showing every one of them by default
  // is what made this panel outgrow the page in the first place.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (category: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });

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
    <section className="flex min-h-0 flex-col rounded-2xl border border-edge bg-surface p-6">
      <h2 className="shrink-0 text-[11px] font-semibold tracking-widest text-ink-soft uppercase">
        Where the time went
      </h2>

      {groups.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-mute">No active time recorded yet.</p>
      ) : (
        <ul className="scroll-area mt-4 min-h-0 flex-1 space-y-3 pr-1">
          {groups.map((group) => {
            const color = categoryColor(group.category);
            const expanded = open.has(group.category);

            return (
              <li key={group.category}>
                <button
                  type="button"
                  onClick={() => toggle(group.category)}
                  aria-expanded={expanded}
                  className="flex w-full items-baseline justify-between gap-4 text-left"
                >
                  <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-ink">
                    <ChevronRight
                      size={13}
                      className={`shrink-0 text-ink-mute transition-transform duration-200 ${
                        expanded ? "rotate-90" : ""
                      }`}
                    />
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: color }}
                    />
                    <span className="truncate">{group.category}</span>
                    <span className="shrink-0 text-xs font-normal text-ink-mute">
                      {group.rows.length}
                    </span>
                    {/* Always present, so a missing flame never has to be read as "no
                        data" rather than "no streak". How lit it is carries the number. */}
                    <span
                      className="flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-rose-deep"
                      style={{
                        opacity: streakHeat(
                          streaks?.[group.category]?.days ?? 0,
                          streaks?.[group.category]?.lit ?? false,
                        ),
                      }}
                      title={streakTitle(streaks?.[group.category])}
                    >
                      <Flame size={10} />
                      {streaks?.[group.category]?.days ?? 0}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-ink">
                    {formatDuration(group.seconds)}
                  </span>
                </button>

                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                  <div
                    className="h-full rounded-full transition-[width] duration-500"
                    style={{
                      width: total > 0 ? `${Math.max(2, (group.seconds / total) * 100)}%` : "0%",
                      background: color,
                    }}
                  />
                </div>

                {/* A grid row animating 0fr → 1fr is the one way to transition to a
                    height nobody measured, so the list slides rather than snapping and
                    the panel never needs a scrollbar of its own. */}
                <div
                  className={`grid transition-all duration-300 ease-out ${
                    expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                  }`}
                >
                  <ul className="mt-2 space-y-1 overflow-hidden pl-7">
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
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
