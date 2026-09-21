import { Bell, BellOff, Pause, Play } from "lucide-react";

import { IS_MAC, TRAFFIC_LIGHTS_WIDTH } from "../../lib/platform";
import type { View } from "./IconRail";

const VIEW_TITLES: Record<View, string> = {
  overview: "Today",
  timeline: "Planner",
  progress: "Progress",
  apps: "App Registry",
};

interface Props {
  view: View;
  paused: boolean;
  onTogglePause: () => void;
  alerts: number;
  /** Only on pages with a layout worth editing, so the button is absent elsewhere. */
  notifications: boolean;
  onToggleNotifications: () => void;
  onOpenSettings: () => void;
  /** Course code of the block running right now, if any. */
  trackingLabel?: string | null;
}

export function TopBar({
  view,
  paused,
  onTogglePause,
  alerts,
  notifications,
  onToggleNotifications,
  onOpenSettings,
  trackingLabel,
}: Props) {
  return (
    /*
     * The window's own title bar, furnished.
     *
     * On macOS the title bar is set to `Overlay`, so the close/minimise/zoom buttons are
     * drawn over this strip and the page runs the full height of the window. The padding
     * on the left is the space they occupy: it is the app's job to leave it, because the
     * buttons are drawn over whatever is there rather than pushing it aside.
     *
     * `data-tauri-drag-region` puts back the one thing a title bar was doing that nothing
     * else does — dragging the window. It is on the header and on the breadcrumb, and on
     * nothing that can be clicked, since a drag region swallows the click.
     */
    <header
      data-tauri-drag-region
      className="flex h-12 shrink-0 items-center gap-3 border-b border-edge bg-surface px-5"
      style={IS_MAC ? { paddingLeft: TRAFFIC_LIGHTS_WIDTH } : undefined}
    >
      <div
        data-tauri-drag-region
        className="mr-auto flex min-w-0 items-center gap-2 text-sm"
      >
        <span className="text-ink-mute">Nudgy</span>
        <span className="text-ink-mute">·</span>
        <span className="font-medium text-ink">{VIEW_TITLES[view]}</span>
      </div>

      {/* Stands in for the mockup's "Synced" pill — here it reports whether the
          watcher is actually running, which is the thing worth glancing at. */}
      <button
        type="button"
        onClick={onTogglePause}
        className="flex shrink-0 items-center gap-1.5 rounded-full border border-edge bg-surface px-3 py-1 text-mini font-medium text-ink-soft transition hover:border-edge-strong"
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


      {/* A switch, not a tray. There is nothing to read in a notification list you have
          already seen as a notification — the only question worth a button here is
          whether you want them at all. */}
      <button
        type="button"
        aria-label={notifications ? "Notifications on" : "Notifications off"}
        aria-pressed={notifications}
        title={
          notifications
            ? "Notifications on — click to silence"
            : "Notifications off — click to turn on"
        }
        onClick={onToggleNotifications}
        className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition ${
          notifications
            ? "border-edge bg-rose-wash text-rose-deep hover:border-edge-strong"
            : "border-edge text-ink-mute hover:border-edge-strong"
        }`}
      >
        {notifications ? <Bell size={13} /> : <BellOff size={13} />}
        {/* A permission the app needs is worth a dot whether or not chimes are on. */}
        {alerts > 0 && (
          <span className="absolute top-1.5 right-2 h-1.5 w-1.5 rounded-full bg-bad" />
        )}
      </button>

      <button
        type="button"
        aria-label="Settings"
        onClick={onOpenSettings}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-rose-wash text-tiny font-semibold text-rose-deep transition hover:bg-edge-strong"
      >
        NU
      </button>
    </header>
  );
}
