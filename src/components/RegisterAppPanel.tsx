import { useState } from "react";
import { Plus } from "lucide-react";

import { registerApp } from "../lib/ipc";
import { formatDuration } from "../lib/time";
import { CATEGORIES, type Category, type UnmappedProcess } from "../lib/types";

interface Props {
  unmapped: UnmappedProcess[];
  onRegistered: () => void;
}

/** The Discord-style part: anything seen but unrecognised can be mapped in one click,
 *  from the list of things actually running rather than a blank text box. */
export function RegisterAppPanel({ unmapped, onRegistered }: Props) {
  const [pending, setPending] = useState<string | null>(null);
  const [choices, setChoices] = useState<Record<string, Category>>({});
  const [error, setError] = useState<string | null>(null);

  if (unmapped.length === 0) return null;

  const register = async (entry: UnmappedProcess) => {
    const category = choices[entry.processName] ?? "Productivity";
    setPending(entry.processName);
    setError(null);
    try {
      await registerApp({
        matchType: "exe",
        pattern: entry.processName,
        displayName: entry.appName || entry.processName,
        category,
      });
      onRegistered();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="rounded-2xl border border-edge bg-surface p-6">
      <h2 className="text-[11px] font-semibold tracking-widest text-ink-soft uppercase">
        Unrecognised apps
      </h2>
      <p className="mt-1 text-xs text-ink-mute">
        These were tracked as Neutral. Give them a category and Nudgy will remember.
      </p>

      {error && <p className="mt-3 text-xs text-bad">{error}</p>}

      <ul className="mt-4 space-y-2">
        {unmapped.slice(0, 10).map((entry) => (
          <li
            key={entry.processName}
            className="flex flex-wrap items-center gap-3 rounded-xl bg-canvas px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm text-ink">{entry.appName}</div>
              <div className="truncate font-mono text-xs text-ink-mute">{entry.processName}</div>
            </div>

            <span className="font-mono text-xs tabular-nums text-ink-mute">
              {formatDuration(entry.seconds)}
            </span>

            <select
              value={choices[entry.processName] ?? "Productivity"}
              onChange={(event) =>
                setChoices((previous) => ({
                  ...previous,
                  [entry.processName]: event.target.value as Category,
                }))
              }
              className="rounded-lg border border-edge bg-surface px-2.5 py-1.5 text-xs text-ink-soft outline-none focus:border-edge-strong"
            >
              {CATEGORIES.filter((category) => category !== "Idle").map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>

            <button
              type="button"
              disabled={pending === entry.processName}
              onClick={() => void register(entry)}
              className="flex items-center gap-1.5 rounded-lg bg-rose-wash px-3 py-1.5 text-xs font-medium text-rose-deep transition hover:bg-edge-strong disabled:opacity-50"
            >
              <Plus size={13} />
              Map
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
