import { CalendarDays, LayoutGrid, Settings, Sparkles, Zap } from "lucide-react";

export type View = "overview" | "timeline" | "apps";

interface Props {
  view: View;
  onChange: (view: View) => void;
  onOpenSettings: () => void;
}

const ITEMS: { id: View; icon: typeof LayoutGrid; label: string }[] = [
  { id: "overview", icon: LayoutGrid, label: "Overview" },
  { id: "timeline", icon: CalendarDays, label: "Timeline Planner" },
  { id: "apps", icon: Sparkles, label: "App registry" },
];

export function IconRail({ view, onChange, onOpenSettings }: Props) {
  return (
    <nav className="flex w-16 shrink-0 flex-col items-center gap-1 border-r border-edge bg-surface py-4">
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl bg-rose text-white">
        <Zap size={17} strokeWidth={2.4} />
      </div>

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
        title="Settings"
        aria-label="Settings"
        onClick={onOpenSettings}
        className="mt-auto flex h-10 w-10 items-center justify-center rounded-xl text-ink-mute transition hover:bg-surface-sunken hover:text-ink-soft"
      >
        <Settings size={18} />
      </button>
    </nav>
  );
}
