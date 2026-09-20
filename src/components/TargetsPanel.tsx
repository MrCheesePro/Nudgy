import { useMemo, useState } from "react";
import { Check, Flame, Plus, X } from "lucide-react";

import { useProgress } from "../hooks/useProgress";
import { categoryColor, useAssignableCategories } from "../lib/categories";
import { quoteForDay } from "../lib/quotes";
import { formatDuration } from "../lib/time";
import type { CategoryTarget } from "../lib/types";
import {
  dayKey,
  resolveTargetCategory,
  secondsOn,
  streakHeat,
  streakOf,
  type DaySeries,
} from "../services/progress";

/**
 * Targets, on the page where today's numbers are.
 *
 * It lives under "Tracked today" and "Where the time went" because it answers the same
 * question they do — how is today going — where the Progress page answers the longer one.
 * The data comes from the same hook either way, so the two never disagree.
 */
export function TargetsPanel() {
  const { series, full, targets, saveTarget, removeTarget } = useProgress(7);
  return (
    <TargetsSection
      targets={targets}
      series={series}
      full={full}
      onSave={saveTarget}
      onRemove={removeTarget}
    />
  );
}

interface TargetsProps {
  targets: CategoryTarget[];
  series: DaySeries[];
  /** The long history, so a streak is not capped by the chart's window. */
  full: DaySeries[];
  onSave: (
    category: string,
    direction: "at_least" | "at_most",
    secondsPerDay: number,
  ) => Promise<void>;
  onRemove: (category: string) => Promise<void>;
}

