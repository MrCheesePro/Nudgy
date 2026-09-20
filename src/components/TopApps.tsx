import { formatDuration } from "../lib/time";
import { CATEGORY_COLORS, type AppTotal } from "../lib/types";

interface Props {
  apps: AppTotal[];
}

export function TopApps({ apps }: Props) {
  const max = apps.reduce((peak, entry) => Math.max(peak, entry.seconds), 0);

  return (
    <section className="rounded-2xl border border-edge bg-surface p-6">
      <h2 className="text-[11px] font-semibold tracking-widest text-ink-soft uppercase">
        Where the time went
      </h2>

      {apps.length === 0 ? (
        <p className="py-10 text-center text-sm text-ink-mute">No active time recorded yet.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {apps.map((entry) => (
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
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
