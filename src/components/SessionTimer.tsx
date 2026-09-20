import { useEffect, useState } from "react";
import { Coffee, Zap } from "lucide-react";

import { categoryColor } from "../lib/categories";
import type { CurrentWork } from "../hooks/useCurrentWork";

interface Props {
  work: CurrentWork;
  /** Category of the block, for the ring colour. */
  category: string;
}

/**
 * The countdown for the sitting you are in.
 *
 * Driven by the block, not started by hand: there is already a schedule saying what this
 * time is for, and a second timer you had to remember to press would be one more thing
 * to forget — and a second opinion about the same hour.
 *
 * **It writes nothing.** No sessions, no completion, no progress. What counts as work
 * done stays what the watcher measured, so a timer running against an app you are not
 * using advances nothing. The countdown answers "how long is left in this sitting", which
 * is a different question from "how much of this is done", and the panel keeps them apart.
 */
export function SessionTimer({ work, category }: Props) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const phase = phaseAt(work, now);
  const color = categoryColor(category);
  const ring = phase.kind === "break" ? "var(--color-ink-mute)" : color;

  // 0 at the start of the phase, 1 at its end — the ring empties as the time goes.
  const progress = phase.length > 0 ? 1 - phase.remaining / phase.length : 0;
  const circumference = 2 * Math.PI * 46;

  return (
    <section className="flex shrink-0 flex-col items-center justify-center rounded-2xl border border-edge bg-surface px-7 py-6">
      <span className="flex items-center gap-1.5 text-[0.6875rem] font-semibold tracking-widest text-ink-mute uppercase">
        {phase.kind === "break" ? <Coffee size={12} /> : <Zap size={12} />}
        {phase.kind === "break" ? "Break" : "Focus"}
      </span>

      <div className="relative mt-3 h-28 w-28">
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
          <span className="font-mono text-2xl tabular-nums text-ink">
            {clock(phase.remaining)}
          </span>
        </div>
      </div>

      <span className="mt-3 max-w-36 truncate text-center text-xs text-ink-soft">
        {work.title}
      </span>
      {/* Named as a countdown, never as progress — that number is measured elsewhere. */}
      <span className="text-[0.6875rem] text-ink-mute">
        {phase.kind === "break" ? "until back to it" : "left in this session"}
      </span>
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
 * Where in the focus/break cycle the block currently is.
 *
 * Derived from the block's start and the plan's own lengths rather than counted, so it
 * is right whenever you happen to look — including after the app was closed for an hour,
 * which a counter would have to guess at.
 */
export function phaseAt(work: CurrentWork, now: number): Phase {
  const focus = Math.max(60, work.focusSeconds);
  const rest = Math.max(0, work.breakSeconds);
  const cycle = focus + rest;

  const elapsed = Math.max(0, now - work.blockStartTs);
  const blockLeft = Math.max(0, work.blockEndTs - now);

  // No break configured: the block is one unbroken sitting and the clock simply runs out.
  if (rest === 0) {
    return { kind: "focus", remaining: blockLeft, length: Math.max(1, focus) };
  }

  const intoCycle = elapsed % cycle;
  if (intoCycle < focus) {
    return {
      kind: "focus",
      // Never past the end of the block: a session cannot outlast the time it is in.
      remaining: Math.min(focus - intoCycle, blockLeft),
      length: focus,
    };
  }
  return {
    kind: "break",
    remaining: Math.min(cycle - intoCycle, blockLeft),
    length: rest,
  };
}

function clock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(safe % 60).padStart(2, "0")}`;
}
