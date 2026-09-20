import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Check, Clock, RotateCw, SkipForward, TriangleAlert, X } from "lucide-react";

import { DAY_END_HOUR, formatClock, formatDuration, parseTimeOfDay } from "../lib/time";
import { categoryColor } from "../lib/categories";
import {
  describeFreeTime,
  explainNoSlots,
  nextProposal,
  relativeDayLabel,
  type QueueItem,
} from "../services/dayPlanner";
import { fitsInSlots, findFreeSlots } from "../services/slotFinder";
import { dayKey, styleTiming, type PlacedBlock, type PlannableDay } from "../services/workPlanner";

interface Props {
  open: boolean;
  queue: QueueItem[];
  /** Rebuilt on demand so each proposal sees the calendar as it is now. */
  daysFor: (now: number) => PlannableDay[];
  onClose: (note: string | null) => void;
  onAccept: (item: QueueItem, blocks: PlacedBlock[]) => Promise<void>;
}

const SESSION_MINUTES = 45;
const BREAK_MINUTES = 5;

/**
 * "Here is when you are free — does this slot work?"
 *
 * Deterministic from end to end: the gaps come from the calendar and the timeline, the
 * placement from `placeWork`, and nothing reaches SQLite until the answer is yes. Skipping
 * costs nothing, so the safe answer is always available.
 */
