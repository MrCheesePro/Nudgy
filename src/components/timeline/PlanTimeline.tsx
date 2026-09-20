import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CircleCheckBig } from "lucide-react";

import { stripCourseCode } from "../../hooks/useCurrentWork";
import { weekDaysAt } from "../../hooks/useSchedule";
import { categoryColor } from "../../lib/categories";
import { formatClock } from "../../lib/time";
import {
  eventColor,
  type CalendarEvent,
  type Category,
  type LiveStatus,
  type LmsTask,
  type PlanProgress,
  type ScheduleBlock,
  type VerificationResult,
} from "../../lib/types";

interface Props {
  blocks: ScheduleBlock[];
  events: CalendarEvent[];
  plans: PlanProgress[];
  /** Only to name the class a block's plan belongs to. */
  tasks: LmsTask[];
  live: LiveStatus | null;
  verifications: Record<number, VerificationResult>;
  /** 0 is this week; the parent reloads blocks when this changes. */
  weekOffset: number;
  onWeekOffset: (offset: number) => void;
}

const START_HOUR = 0;
/** 24 is midnight at the end of the day, so the grid covers 00:00 to 23:59. */
const END_HOUR = 24;
/** Pixels per hour. The day runs downward, so height is free and nothing scrolls
 *  sideways — a 30-minute block still has room for its title. */
const HOUR_HEIGHT = 96;
const MIN_BLOCK_HEIGHT = 34;

interface Bar {
  key: string;
  title: string;
  /** The class this block is for, when its plan tracks a Canvas assignment. */
  courseCode: string | null;
  category: Category;
  startTs: number;
  endTs: number;
  percent: number;
  missed: boolean;
  /** Its plan was marked finished. The block stays — it is a record of real time. */
  done: boolean;
  /** The app this block is verified against, or null for "any activity". */
  targetProcess: string | null;
}

/**
 * One day, laid out top to bottom like a calendar. Hours run down the left; commitments
 * and planned work get a column each so neither hides the other.
 */
