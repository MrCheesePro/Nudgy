import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Timer, TriangleAlert, X } from "lucide-react";

import { clearPref, readPref, writePref } from "../lib/prefs";
import { formatClock, formatDuration, parseTimeOfDay } from "../lib/time";
import { categoryColor } from "../lib/categories";
import type { Category } from "../lib/types";
import { findFreeSlots, fitsInSlots, type Commitment } from "../services/slotFinder";
import {
  dayKey,
  placeWork,
  plannableDays,
  styleTiming,
  type PlacedBlock,
  type PlanMode,
  type PomodoroStyle,
} from "../services/workPlanner";

/** Anything that can be planned: a Canvas assignment or a goal the user typed. */
/** A dialog left half-filled. Restored next time the same item is opened. */
interface PlanDraft {
  estimate: string;
  mode: PlanMode;
  style: PomodoroStyle;
  session: string;
  breakLength: string;
  startDay: string | null;
  startTime: string;
}

export interface Plannable {
  taskId: number | null;
  title: string;
  /** Course code, or the activity type for a manual goal. */
  subtitle: string | null;
  dueAt: number | null;
  category: Category;
  /** Resolved from the goal's wording, or null to count any activity. */
  targetProcess: string | null;
  targetAppName: string | null;
  defaultMinutes: number;
  /** Set when a plan already exists: confirming replaces it rather than adding another. */
  planId: number | null;
  defaultMode: PlanMode;
  defaultStyle: PomodoroStyle;
  defaultFocusMinutes: number;
  defaultBreakMinutes: number;
}

interface Props {
  item: Plannable | null;
  dayStartHour: number;
  dayEndHour: number;
  commitmentsFor: (dayKey: string, startTs: number, endTs: number) => Commitment[];
  onClose: () => void;
  onConfirm: (input: {
    item: Plannable;
    estimateSeconds: number;
    mode: PlanMode;
    style: PomodoroStyle;
    focusSeconds: number;
    breakSeconds: number;
    blocks: PlacedBlock[];
  }) => void;
}

const ESTIMATE_PRESETS = [30, 60, 120, 240];
const SESSION_PRESETS = [25, 45, 50, 90];
const HORIZON_DAYS = 7;

/** Fields are held as text, so clamping never fights what is being typed. */
function clamp(value: string, low: number, high: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(high, Math.max(low, Math.round(parsed)));
}

/**
 * "How long will this take, how do you want to work, and when does it start?" — asked
 * once, answered by the planner, then re-asked by the check-in loop while it happens.
 */