export function GeneratePlanDialog({ open, queue, daysFor, onClose, onAccept }: Props) {
  const [index, setIndex] = useState(0);
  /** Walks forward every time the user asks for a different slot. */
  const [after, setAfter] = useState<number | null>(null);
  /** Blocks agreed to in this run — the next item must not be offered the same gap. */
  const [accepted, setAccepted] = useState<PlacedBlock[]>([]);
  const [placedCount, setPlacedCount] = useState(0);
  const [pickingTime, setPickingTime] = useState(false);
  const [startDay, setStartDay] = useState<string | null>(null);
  const [startTime, setStartTime] = useState("");
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (!open) return;
    setIndex(0);
    setAfter(null);
    setAccepted([]);
    setPlacedCount(0);
    setPickingTime(false);
    setStartDay(null);
    setStartTime("");
    setNow(Math.floor(Date.now() / 1000));
  }, [open]);

  const finish = useCallback(() => {
    onClose(
      placedCount === 0
        ? null
        : `${placedCount} ${placedCount === 1 ? "plan" : "plans"} scheduled.`,
    );
  }, [onClose, placedCount]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, finish]);

  const item = queue[index] ?? null;
  const timing = styleTiming("custom", SESSION_MINUTES, BREAK_MINUTES);

  const days = useMemo(() => (open ? daysFor(now) : []), [open, daysFor, now]);

  const minutesOfDay = useMemo(() => parseTimeOfDay(startTime), [startTime]);
  const timeIsBad = startTime.trim().length > 0 && minutesOfDay === null;

  /** An explicit "start at 2pm on Thursday", once both halves have been given. */
  const requestedStart = useMemo(() => {
    if (!startDay || minutesOfDay === null) return null;
    const [year, month, day] = startDay.split("-").map(Number);
    return Math.floor(new Date(year, month - 1, day, 0, minutesOfDay, 0, 0).getTime() / 1000);
  }, [startDay, minutesOfDay]);

  const placement = useMemo(() => {
    if (!item) return null;
    return nextProposal({
      item,
      days,
      mode: "pomodoro",
      focusSeconds: timing.session * 60,
      breakSeconds: timing.break * 60,
      after: requestedStart ?? after,
      acceptedInSession: accepted,
      now,
    });
  }, [item, days, timing.session, timing.break, requestedStart, after, accepted, now]);

  /** Why an explicitly requested time cannot be used — named, not just refused. */
  const conflict = useMemo(() => {
    if (!item || requestedStart === null) return null;

    const day = days.find((entry) => entry.key === dayKey(new Date(requestedStart * 1000)));
    if (!day) return "That time is outside the planning window.";
    // The window itself is the answer when the request falls outside the usable day.
    if (requestedStart < day.startTs) {
      return `That is before the planning window opens (${formatClock(day.startTs)}).`;
    }
    if (requestedStart >= day.endTs) {
      return `That is after the day ends (${String(DAY_END_HOUR).padStart(2, "0")}:00).`;
    }

    const length = timing.session * 60;
    const free = findFreeSlots({
      now: day.startTs,
      dayEnd: day.endTs,
      commitments: day.commitments,
      minSlotSeconds: 60,
    });
    if (fitsInSlots({ startTs: requestedStart, endTs: requestedStart + length }, free)) return null;

    const clash = day.commitments.find(
      (entry) => requestedStart < entry.endTs && entry.startTs < requestedStart + length,
    );
    return clash
      ? `That overlaps “${clash.label}” (${formatClock(clash.startTs)}–${formatClock(clash.endTs)}).`
      : "Nothing is free at that time.";
  }, [item, requestedStart, days, timing.session]);

  const blocks = placement?.blocks ?? [];
  const freeLabels = useMemo(() => describeFreeTime(days), [days]);

  const advance = useCallback(() => {
    setAfter(null);
    setPickingTime(false);
    setStartDay(null);
    setStartTime("");
    setIndex((current) => current + 1);
  }, []);

  const accept = async () => {
    if (!item || blocks.length === 0 || conflict !== null) return;
    setSaving(true);
    try {
      await onAccept(item, blocks);
      setAccepted((current) => [...current, ...blocks]);
      setPlacedCount((current) => current + 1);
      advance();
    } finally {
      setSaving(false);
    }
  };

  /** Push the search past the current proposal, so "another slot" always moves. */
  const tryAnother = () => {
    const start = blocks[0]?.startTs;
    if (start === undefined) return;
    setStartDay(null);
    setStartTime("");
    setAfter(Math.max(now, start + 60));
  };

  if (!open) return null;

  return (
    <div
      className="scroll-area fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-8 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) finish();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-edge bg-surface p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-ink">Plan your week</h2>
            <p className="mt-0.5 text-xs text-ink-mute">
              Worked out from your calendar and what is already on the timeline. Nothing is
              saved until you say so.
            </p>
          </div>
          <button
            type="button"
            onClick={finish}
            aria-label="Close"
            className="rounded-lg p-1 text-ink-mute transition hover:bg-canvas hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 rounded-xl border border-edge bg-canvas px-3 py-2.5">
          <span className="text-[0.6875rem] font-medium tracking-wide text-ink-soft">
            Free from here on
          </span>
          <p className="mt-1 text-xs text-ink-mute">
            {freeLabels.length > 0 ? freeLabels.join(" · ") : "Nothing free in the next few days."}
          </p>
        </div>

        {item === null ? (
          <div className="mt-6 rounded-xl border border-edge bg-canvas px-4 py-8 text-center">
            <p className="text-sm text-ink-soft">
              {queue.length === 0
                ? "Everything with a deadline is already planned."
                : placedCount > 0
                  ? `${placedCount} ${placedCount === 1 ? "plan" : "plans"} scheduled.`
                  : "Nothing left to ask about."}
            </p>
            <button
              type="button"
              onClick={finish}
              className="mt-4 rounded-lg bg-rose px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-deep"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="mt-5 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-base font-semibold text-ink">{item.title}</h3>
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-mute">
                  <span
                    className="rounded-full px-2 py-0.5 font-medium"
                    style={{
                      background: `${categoryColor(item.category)}1f`,
                      color: categoryColor(item.category),
                    }}
                  >
                    {item.subtitle ?? item.category}
                  </span>
                  {formatDuration(item.estimateSeconds)} ·{" "}
                  {item.dueAt === null
                    ? "no due date"
                    : `due ${relativeDayLabel(item.dueAt)} ${formatClock(item.dueAt)}`}
                </p>
              </div>
              <span className="shrink-0 font-mono text-[0.6875rem] text-ink-mute">
                {index + 1} of {queue.length}
              </span>
            </div>

            <div className="mt-4 rounded-xl border border-edge bg-canvas p-3">
              <div className="flex items-baseline justify-between">
                <span className="flex items-center gap-1.5 text-xs font-medium text-ink-soft">
                  <CalendarClock size={13} /> Proposed
                </span>
                <span className="text-xs text-ink-mute">
                  {blocks.length} {blocks.length === 1 ? "session" : "sessions"} ·{" "}
                  {formatDuration(placement?.placedSeconds ?? 0)}
                </span>
              </div>

              {blocks.length === 0 ? (
                <p className="py-4 text-center text-xs text-warn">
                  {explainNoSlots(days, item, placement, now)}
                </p>
              ) : (
                <ul className="scroll-area mt-2 max-h-36 space-y-1">
                  {blocks.map((block) => (
                    <li
                      key={`${block.day}-${block.startTs}`}
                      className="flex items-center justify-between gap-3 text-xs"
                    >
                      <span className="text-ink-soft">{relativeDayLabel(block.startTs)}</span>
                      <span className="font-mono text-ink">
                        {formatClock(block.startTs)} – {formatClock(block.endTs)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {placement && placement.overdue && blocks.length > 0 && (
                <p className="mt-2 text-[0.6875rem] text-warn">{placement.reason}</p>
              )}
              {placement && placement.shortfallSeconds > 0 && blocks.length > 0 && (
                <p className="mt-2 text-[0.6875rem] text-warn">
                  {formatDuration(placement.shortfallSeconds)} could not fit.
                </p>
              )}
            </div>

            {pickingTime && (
              <div className="mt-3 rounded-xl border border-edge bg-canvas p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  {days.map((day, position) => (
                    <button
                      key={day.key}
                      type="button"
                      onClick={() => setStartDay(day.key)}
                      className={`rounded-lg border px-2.5 py-1.5 text-xs transition ${
                        startDay === day.key
                          ? "border-edge-strong bg-rose-wash text-rose-deep"
                          : "border-edge text-ink-mute hover:text-ink-soft"
                      }`}
                    >
                      {position === 0
                        ? "Today"
                        : position === 1
                          ? "Tomorrow"
                          : relativeDayLabel(day.startTs)}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    autoFocus
                    value={startTime}
                    onChange={(event) => setStartTime(event.target.value)}
                    placeholder="2pm"
                    aria-label="Start time"
                    className={`w-28 rounded-lg border bg-surface px-3 py-2 text-sm text-ink outline-none transition select-text placeholder:text-ink-mute ${
                      timeIsBad ? "border-warn" : "border-edge focus:border-edge-strong"
                    }`}
                  />
                  <span className="text-xs text-ink-mute">
                    {timeIsBad ? "Try 2pm, 2:30pm or 14:30." : "Pick a day, or leave it blank."}
                  </span>
                </div>
              </div>
            )}

            {conflict && (
              <p className="mt-3 flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
                <TriangleAlert size={13} className="mt-0.5 shrink-0" />
                {conflict}
              </p>
            )}

            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={advance}
                className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-ink-mute transition hover:text-ink"
              >
                <SkipForward size={13} /> Skip
              </button>
              <button
                type="button"
                onClick={() => setPickingTime((current) => !current)}
                className="flex items-center gap-1.5 rounded-lg border border-edge px-3 py-2 text-sm text-ink-soft transition hover:border-edge-strong"
              >
                <Clock size={13} /> Pick a time
              </button>
              <button
                type="button"
                onClick={tryAnother}
                disabled={blocks.length === 0}
                className="flex items-center gap-1.5 rounded-lg border border-edge px-3 py-2 text-sm text-ink-soft transition hover:border-edge-strong disabled:opacity-40"
              >
                <RotateCw size={13} /> Another slot
              </button>
              <button
                type="button"
                onClick={() => void accept()}
                disabled={blocks.length === 0 || conflict !== null || saving}
                className="flex items-center gap-1.5 rounded-lg bg-rose px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-deep disabled:opacity-40"
              >
                <Check size={14} /> {saving ? "Saving…" : "Looks good"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
