import { CalendarDays, CircleHelp, LayoutGrid, Settings, Sparkles, TrendingUp } from "lucide-react";

export type View = "overview" | "timeline" | "progress" | "apps";

interface Props {
  view: View;
  onChange: (view: View) => void;
  onOpenSettings: () => void;
  onOpenTour: () => void;
}

const ITEMS: { id: View; icon: typeof LayoutGrid; label: string }[] = [
  { id: "overview", icon: LayoutGrid, label: "Overview" },
  { id: "timeline", icon: CalendarDays, label: "Planner" },
  { id: "progress", icon: TrendingUp, label: "Progress" },
  { id: "apps", icon: Sparkles, label: "App registry" },
];

export function IconRail({ view, onChange, onOpenSettings, onOpenTour }: Props) {
  return (
    <nav data-tour="rail" className="flex w-16 shrink-0 flex-col items-center gap-1 border-r border-edge bg-surface py-4">
      {ITEMS.map((item) => {
        const Icon = item.icon;
        const active = view === item.id;
        return (
          <button
            key={item.id}
            type="button"
            title={item.label}
            aria-label={item.label}
            aria-current={active ? "page" : undefined}
            onClick={() => onChange(item.id)}
            className={`flex h-10 w-10 items-center justify-center rounded-xl transition ${
              active
                ? "bg-rose-wash text-rose-deep"
                : "text-ink-mute hover:bg-surface-sunken hover:text-ink-soft"
            }`}
          >
            <Icon size={18} />
          </button>
        );
      })}

      <button
        type="button"
        data-tour="help"
        title="Show the tour"
        aria-label="Show the tour"
        onClick={onOpenTour}
        className="mt-auto flex h-10 w-10 items-center justify-center rounded-xl text-ink-mute transition hover:bg-surface-sunken hover:text-ink-soft"
      >
        <CircleHelp size={18} />
      </button>

      <button
        type="button"
        data-tour="settings"
        title="Settings"
        aria-label="Settings"
        onClick={onOpenSettings}
        className="flex h-10 w-10 items-center justify-center rounded-xl text-ink-mute transition hover:bg-surface-sunken hover:text-ink-soft"
      >
        <Settings size={18} />
      </button>
    </nav>
  );
}