export function PlanTimeline({
  blocks,
  events,
  plans,
  tasks,
  live,
  verifications,
  weekOffset,
  onWeekOffset,
}: Props) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [selected, setSelected] = useState(() => new Date());
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Stepping to another week lands on today if it is in view, otherwise on the first
  // day of that week.
  useEffect(() => {
    const week = weekDaysAt(weekOffset);
    const today = week.find((date) => date.toDateString() === new Date().toDateString());
    setSelected(today ?? week[0]);
  }, [weekOffset]);

  const days = useMemo(() => weekDaysAt(weekOffset), [weekOffset]);
  const selectedKey = dayKeyOf(selected);
  const isToday = selected.toDateString() === new Date().toDateString();

  const dayStart = hourOn(selected, START_HOUR);
  const dayEnd = hourOn(selected, END_HOUR);
  const toY = (ts: number) => ((ts - dayStart) / 3600) * HOUR_HEIGHT;
  const gridHeight = ((dayEnd - dayStart) / 3600) * HOUR_HEIGHT;

  const hours = useMemo(() => {
    const marks: number[] = [];
    for (let ts = dayStart; ts <= dayEnd; ts += 3600) marks.push(ts);
    return marks;
  }, [dayStart, dayEnd]);

  const dayBlocks = useMemo(
    () => blocks.filter((block) => block.day === selectedKey),
    [blocks, selectedKey],
  );

  /** Days this week that have calendar events, for the dots on the day strip. */
  const daysWithEvents = useMemo(() => {
    const marked = new Set<string>();
    for (const event of events) {
      if (event.allDay) continue;
      marked.add(new Date(event.startTs * 1000).toDateString());
    }
    return marked;
  }, [events]);

  const dayEvents = useMemo(
    () =>
      events.filter(
        (event) =>
          !event.allDay &&
          new Date(event.startTs * 1000).toDateString() === selected.toDateString(),
      ),
    [events, selected],
  );

  /**
   * A block counts as running when its window has started, the user is present, and the
   * app it is verified against is the one in front. Reaching the scheduled time is not
   * enough — the session starts when the work does.
   */
  const isRunning = (bar: Bar) => {
    if (bar.done) return false;
    if (!isToday || now < bar.startTs || now >= bar.endTs) return false;
    if (!live || live.paused || live.isIdle) return false;
    if (bar.targetProcess === null) return true;
    return live.processName.toLowerCase() === bar.targetProcess.toLowerCase();
  };

  const bars = useMemo<Bar[]>(() => {
    const planFor = new Map(plans.map((entry) => [entry.plan.id, entry]));
    const taskFor = new Map(tasks.map((task) => [task.id, task]));

    return dayBlocks
      .map((block) => {
        const plan = block.planId === null ? null : planFor.get(block.planId);
        const task = plan?.plan.taskId == null ? null : taskFor.get(plan.plan.taskId);
        const courseCode = task?.courseCode ?? null;
        const verification = verifications[block.id];
        const done = plan?.plan.status === "done";
        const target = block.targetSeconds ?? block.endTs - block.startTs;

        // A block inside a plan reports the plan's overall progress; a standalone block
        // reports its own verified time. A finished plan reads as finished whatever the
        // measured time came to — the user said so, and that outranks the arithmetic.
        const measured =
          verification && target > 0
            ? Math.min(100, Math.round((verification.accumulatedSeconds / target) * 100))
            : 0;
        const percent = done ? 100 : plan ? Math.min(100, plan.percent) : measured;

        return {
          key: `block-${block.id}`,
          // The chip carries the code, so the label does not have to repeat it.
          title: stripCourseCode(block.label, courseCode),
          courseCode,
          category: block.category,
          startTs: block.startTs,
          endTs: block.endTs,
          percent,
          done,
          missed: !done && block.verifiedState === "missed",
          targetProcess: block.targetProcess,
        };
      })
      .sort((left, right) => left.startTs - right.startTs);
  }, [dayBlocks, plans, tasks, verifications]);

  // Open near the action rather than at 7am: now if today, else the first thing on it.
  useEffect(() => {
    const anchor = isToday
      ? now
      : (bars[0]?.startTs ?? dayEvents[0]?.startTs ?? hourOn(selected, 8));
    if (!anchor || !scroller.current) return;
    scroller.current.scrollTop = Math.max(0, toY(anchor) - HOUR_HEIGHT);
    // Only when the day changes, not on every minute tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  return (
    <div className="mt-5 flex min-h-0 flex-1 flex-col">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-ink-soft">
          {rangeLabel(days[0], days[6])}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous week"
            onClick={() => onWeekOffset(weekOffset - 1)}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-edge text-ink-mute transition hover:border-edge-strong hover:text-ink"
          >
            <ChevronLeft size={14} />
          </button>
          {weekOffset !== 0 && (
            <button
              type="button"
              onClick={() => onWeekOffset(0)}
              className="rounded-lg border border-edge px-2.5 py-1 text-[11px] text-ink-soft transition hover:border-edge-strong"
            >
              This week
            </button>
          )}
          <button
            type="button"
            aria-label="Next week"
            onClick={() => onWeekOffset(weekOffset + 1)}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-edge text-ink-mute transition hover:border-edge-strong hover:text-ink"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* Day strip — a dot marks days that have calendar events. */}
      <div className="flex gap-1.5">
        {days.map((date) => {
          const active = dayKeyOf(date) === selectedKey;
          const today = date.toDateString() === new Date().toDateString();
          const hasEvents = daysWithEvents.has(date.toDateString());
          return (
            <button
              key={date.toISOString()}
              type="button"
              onClick={() => setSelected(date)}
              className={`flex flex-1 flex-col items-center gap-1 rounded-lg py-2 text-xs transition ${
                active
                  ? "bg-rose-wash font-semibold text-rose-deep"
                  : "text-ink-mute hover:bg-canvas hover:text-ink-soft"
              }`}
            >
              <span className="flex items-center gap-1.5">
                {date.toLocaleDateString([], { weekday: "narrow" })}
                <span className="font-mono">{date.getDate()}</span>
                {today && <span className="h-1.5 w-1.5 rounded-full bg-ink" />}
              </span>
              <span
                title={hasEvents ? "Has calendar events" : undefined}
                className={`h-1 w-1 rounded-full ${
                  hasEvents ? "bg-edge-strong" : "bg-transparent"
                }`}
              />
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex gap-2 border-b border-edge pb-2 pl-14 text-[10px] font-semibold tracking-widest text-ink-mute uppercase">
        <span className="w-[38%]">Calendar</span>
        <span className="flex-1">Plan</span>
      </div>

      {/* The only scroller on this page: the grid scrolls, the page behind it does not. */}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="relative flex pt-2" style={{ height: gridHeight + 16 }}>
          {/* Hour gutter */}
          <div className="relative w-14 shrink-0">
            {hours.slice(0, -1).map((ts) => (
              <span
                key={ts}
                className="absolute right-2 font-mono text-[10px] text-ink-mute"
                style={{ top: toY(ts) - 5 }}
              >
                {new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric" })}
              </span>
            ))}
          </div>

          <div className="relative flex-1">
            {hours.map((ts) => (
              <div
                key={`rule-${ts}`}
                className="pointer-events-none absolute inset-x-0 border-t border-edge/60"
                style={{ top: toY(ts) }}
              />
            ))}

            {isToday && now > dayStart && now < dayEnd && (
              <>
                <div
                  className="future-hatch pointer-events-none absolute inset-x-0 bottom-0"
                  style={{ top: toY(now) }}
                />
                <div
                  className="pointer-events-none absolute inset-x-0 z-20 h-px bg-ink/50"
                  style={{ top: toY(now) }}
                >
                  <span className="absolute -top-0.75 -left-0.75 h-1.5 w-1.5 rounded-full bg-ink" />
                </div>
              </>
            )}

            {/* Calendar column */}
            <div className="absolute inset-y-0 left-0 w-[38%]">
              {dayEvents.map((event) => {
                const color = eventColor(event);
                const top = Math.max(0, toY(event.startTs));
                const height = Math.max(MIN_BLOCK_HEIGHT, toY(event.endTs) - top);
                return (
                  <article
                    key={`${event.summary}-${event.startTs}`}
                    title={`${event.summary} · ${formatClock(event.startTs)}–${formatClock(event.endTs)}`}
                    className="absolute inset-x-1 overflow-hidden rounded-lg border py-1 pr-1.5 pl-2.5"
                    style={{
                      top,
                      height,
                      borderColor: `${color}44`,
                      background: `${color}14`,
                    }}
                  >
                    <span
                      className="absolute top-1.5 bottom-1.5 left-0.5 w-1 rounded-full"
                      style={{ background: color }}
                    />
                    <span
                      className="block truncate text-[11px] leading-tight font-semibold"
                      style={{ color }}
                    >
                      {event.summary}
                    </span>
                    <span className="block truncate font-mono text-[9px] text-ink-mute">
                      {formatClock(event.startTs)} – {formatClock(event.endTs)}
                      {height >= 52 && ` · ${spanLabel(event.startTs, event.endTs)}`}
                    </span>
                  </article>
                );
              })}
            </div>

            {/* Plan column */}
            <div className="absolute inset-y-0 right-0 left-[40%]">
              {bars.map((bar) => {
                const color = categoryColor(bar.category);
                const top = Math.max(0, toY(bar.startTs));
                const height = Math.max(MIN_BLOCK_HEIGHT, toY(bar.endTs) - top);
                const running = isRunning(bar);
                // Finished work keeps its place and its height — it is a record of real
                // time — but stops competing for attention with what is still ahead.
                const rail = bar.done ? "var(--color-ink-mute)" : color;
                return (
                  <article
                    key={bar.key}
                    title={`${bar.title} · ${formatClock(bar.startTs)}–${formatClock(bar.endTs)}${
                      bar.done ? " · done" : ""
                    }`}
                    className={`absolute inset-x-1 flex flex-col overflow-hidden rounded-lg border py-1 pr-1.5 pl-2.5 ${
                      bar.done ? "opacity-60" : ""
                    }`}
                    style={{
                      top,
                      height,
                      borderColor: running ? color : `${rail}44`,
                      background: bar.done ? "var(--color-surface-sunken)" : `${rail}14`,
                      boxShadow: running ? `0 0 0 1px ${color}` : undefined,
                    }}
                  >
                    <span
                      className="absolute top-1.5 bottom-1.5 left-0.5 w-1 rounded-full"
                      style={{ background: rail }}
                    />

                    <span
                      className="flex min-w-0 items-center gap-1 truncate text-[11px] leading-tight font-semibold"
                      style={{ color: bar.done ? "var(--color-ink-mute)" : color }}
                    >
                      {running && (
                        <span
                          className="live-dot h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: color }}
                          title="Running — this app is in front"
                        />
                      )}
                      {bar.done && <CircleCheckBig size={10} className="shrink-0 text-ok" />}
                      <span className="truncate">{bar.title}</span>
                    </span>

                    {/* Start to end, then how long that is — the two questions a block on
                        a calendar gets asked, in the order they get asked. A block too
                        short for the second line keeps the first. */}
                    <span className="block truncate font-mono text-[9px] text-ink-mute">
                      {formatClock(bar.startTs)} – {formatClock(bar.endTs)}
                      {height >= 52 && ` · ${spanLabel(bar.startTs, bar.endTs)}`}
                    </span>

                    {bar.courseCode && height >= 68 && (
                      <span className="mt-0.5 w-fit shrink-0 rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[9px] font-medium text-ink-soft">
                        {bar.courseCode}
                      </span>
                    )}

                    {height >= 60 && (
                      <div className="mt-auto flex items-center gap-2 pt-1">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-rose-wash">
                          <div
                            className="h-full rounded-full transition-[width] duration-500"
                            style={{
                              width: `${bar.percent}%`,
                              background: bar.missed ? "var(--color-bad)" : rail,
                            }}
                          />
                        </div>
                        <span className="shrink-0 font-mono text-[10px] font-semibold text-ink-soft">
                          {bar.percent}%
                        </span>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {bars.length === 0 && dayEvents.length === 0 && (
        <p className="pt-3 text-center text-sm text-ink-mute">
          Nothing scheduled for{" "}
          {selected.toLocaleDateString([], {
            weekday: "long",
            month: "short",
            day: "numeric",
          })}
          .
        </p>
      )}
    </div>
  );
}

function rangeLabel(start: Date, end: Date): string {
  const format = (date: Date) =>
    date.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${format(start)} – ${format(end)}, ${end.getFullYear()}`;
}

/** `2h`, `45m`, `1h 30m` — how long a block lasts, next to when it runs. */
function spanLabel(startTs: number, endTs: number): string {
  const minutes = Math.round((endTs - startTs) / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

function hourOn(date: Date, hour: number): number {
  const stamp = new Date(date);
  stamp.setHours(hour, 0, 0, 0);
  return Math.floor(stamp.getTime() / 1000);
}

function dayKeyOf(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
