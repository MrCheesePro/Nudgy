import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { formatDuration } from "../lib/time";
import { CATEGORY_COLORS, type AppTotal, type WindowTotal } from "../lib/types";

interface Props {
  apps: AppTotal[];
  /** Window titles behind the totals. Absent for apps tracked without a title. */
  windows?: WindowTotal[];
}

/** Titles shown before the row has to be expanded. */
const COLLAPSED_TITLES = 3;

export function TopApps({ apps, windows = [] }: Props) {
  const max = apps.reduce((peak, entry) => Math.max(peak, entry.seconds), 0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // "Google Chrome" is not an answer to where the time went — the page is. Titles are
  // already recorded per sample; this only groups them under the app they belong to.
  const titlesFor = useMemo(() => {
    const grouped = new Map<string, WindowTotal[]>();
    for (const entry of windows) {
      const list = grouped.get(entry.processName) ?? [];
      list.push(entry);
      grouped.set(entry.processName, list);
    }
    for (const list of grouped.values()) {
      list.sort((left, right) => right.seconds - left.seconds);
    }
    return grouped;
  }, [windows]);

  const toggle = (processName: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(processName)) next.add(processName);
      return next;
    });

  return (
    <section className="rounded-2xl border border-edge bg-surface p-6">
      <h2 className="text-[11px] font-semibold tracking-widest text-ink-soft uppercase">
        Where the time went
      </h2>

      {apps.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-mute">No active time recorded yet.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {apps.map((entry) => {
            const titles = titlesFor.get(entry.processName) ?? [];
            const isOpen = expanded.has(entry.processName);
            const shown = isOpen ? titles : titles.slice(0, COLLAPSED_TITLES);
            const hidden = titles.length - shown.length;

            return (
              <li key={`${entry.processName}:${entry.category}`}>
                <div className="flex items-baseline justify-between gap-4 text-sm">
                  <span className="truncate text-ink-soft">{entry.appName}</span>
                  <span className="shrink-0 font-mono tabular-nums text-ink">
                    {formatDuration(entry.seconds)}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: max > 0 ? `${Math.max(2, (entry.seconds / max) * 100)}%` : "0%",
                      background: CATEGORY_COLORS[entry.category],
                    }}
                  />
                </div>

                {shown.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 pl-3">
                    {shown.map((window) => (
                      <li
                        key={window.title}
                        className="flex items-baseline justify-between gap-3 text-xs text-ink-mute"
                      >
                        <span className="truncate" title={window.title}>
                          {window.title}
                        </span>
                        <span className="shrink-0 font-mono tabular-nums">
                          {formatDuration(window.seconds)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {(hidden > 0 || isOpen) && (
                  <button
                    type="button"
                    onClick={() => toggle(entry.processName)}
                    className="mt-1 ml-3 flex items-center gap-1 text-[11px] text-ink-mute transition hover:text-ink-soft"
                  >
                    {isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    {isOpen ? "Show less" : `${hidden} more`}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
