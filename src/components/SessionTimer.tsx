import { useEffect, useState } from "react";
import { CalendarOff, Coffee, Zap } from "lucide-react";

import { categoryColor } from "../lib/categories";
import type { CurrentWork, UpcomingWork } from "../hooks/useCurrentWork";

interface Props {
  /** The block running now, or null between blocks. */
  work: CurrentWork | null;
  /** The block after this one, when the gap before it is a planned break. */
  next: UpcomingWork | null;
  /** Category of the block, for the ring colour. */
  category: string;
}

/**
 * The countdown, for the sitting you are in or the one you started yourself.
 *
 * When a block is running it is **driven by the block**: there is already a schedule
 * saying what this time is for, and a second timer you had to remember to press would be
 * one more thing to forget, and a second opinion about the same hour.
 *
 * With nothing scheduled it is a plain pomodoro you start by hand, because wanting to
 * work in twenty-five minute stretches is not conditional on having planned the day.
 *
 * **It writes nothing, in either mode.** No sessions, no completion, no progress. What
 * counts as work done stays what the watcher measured, so a timer running against an app
 * you are not using advances nothing. The countdown answers "how long is left in this
 * sitting", which is a different question from "how much of this is done".
 */
export function SessionTimer({ work, next, category }: Props) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const session = work ?? next;
  const running = session !== null;
  const focus = session ? Math.max(60, session.focusSeconds) : 0;
  const rest = session ? Math.max(0, session.breakSeconds) : 0;

  // A block is a focus session; the gap before the next one is the break the plan asked
  // for. Both are a countdown to a time the schedule already decided, which is why
  // neither needs starting and neither can drift.
  const phase: Phase = work
    ? phaseAt(work, now)
    : next
      ? {
          kind: "break",
          remaining: Math.max(0, next.startTs - now),
          length: Math.max(1, next.breakSeconds),
        }
      : { kind: "focus", remaining: 0, length: 1 };

  const color = categoryColor(category);
  const ring = !running
    ? "var(--color-edge-strong)"
    : phase.kind === "break"
      ? "var(--color-ink-mute)"
      : color;

  // 0 at the start of the phase, 1 at its end — the ring empties as the time goes.
  const progress = phase.length > 0 ? 1 - phase.remaining / phase.length : 0;
  const circumference = 2 * Math.PI * 46;

  return (
    /*
     * Laid out along its width, not down its height.
     *
     * The ring is a fixed square and everything that describes it — the phase, the two
     * halves of the cycle, what is running — is a column beside it rather than a stack
     * underneath. Stacked, the card had to be tall to fit its own captions and ended up
     * a narrow tower next to a wide panel; side by side it reads as the other half of
     * the row.
     */
    <section className="flex h-full w-[27rem] max-w-full shrink-0 items-center gap-7 rounded-2xl border border-edge bg-surface px-8 py-7">
      <div className="relative h-40 w-40 shrink-0">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle
            cx="50"
            cy="50"
            r="46"
            fill="none"
            strokeWidth="6"
            className="stroke-surface-sunken"
          />
          <circle
            cx="50"
            cy="50"
            r="46"
            fill="none"
            strokeWidth="6"
            stroke={ring}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * progress}
            className="transition-[stroke-dashoffset] duration-1000 ease-linear"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-mono text-3xl tabular-nums text-ink">
            {clock(phase.remaining)}
          </span>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col items-start gap-3">
        <span className="flex items-center gap-1.5 text-mini font-semibold tracking-widest text-ink-mute uppercase">
          {phase.kind === "break" ? <Coffee size={12} /> : <Zap size={12} />}
          {!running ? "No session" : phase.kind === "break" ? "Break" : "Focus"}
        </span>

        {/* Both halves of the cycle, always — knowing the break is five minutes and not
            fifteen is most of what makes the next twenty-five bearable, and it should not
            take arriving at the break to find out. The one you are in is the lit one. */}
        {running && (
        <div className="flex flex-col items-start gap-1 text-mini">
          <span
            className={`rounded-full px-2 py-0.5 font-mono tabular-nums ${
              phase.kind === "focus" && running
                ? "bg-rose-wash font-semibold text-rose-deep"
                : "text-ink-mute"
            }`}
          >
            {clock(focus)} focus
          </span>
          <span
            className={`rounded-full px-2 py-0.5 font-mono tabular-nums ${
              phase.kind === "break" && running
                ? "bg-surface-sunken font-semibold text-ink-soft"
                : "text-ink-mute"
            }`}
          >
            {rest > 0 ? `${clock(rest)} break` : "no break"}
          </span>
        </div>
        )}

        {work ? (
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-ink-soft">{work.title}</div>
            {/* Named as a countdown, never as progress — that number is measured
                elsewhere. */}
            <div className="text-mini text-ink-mute">left in this session</div>
          </div>
        ) : next ? (
          <div className="min-w-0">
            <div className="truncate text-xs font-medium text-ink-soft">{next.title}</div>
            <div className="text-mini text-ink-mute">until the next session</div>
          </div>
        ) : (
          // Nothing scheduled is a real answer, and a Start button here would have been a
          // second timer with a second opinion about the same hour. Plan something and
          // this fills itself in.
          <div className="flex items-center gap-1.5 text-mini text-ink-mute">
            <CalendarOff size={12} />
            Nothing scheduled
          </div>
        )}
      </div>
    </section>
  );
}

interface Phase {
  kind: "focus" | "break";
  /** Seconds left in this phase. */
  remaining: number;
  /** How long this phase runs, for the ring. */
  length: number;
}

/**
 * Where in a repeating focus/break cycle `elapsed` seconds lands.
 *
 * Derived rather than counted, so it is right whenever you happen to look — including
 * after the app was closed for an hour, which a counter would have to guess at.
 */
export function cyclePhase(elapsed: number, focus: number, rest: number): Phase {
  const safeFocus = Math.max(1, focus);
  if (rest <= 0) {
    // No break configured: one unbroken sitting that simply runs out.
    const left = Math.max(0, safeFocus - Math.max(0, elapsed));
    return { kind: "focus", remaining: left, length: safeFocus };
  }

  const cycle = safeFocus + rest;
  const into = Math.max(0, elapsed) % cycle;
  return into < safeFocus
    ? { kind: "focus", remaining: safeFocus - into, length: safeFocus }
    : { kind: "break", remaining: cycle - into, length: rest };
}

/** The same, for a block: clamped so a session cannot outlast the time it is in. */
export function phaseAt(work: CurrentWork, now: number): Phase {
  const focus = Math.max(60, work.focusSeconds);
  const rest = Math.max(0, work.breakSeconds);

  const elapsed = Math.max(0, now - work.blockStartTs);
  const blockLeft = Math.max(0, work.blockEndTs - now);

  if (rest === 0) {
    return { kind: "focus", remaining: blockLeft, length: Math.max(1, focus) };
  }

  const phase = cyclePhase(elapsed, focus, rest);
  return { ...phase, remaining: Math.min(phase.remaining, blockLeft) };
}

function clock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, "0")}`;
}
