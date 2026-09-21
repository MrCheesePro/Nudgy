import { useEffect, useState } from "react";
import { Coffee, Pause, Play, RotateCcw, Zap } from "lucide-react";

import { categoryColor } from "../lib/categories";
import { usePref } from "../lib/prefs";
import type { CurrentWork } from "../hooks/useCurrentWork";

interface Props {
  /** The block running now, or null when nothing is scheduled. */
  work: CurrentWork | null;
  /** Category of the block, for the ring colour. */
  category: string;
}

/** The classic cycle, used when there is no block to take the lengths from. */
export const MANUAL_FOCUS = 25 * 60;
export const MANUAL_BREAK = 5 * 60;

const PREF_KEY = "pomodoro";

/**
 * A timer that is not counting is not a state worth storing — but where it started is.
 *
 * `startedAt` is the moment the current run began, shifted back by whatever had already
 * elapsed when it was last paused, so the phase is always derived from the clock rather
 * than counted. It survives navigating away, and survives the app being closed, which a
 * counter in component state cannot.
 */
interface Pomodoro {
  startedAt: number | null;
  /** Seconds elapsed when it was paused. Meaningless while it runs. */
  frozen: number;
}

const STOPPED: Pomodoro = { startedAt: null, frozen: 0 };

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
export function SessionTimer({ work, category }: Props) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [manual, setManual] = usePref<Pomodoro>(PREF_KEY, STOPPED);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const focus = work ? Math.max(60, work.focusSeconds) : MANUAL_FOCUS;
  const rest = work ? Math.max(0, work.breakSeconds) : MANUAL_BREAK;

  const running = work !== null || manual.startedAt !== null;
  const elapsed = work
    ? Math.max(0, now - work.blockStartTs)
    : manual.startedAt !== null
      ? Math.max(0, now - manual.startedAt)
      : manual.frozen;

  const phase = work ? phaseAt(work, now) : cyclePhase(elapsed, focus, rest);

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
    <section className="flex h-full w-72 shrink-0 flex-col items-center justify-center rounded-2xl border border-edge bg-surface px-8 py-7">
      <span className="flex items-center gap-1.5 text-mini font-semibold tracking-widest text-ink-mute uppercase">
        {phase.kind === "break" ? <Coffee size={12} /> : <Zap size={12} />}
        {!running ? "Pomodoro" : phase.kind === "break" ? "Break" : "Focus"}
      </span>

      <div className="relative mt-4 h-40 w-40">
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

      {/* Both halves of the cycle, always — knowing the break is five minutes and not
          fifteen is most of what makes the next twenty-five bearable, and it should not
          take arriving at the break to find out. The one you are in is the lit one. */}
      <div className="mt-4 flex items-center gap-2 text-mini">
        <span
          className={`rounded-full px-2 py-0.5 font-mono tabular-nums ${
            phase.kind === "focus" && running
              ? "bg-rose-wash font-semibold text-rose-deep"
              : "text-ink-mute"
          }`}
        >
          {clock(focus)} focus
        </span>
        <span className="text-ink-mute">·</span>
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

      {work ? (
        <>
          <span className="mt-3.5 max-w-44 truncate text-center text-xs text-ink-soft">
            {work.title}
          </span>
          {/* Named as a countdown, never as progress — that number is measured elsewhere. */}
          <span className="text-mini text-ink-mute">
            {phase.kind === "break" ? "until back to it" : "left in this session"}
          </span>
        </>
      ) : (
        <div className="mt-3.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setManual(
                manual.startedAt !== null
                  ? { startedAt: null, frozen: Math.max(0, now - manual.startedAt) }
                  : // Start where it was paused, by moving the start back that far.
                    { startedAt: now - manual.frozen, frozen: 0 },
              )
            }
            className="flex items-center gap-1.5 rounded-full bg-rose px-3.5 py-1.5 text-mini font-semibold text-white transition hover:bg-rose-deep"
          >
            {manual.startedAt !== null ? <Pause size={12} /> : <Play size={12} />}
            {manual.startedAt !== null ? "Pause" : manual.frozen > 0 ? "Resume" : "Start"}
          </button>
          {(manual.startedAt !== null || manual.frozen > 0) && (
            <button
              type="button"
              onClick={() => setManual(STOPPED)}
              title="Reset"
              aria-label="Reset the timer"
              className="rounded-full p-1.5 text-ink-mute transition hover:text-ink"
            >
              <RotateCcw size={13} />
            </button>
          )}
        </div>
      )}
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
