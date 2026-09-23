import { useEffect, useState } from "react";
import { CalendarPlus, X } from "lucide-react";

import { DateField } from "./DateField";
import { TimeField } from "./TimeField";
import { createEvent } from "../lib/ipc";
import type { Repeat } from "../lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after a save, so the calendar can pick the new event up. */
  onAdded: () => void;
}

/** Suggestions, not a fixed list — the field takes anything typed into it. */
const KINDS = ["Class", "Lab", "Work", "Club", "Travel", "Personal"];

const REPEATS: [Repeat, string][] = [
  ["none", "Does not repeat"],
  ["daily", "Every day"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
];

const DAYS = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * An event you add by hand, and the hours it takes out of the day.
 *
 * Deliberately the same shape as an event from a calendar feed, because it means the same
 * thing: time that is spoken for. The planner treats both identically and will not
 * schedule work over either — which is the whole reason to type one in rather than
 * remember it.
 *
 * Recurrence is asked for as a rule and stored as one. "Every Tuesday and Thursday until
 * December" is a row, not sixty rows, so moving the time later moves all of them.
 */
export function AddEventDialog({ open, onClose, onAdded }: Props) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("");
  const [location, setLocation] = useState("");
  const [date, setDate] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [repeat, setRepeat] = useState<Repeat>("none");
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [until, setUntil] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    // A fresh sheet each time. An event dialog remembering last week's class is a way to
    // create a duplicate by pressing Save twice on different days.
    const today = new Date();
    setTitle("");
    setKind("");
    setLocation("");
    setDate(
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
        today.getDate(),
      ).padStart(2, "0")}`,
    );
    setFrom("");
    setTo("");
    setRepeat("none");
    setWeekdays([]);
    setUntil("");
    setError(null);
  }, [open]);

  if (!open) return null;

  const stamp = (day: string, time: string): number | null => {
    if (!day || !time) return null;
    const [year, month, date_] = day.split("-").map(Number);
    const [hour, minute] = time.split(":").map(Number);
    if (!year || !month || !date_) return null;
    return Math.floor(new Date(year, month - 1, date_, hour, minute, 0, 0).getTime() / 1000);
  };

  const startTs = stamp(date, from);
  const endTs = stamp(date, to);
  const ready = title.trim().length > 0 && startTs !== null && endTs !== null && endTs > startTs;

  const save = async () => {
    if (!ready || startTs === null || endTs === null) return;
    setSaving(true);
    try {
      await createEvent({
        title: title.trim(),
        kind: kind.trim() || null,
        location: location.trim() || null,
        startTs,
        endTs,
        repeat,
        weekdays: repeat === "weekly" ? weekdays : [],
        // The end of the chosen day, so an event on the last day still happens.
        untilTs: repeat === "none" ? null : stamp(until, "23:59"),
      });
      onAdded();
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-6">
      <div className="scroll-area max-h-full w-full max-w-md rounded-2xl border border-edge bg-surface p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <CalendarPlus size={15} />
            Add an event
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 text-ink-mute transition hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        <label className="mt-5 block">
          <span className="text-xs font-medium tracking-wide text-ink-soft">What is it?</span>
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Physics lecture"
            className="mt-1.5 w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-ink outline-none transition select-text focus:border-edge-strong"
          />
        </label>

        <div className="mt-4">
          <span className="text-xs font-medium tracking-wide text-ink-soft">
            Kind <span className="font-normal text-ink-mute">(optional)</span>
          </span>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            {KINDS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setKind(kind === option ? "" : option)}
                className={`rounded-lg border px-2.5 py-1 text-xs transition ${
                  kind === option
                    ? "border-edge-strong bg-rose-wash text-rose-deep"
                    : "border-edge text-ink-mute hover:text-ink-soft"
                }`}
              >
                {option}
              </button>
            ))}
            <input
              value={KINDS.includes(kind) ? "" : kind}
              onChange={(event) => setKind(event.target.value)}
              placeholder="or type one"
              className="min-w-28 flex-1 rounded-lg border border-edge bg-canvas px-2.5 py-1 text-xs text-ink-soft outline-none transition select-text focus:border-edge-strong"
            />
          </div>
        </div>

        <label className="mt-4 block">
          <span className="text-xs font-medium tracking-wide text-ink-soft">
            Where <span className="font-normal text-ink-mute">(optional)</span>
          </span>
          <input
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="Pierce 201"
            className="mt-1.5 w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-ink-soft outline-none transition select-text focus:border-edge-strong"
          />
        </label>

        <div className="mt-4">
          <span className="text-xs font-medium tracking-wide text-ink-soft">When</span>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <DateField value={date} onChange={setDate} label="Date" />
            <TimeField value={from} onChange={setFrom} label="Starts" />
            <span className="text-xs text-ink-mute">to</span>
            <TimeField value={to} onChange={setTo} label="Ends" />
          </div>
        </div>

        <div className="mt-4">
          <span className="text-xs font-medium tracking-wide text-ink-soft">Repeats</span>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {REPEATS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setRepeat(id)}
                className={`rounded-lg border px-2.5 py-1 text-xs transition ${
                  repeat === id
                    ? "border-edge-strong bg-rose-wash text-rose-deep"
                    : "border-edge text-ink-mute hover:text-ink-soft"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Only for a weekly rule. Leaving them all off is not an error — it means the
              day the first one falls on, which is what picking a date and "weekly" said. */}
          {repeat === "weekly" && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {DAYS.map((letter, day) => (
                <button
                  key={day}
                  type="button"
                  aria-pressed={weekdays.includes(day)}
                  onClick={() =>
                    setWeekdays((current) =>
                      current.includes(day)
                        ? current.filter((entry) => entry !== day)
                        : [...current, day],
                    )
                  }
                  className={`h-7 w-7 rounded-full border text-tiny font-semibold transition ${
                    weekdays.includes(day)
                      ? "border-edge-strong bg-rose text-white"
                      : "border-edge text-ink-mute hover:text-ink-soft"
                  }`}
                >
                  {letter}
                </button>
              ))}
            </div>
          )}

          {repeat !== "none" && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-mute">Until</span>
              <DateField value={until} onChange={setUntil} label="Repeat until" />
              {until ? (
                <button
                  type="button"
                  onClick={() => setUntil("")}
                  className="text-mini text-ink-mute transition hover:text-ink-soft"
                >
                  No end
                </button>
              ) : (
                <span className="text-mini text-ink-mute">Leave blank to keep going</span>
              )}
            </div>
          )}
        </div>

        {error && <p className="mt-3 text-xs text-bad">{error}</p>}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-ink-mute transition hover:text-ink-soft"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!ready || saving}
            onClick={() => void save()}
            className="rounded-lg bg-rose px-4 py-2 text-xs font-semibold text-white transition hover:bg-rose-deep disabled:opacity-40"
          >
            Add to calendar
          </button>
        </div>
      </div>
    </div>
  );
}