function TargetsSection({ targets, series, full, onSave, onRemove }: TargetsProps) {
  const categories = useAssignableCategories();
  const [category, setCategory] = useState("");
  const [direction, setDirection] = useState<"at_least" | "at_most">("at_least");
  const [hours, setHours] = useState("2");
  const [minutes, setMinutes] = useState("0");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Stable for the whole day, so it reads as a thought rather than a slot machine.
  const quote = useMemo(() => quoteForDay(dayKey(new Date())), []);

  const untargeted = categories.filter(
    (entry) => !targets.some((target) => target.category === entry.name),
  );

  /** Non-null while editing: the category whose row loaded the form. */
  const [editing, setEditing] = useState<string | null>(null);

  /** Loads an existing target into the form below, which then updates instead of adds. */
  const edit = (target: CategoryTarget) => {
    setEditing(target.category);
    setCategory(target.category);
    setDirection(target.direction);
    setHours(String(Math.floor(target.secondsPerDay / 3600)));
    setMinutes(String(Math.round((target.secondsPerDay % 3600) / 60)));
  };

  const cancelEdit = () => {
    setEditing(null);
    setCategory("");
  };

  // One source for both the submit and the select's value, so what is shown and what is
  // saved cannot drift apart. See `resolveTargetCategory` for the bug this closes.
  const chosenCategory = resolveTargetCategory(editing, category, untargeted);

  const submit = async () => {
    const chosen = chosenCategory;
    // Undefined only when every category already has a target, which also disables the
    // button — this stays as the clean no-op rather than the path that holds it up.
    if (!chosen) return;
    const seconds = Number(hours) * 3600 + Number(minutes) * 60;
    setBusy(true);
    setFailure(null);
    try {
      await onSave(chosen, direction, seconds);
      setEditing(null);
      setCategory("");
    } catch (cause) {
      setFailure(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-edge bg-surface px-5 py-4">
      <h2 className="text-[11px] font-semibold tracking-widest text-ink-soft uppercase">
        Targets
      </h2>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-soft italic">
        “{quote.text}”{" "}
        <span className="text-[11px] not-italic text-ink-mute">— {quote.film}</span>
      </p>

      {failure && <p className="mt-3 text-xs text-bad">{failure}</p>}

      {targets.length > 0 && (
        <ul className="mt-3 grid gap-1.5 xl:grid-cols-2">
          {targets.map((target) => (
            <TargetCard
              key={target.category}
              target={target}
              series={series}
              full={full}
              selected={editing === target.category}
              onEdit={() => edit(target)}
              onRemove={() => void onRemove(target.category)}
            />
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-edge pt-3">
        <select
          value={chosenCategory ?? ""}
          disabled={editing !== null || untargeted.length === 0}
          onChange={(event) => setCategory(event.target.value)}
          className="rounded-lg border border-edge bg-canvas px-2.5 py-1.5 text-xs text-ink-soft outline-none focus:border-edge-strong disabled:opacity-60"
        >
          {editing !== null ? (
            <option value={editing}>{editing}</option>
          ) : (
            untargeted.map((entry) => (
              <option key={entry.id} value={entry.name}>
                {entry.name}
              </option>
            ))
          )}
        </select>

        <select
          value={direction}
          onChange={(event) => setDirection(event.target.value as "at_least" | "at_most")}
          className="rounded-lg border border-edge bg-canvas px-2.5 py-1.5 text-xs text-ink-soft outline-none focus:border-edge-strong"
        >
          <option value="at_least">at least</option>
          <option value="at_most">at most</option>
        </select>

        <label className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            max={23}
            value={hours}
            onChange={(event) => setHours(event.target.value)}
            aria-label="Hours"
            className="w-12 rounded-lg border border-edge bg-canvas px-2 py-1.5 text-right font-mono text-xs tabular-nums text-ink-soft outline-none focus:border-edge-strong"
          />
          <span className="text-[11px] text-ink-mute">h</span>
        </label>
        <label className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            max={59}
            step={5}
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            aria-label="Minutes"
            className="w-12 rounded-lg border border-edge bg-canvas px-2 py-1.5 text-right font-mono text-xs tabular-nums text-ink-soft outline-none focus:border-edge-strong"
          />
          <span className="text-[11px] text-ink-mute">m a day</span>
        </label>

        <button
          type="button"
          disabled={busy || (editing === null && untargeted.length === 0)}
          onClick={() => void submit()}
          className="flex items-center gap-1.5 rounded-lg bg-rose-wash px-3 py-1.5 text-xs font-medium text-rose-deep transition hover:bg-edge-strong disabled:opacity-40"
        >
          {editing === null ? <Plus size={13} /> : <Check size={13} />}
          {editing === null ? "Set" : "Update"}
        </button>
        {editing !== null && (
          <button
            type="button"
            onClick={cancelEdit}
            className="text-[11px] text-ink-mute transition hover:text-ink-soft"
          >
            Cancel
          </button>
        )}
      </div>
    </section>
  );
}

function TargetCard({
  target,
  series,
  full,
  selected,
  onEdit,
  onRemove,
}: {
  target: CategoryTarget;
  series: DaySeries[];
  full: DaySeries[];
  selected: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const color = categoryColor(target.category);
  const today = series[series.length - 1];
  const todaySeconds = today ? secondsOn(today, target.category) : 0;
  const state = streakOf(full, target);
  const run = state.days;

  const floor = target.direction === "at_least";
  const met = floor
    ? todaySeconds >= target.secondsPerDay
    : todaySeconds <= target.secondsPerDay;
  const fraction = Math.min(1, todaySeconds / Math.max(1, target.secondsPerDay));

  return (
    // One line, not a card. Targets are a reference while you read the chart above, and
    // a grid of tall boxes was taking the height the chart needed to be readable at all.
    // While a row is loaded into the form below, it says so — otherwise "Update" is a
    // button with no visible subject.
    <li
      className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5 transition ${
        selected
          ? "border-rose-deep bg-rose-wash ring-1 ring-rose-deep/30"
          : "border-edge bg-canvas"
      }`}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <button
        type="button"
        onClick={onEdit}
        title="Edit this target"
        className="w-24 shrink-0 truncate text-left text-xs font-semibold text-ink transition hover:text-rose-deep"
      >
        {target.category}
      </button>

      <span className="min-w-0 flex-1">
        <span className="block h-1.5 overflow-hidden rounded-full bg-surface-sunken">
          <span
            className="block h-full rounded-full transition-[width] duration-500"
            style={{
              width: `${Math.max(2, fraction * 100)}%`,
              // Under a ceiling, filling the bar is the bad outcome.
              background: met ? color : floor ? "var(--color-edge-strong)" : "#d9736f",
            }}
          />
        </span>
      </span>

      <span className="shrink-0 font-mono text-[11px] tabular-nums text-ink-soft">
        {formatDuration(todaySeconds)}
        <span className="text-ink-mute">
          {" / "}
          {formatDuration(target.secondsPerDay)}
        </span>
      </span>

      <span
        className="flex w-9 shrink-0 items-center justify-end gap-0.5 text-[11px] font-medium text-rose-deep"
        style={{ opacity: streakHeat(run, state.lit) }}
        title={
          run === 0
            ? "No streak yet"
            : state.lit
              ? `${run} days — today is done`
              : `${run} days — not yet today, keep it alive`
        }
      >
        <Flame size={10} />
        {run}
      </span>

      <button
        type="button"
        aria-label={`Remove the ${target.category} target`}
        onClick={onRemove}
        className="shrink-0 rounded p-0.5 text-ink-mute transition hover:text-bad"
      >
        <X size={12} />
      </button>
    </li>
  );
}


