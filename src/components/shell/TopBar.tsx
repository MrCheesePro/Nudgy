import { Bell, Pause, Play, Search } from "lucide-react";

import type { View } from "./IconRail";

const VIEW_TITLES: Record<View, string> = {
  overview: "Today",
  timeline: "Timeline Planner",
  apps: "App Registry",
};

interface Props {
  view: View;
  query: string;
  onQuery: (value: string) => void;
  paused: boolean;
  onTogglePause: () => void;
  alerts: number;
  onAlerts: () => void;
  onOpenSettings: () => void;
  /** Course code of the block running right now, if any. */
  trackingLabel?: string | null;
}

export function TopBar({
  view,
  query,
  onQuery,
  paused,
  onTogglePause,
  alerts,
  onAlerts,
  onOpenSettings,
  trackingLabel,
}: Props) {
  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-edge bg-surface px-6">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-ink-mute">Nudgy</span>
        <span className="text-ink-mute">·</span>
        <span className="font-medium text-ink">{VIEW_TITLES[view]}</span>
      </div>

      <div className="relative ml-auto w-full max-w-sm">
        <Search
          size={14}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-mute"
        />
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Search apps, assignments…"
          className="w-full rounded-full border border-edge bg-canvas py-2 pr-10 pl-9 text-sm text-ink outline-none transition select-text placeholder:text-ink-mute focus:border-edge-strong"
        />
        <kbd className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-[10px] text-ink-mute">
          ⌘/
        </kbd>
      </div>

      {/* Stands in for the mockup's "Synced" pill — here it reports whether the
          watcher is actually running, which is the thing worth glancing at. */}
      <button
        type="button"
        onClick={onTogglePause}
        className="flex shrink-0 items-center gap-2 rounded-full border border-edge bg-surface px-3.5 py-1.5 text-xs font-medium text-ink-soft transition hover:border-edge-strong"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${paused ? "" : "live-dot"}`}
          style={{ background: paused ? "var(--color-ink-mute)" : "var(--color-ok)" }}
        />
        {/* The label belongs to the scheduled block, so it holds for the whole block —
            only the dot reports whether the work is actually happening. */}
        {paused ? "Paused" : trackingLabel ? `Tracking · ${trackingLabel}` : "Tracking"}
        {paused ? <Play size={11} /> : <Pause size={11} />}
      </button>

      <button
        type="button"
        aria-label="Alerts"
        onClick={onAlerts}
        className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-edge text-ink-soft transition hover:border-edge-strong"
      >
        <Bell size={15} />
        {alerts > 0 && (
          <span className="absolute top-1.5 right-2 h-1.5 w-1.5 rounded-full bg-bad" />
        )}
      </button>

      <button
        type="button"
        aria-label="Settings"
        onClick={onOpenSettings}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-rose-wash text-xs font-semibold text-rose-deep transition hover:bg-edge-strong"
      >
        NU
      </button>
    </header>
  );
}