export function PlanAssignmentDialog({
  item,
  dayStartHour,
  dayEndHour,
  commitmentsFor,
  onClose,
  onConfirm,
}: Props) {
  const [estimate, setEstimate] = useState("60");
  const [mode, setMode] = useState<PlanMode>("pomodoro");
  const [style, setStyle] = useState<PomodoroStyle>("classic");
  const [session, setSession] = useState("45");
  const [breakLength, setBreakLength] = useState("5");
  /** Null day means "wherever the planner finds room". */
  const [startDay, setStartDay] = useState<string | null>(null);
  const [startTime, setStartTime] = useState("");

  /**
   * Where a half-finished draft is kept, per item.
   *
   * Clicking the backdrop closes this dialog, and losing five fields to a stray click is
   * worse than the tidiness of always starting fresh. Keyed by the item so opening a
   * different task shows that task's numbers rather than the last one's.
   */
  const draftKey = item ? `plan.draft.${item.planId ?? item.taskId ?? item.title}` : null;

  useEffect(() => {
    if (!item || !draftKey) return;
    const saved = readPref<PlanDraft | null>(draftKey, null);
    setEstimate(saved?.estimate ?? String(item.defaultMinutes));
    setMode(saved?.mode ?? item.defaultMode);
    setStyle(saved?.style ?? item.defaultStyle);
    setSession(saved?.session ?? String(item.defaultFocusMinutes));
    setBreakLength(saved?.breakLength ?? String(item.defaultBreakMinutes));
    setStartDay(saved?.startDay ?? null);
    setStartTime(saved?.startTime ?? "");
  }, [item, draftKey]);

  // Saved as you type, so the draft survives whatever closes the dialog.
  useEffect(() => {
    if (!draftKey) return;
    writePref<PlanDraft>(draftKey, {
      estimate,
      mode,
      style,
      session,
      breakLength,
      startDay,
      startTime,
    });
  }, [draftKey, estimate, mode, style, session, breakLength, startDay, startTime]);

  const estimateMinutes = clamp(estimate, 5, 600, 60);
  // The style has the final say: classic is fixed, flowmodoro derives its own break.
  const timing = styleTiming(
    style,
    clamp(session, 10, 240, 45),
    Math.min(60, Math.max(0, Math.round(Number(breakLength) || 0))),
  );
  const sessionMinutes = timing.session;
  const breakMinutes = timing.break;

  const days = useMemo(
    () =>
      plannableDays({
        now: Math.floor(Date.now() / 1000),
        dayStartHour,
        dayEndHour,
        count: HORIZON_DAYS,
        commitmentsFor,
      }),
    [dayStartHour, dayEndHour, commitmentsFor],
  );

  const minutesOfDay = useMemo(() => parseTimeOfDay(startTime), [startTime]);

  const requestedStart = useMemo(() => {
    if (!startDay || minutesOfDay === null) return null;
    const [year, month, day] = startDay.split("-").map(Number);
    const stamp = new Date(year, month - 1, day, 0, minutesOfDay, 0, 0);
    return Math.floor(stamp.getTime() / 1000);
  }, [startDay, minutesOfDay]);

  /**
   * The earliest the work may begin.
   *
   * A day with no time counts. Before this, picking Thursday and typing nothing left
   * `requestedStart` null and the proposal unchanged — the chip lit up and the plan
   * ignored it, which looked exactly like a broken button.
   */
  const startFloor = useMemo(() => {
    if (requestedStart !== null) return requestedStart;
    if (!startDay) return null;
    return days.find((entry) => entry.key === startDay)?.startTs ?? null;
  }, [requestedStart, startDay, days]);

  /**
   * True when the requested start runs into a class, a meeting, or work already placed.
   * Calendar events are immovable, so this blocks the plan rather than scheduling over it.
   */
  const conflict = useMemo(() => {
    if (!item || requestedStart === null) return null;

    const key = dayKey(new Date(requestedStart * 1000));
    const day = days.find((entry) => entry.key === key);
    if (!day) return "That time is outside the next week.";

    // The usable day is the window. Widening it to fit the request would report no
    // conflict and then place nothing, which reads as a bug rather than an answer.
    if (requestedStart < day.startTs) {
      return `That is before your day starts (${formatClock(day.startTs)}).`;
    }
    if (requestedStart >= day.endTs) {
      return `That is after your day ends (${formatClock(day.endTs)}).`;
    }

    const length = (mode === "continuous" ? estimateMinutes : sessionMinutes) * 60;
    const free = findFreeSlots({
      now: day.startTs,
      dayEnd: day.endTs,
      commitments: day.commitments,
      minSlotSeconds: 60,
    });

    if (fitsInSlots({ startTs: requestedStart, endTs: requestedStart + length }, free)) {
      return null;
    }

    const clash = day.commitments.find(
      (entry) => requestedStart < entry.endTs && entry.startTs < requestedStart + length,
    );
    return clash
      ? `That overlaps “${clash.label}” (${formatClock(clash.startTs)}–${formatClock(clash.endTs)}).`
      : "Nothing free at that time.";
  }, [item, requestedStart, days, mode, estimateMinutes, sessionMinutes]);

  const placement = useMemo(() => {
    if (!item) return null;

    // A requested start clips the window: the planner may not begin before it.
    const scoped =
      startFloor === null
        ? days
        : days
            .filter((day) => day.endTs > startFloor)
            .map((day, index) =>
              index === 0
                ? { ...day, startTs: Math.max(day.startTs, startFloor) }
                : day,
            );

    return placeWork({
      estimateSeconds: estimateMinutes * 60,
      mode,
      focusSeconds: sessionMinutes * 60,
      breakSeconds: breakMinutes * 60,
      longBreakSeconds: timing.longBreak * 60,
      sessionsPerLongBreak: timing.sessionsPerLongBreak,
      dueAt: item.dueAt,
      days: scoped,
    });
  }, [
    item,
    estimateMinutes,
    mode,
    sessionMinutes,
    breakMinutes,
    timing.longBreak,
    timing.sessionsPerLongBreak,
    requestedStart,
    days,
  ]);

  if (!item) return null;

  const blocks = placement?.blocks ?? [];
  const canConfirm = blocks.length > 0 && conflict === null;

  return (
    <div
      className="scroll-area fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-8 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl border border-edge bg-surface p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-ink">{item.title}</h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-mute">
              <span
                className="rounded-full px-2 py-0.5 font-medium"
                style={{
                  background: `${categoryColor(item.category)}1f`,
                  color: categoryColor(item.category),
                }}
              >
                {item.subtitle ?? item.category}
              </span>
              {item.dueAt
                ? `due ${new Date(item.dueAt * 1000).toLocaleString([], {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}`
                : "no due date"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-ink-mute transition hover:bg-canvas hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mt-6">
          <span className="text-xs font-medium text-ink-soft">
            How long will it take?{" "}
            <span className="font-normal text-ink-mute">
              Nudgy checks in at the halfway mark and lets you revise it.
            </span>
          </span>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {ESTIMATE_PRESETS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                onClick={() => setEstimate(String(minutes))}
                className={`rounded-lg border px-3 py-1.5 font-mono text-xs transition ${
                  estimateMinutes === minutes
                    ? "border-edge-strong bg-rose-wash text-rose-deep"
                    : "border-edge text-ink-mute hover:text-ink-soft"
                }`}
              >
                {minutes < 60 ? `${minutes}m` : `${minutes / 60}h`}
              </button>
            ))}
            <input
              type="number"
              min={5}
              step={5}
              value={estimate}
              onChange={(event) => setEstimate(event.target.value)}
              onBlur={() => setEstimate(String(estimateMinutes))}
              aria-label="Estimate in minutes"
              className="w-20 rounded-lg border border-edge bg-canvas px-2.5 py-1.5 text-xs text-ink outline-none select-text focus:border-edge-strong"
            />
            <span className="text-xs text-ink-mute">min</span>
          </div>
          <p className="mt-1.5 text-xs text-ink-mute">
            {item.planId === null
              ? "A guess is fine."
              : "Saving replaces the existing blocks for this item, and restarts its progress."}
            {item.targetAppName
              ? ` Verified against ${item.targetAppName}.`
              : " Verified against any active time in these blocks."}
          </p>
        </div>

        <div className="mt-5">
          <span className="text-xs font-medium text-ink-soft">How do you want to work?</span>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <ModeCard
              active={mode === "pomodoro"}
              onClick={() => setMode("pomodoro")}
              icon={<Timer size={14} />}
              title="Pomodoro"
              detail={`${sessionMinutes}m sessions, ${breakMinutes}m breaks`}
            />
            <ModeCard
              active={mode === "continuous"}
              onClick={() => setMode("continuous")}
              icon={<CalendarClock size={14} />}
              title="One sitting"
              detail="One session, no breaks"
            />
          </div>

          {mode === "pomodoro" && (
            <div className="mt-2 rounded-xl border border-edge bg-canvas p-3">
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["classic", "Classic", "25/5, long break every 4th"],
                    ["flowmodoro", "Flowmodoro", "Break is a fifth of the session"],
                    ["custom", "Custom", "Your own lengths"],
                  ] as const
                ).map(([id, label, detail]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setStyle(id)}
                    className={`rounded-lg border p-2 text-left transition ${
                      style === id
                        ? "border-edge-strong bg-rose-wash"
                        : "border-edge bg-surface hover:border-edge-strong"
                    }`}
                  >
                    <span
                      className={`block text-[11px] font-semibold ${
                        style === id ? "text-rose-deep" : "text-ink"
                      }`}
                    >
                      {label}
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-tight text-ink-mute">
                      {detail}
                    </span>
                  </button>
                ))}
              </div>

              {style !== "classic" && (
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <div className="min-w-44 flex-1">
                    <span className="text-[11px] font-medium text-ink-soft">
                      Session length
                    </span>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {SESSION_PRESETS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setSession(String(preset))}
                          className={`rounded-md border px-2 py-1 font-mono text-[11px] transition ${
                            sessionMinutes === preset
                              ? "border-edge-strong bg-rose-wash text-rose-deep"
                              : "border-edge text-ink-mute hover:text-ink-soft"
                          }`}
                        >
                          {preset}m
                        </button>
                      ))}
                      <input
                        type="number"
                        min={10}
                        step={5}
                        value={session}
                        onChange={(event) => setSession(event.target.value)}
                        onBlur={() => setSession(String(sessionMinutes))}
                        aria-label="Session minutes"
                        className="w-16 rounded-md border border-edge bg-surface px-2 py-1 text-[11px] text-ink outline-none select-text focus:border-edge-strong"
                      />
                    </div>
                  </div>

                  {style === "custom" ? (
                    <label className="w-24">
                      <span className="text-[11px] font-medium text-ink-soft">Break</span>
                      <input
                        type="number"
                        min={0}
                        step={5}
                        value={breakLength}
                        onChange={(event) => setBreakLength(event.target.value)}
                        onBlur={() => setBreakLength(String(breakMinutes))}
                        aria-label="Break minutes"
                        className="mt-1.5 w-full rounded-md border border-edge bg-surface px-2 py-1 text-[11px] text-ink outline-none select-text focus:border-edge-strong"
                      />
                    </label>
                  ) : (
                    <span className="pb-1 text-[11px] text-ink-mute">
                      Break: {breakMinutes}m ({sessionMinutes} ÷ 5)
                    </span>
                  )}
                </div>
              )}

              {style === "classic" && (
                <p className="mt-2.5 text-[11px] text-ink-mute">
                  25 minutes of work, 5 minutes off, and 15 minutes after every fourth
                  session.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="mt-5">
          <span className="text-xs font-medium text-ink-soft">
            Start at <span className="font-normal text-ink-mute">(optional)</span>
          </span>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setStartDay(null)}
              className={`rounded-lg border px-2.5 py-1.5 text-xs transition ${
                startDay === null
                  ? "border-edge-strong bg-rose-wash text-rose-deep"
                  : "border-edge text-ink-mute hover:text-ink-soft"
              }`}
            >
              Any day
            </button>
            {days.map((day, index) => (
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
                {dayChipLabel(day.startTs, index)}
              </button>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {/* A real time control rather than a text box: choosing 14:30 from a picker
                cannot be mistyped, so there is no parse error to explain. */}
            <input
              type="time"
              value={startTime}
              step={300}
              onChange={(event) => setStartTime(event.target.value)}
              aria-label="Start time"
              className="rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-ink outline-none transition focus:border-edge-strong"
            />
            {startTime && (
              <button
                type="button"
                onClick={() => setStartTime("")}
                className="text-[11px] text-ink-mute transition hover:text-ink-soft"
              >
                Any time
              </button>
            )}
            <span className="text-xs text-ink-mute">
              {startTime
                ? "Starts exactly here if it fits."
                : "Pick a day or let Nudgy choose."}
            </span>
          </div>
        </div>

        {conflict && (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
            <TriangleAlert size={13} className="mt-0.5 shrink-0" />
            {conflict}
          </p>
        )}

        <div className="mt-5 rounded-xl border border-edge bg-canvas p-3">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-medium text-ink-soft">Proposed</span>
            <span className="text-xs text-ink-mute">
              {blocks.length} {blocks.length === 1 ? "block" : "blocks"} ·{" "}
              {formatDuration(placement?.placedSeconds ?? 0)}
            </span>
          </div>

          {blocks.length === 0 ? (
            <p className="py-4 text-center text-xs text-warn">
              {placement?.reason ?? "Nothing could be placed."}
            </p>
          ) : (
            <>
              <ul className="scroll-area mt-2 max-h-40 space-y-1">
                {blocks.map((block) => (
                  <li
                    key={`${block.day}-${block.startTs}`}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="text-ink-soft">
                      {new Date(block.startTs * 1000).toLocaleDateString([], {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                    <span className="font-mono text-ink">
                      {formatClock(block.startTs)} – {formatClock(block.endTs)}
                    </span>
                  </li>
                ))}
              </ul>
              {placement && placement.shortfallSeconds > 0 && (
                <p className="mt-2 text-xs text-warn">
                  {formatDuration(placement.shortfallSeconds)} could not fit before the
                  deadline.
                </p>
              )}
            </>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-ink-mute transition hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={() => {
              // Confirmed, so the draft has served its purpose.
              if (draftKey) clearPref(draftKey);
              onConfirm({
                item,
                estimateSeconds: estimateMinutes * 60,
                mode,
                style,
                focusSeconds: sessionMinutes * 60,
                breakSeconds: breakMinutes * 60,
                blocks,
              });
            }}
            className="rounded-lg bg-rose px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-deep disabled:opacity-40"
          >
            {item.planId === null ? "Add to plan" : "Update plan"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  icon,
  title,
  detail,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border p-3 text-left transition ${
        active
          ? "border-edge-strong bg-rose-wash"
          : "border-edge bg-surface hover:border-edge-strong"
      }`}
    >
      <span
        className={`flex items-center gap-1.5 text-xs font-semibold ${
          active ? "text-rose-deep" : "text-ink"
        }`}
      >
        {icon}
        {title}
      </span>
      <span className="mt-1 block text-[11px] text-ink-mute">{detail}</span>
    </button>
  );
}

/** "Today", "Tomorrow", then weekday names — easier to aim at than a date picker. */
function dayChipLabel(startTs: number, index: number): string {
  if (index === 0) return "Today";
  if (index === 1) return "Tomorrow";
  return new Date(startTs * 1000).toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
  });
}
