import { Moon, Pause, Radio, Zap } from "lucide-react";

import { formatClock, formatDuration } from "../lib/time";
import { categoryColor } from "../lib/categories";
import type { LiveStatus } from "../lib/types";
import type { CurrentWork } from "../hooks/useCurrentWork";

interface Props {
  status: LiveStatus | null;
  sessionSeconds: number;
  paused: boolean;
  /** The scheduled block covering right now, if there is one. */
  work?: CurrentWork | null;
}

/** How far through a block the clock is. Only used when there is no plan to measure. */
function elapsedPercent(startTs: number, endTs: number): number {
  const span = endTs - startTs;
  if (span <= 0) return 0;
  const gone = Math.floor(Date.now() / 1000) - startTs;
  return Math.min(100, Math.max(0, Math.round((gone / span) * 100)));
}

export function LiveStatusHeader({ status, sessionSeconds, paused, work }: Props) {
  const idle = status?.isIdle ?? true;
  const color = status ? categoryColor(status.category) : categoryColor("Idle");
  // The block says what this time is *for*; the flags only decide how loudly it is said.
  const onTask = work !== null && work !== undefined && work.matchingProcess && !idle && !paused;

  return (
    <header className="shrink-0 rounded-2xl border border-edge bg-surface p-6">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[0.6875rem] font-semibold tracking-widest text-ink-mute uppercase">
            <span
              className={`h-2 w-2 rounded-full ${paused ? "" : "live-dot"}`}
              style={{
                background: paused
                  ? "var(--color-ink-mute)"
                  : idle
                    ? "var(--color-warn)"
                    : "var(--color-ok)",
              }}
            />
            {paused ? "Paused — holding" : idle ? "Idle" : "Now tracking"}
          </div>

          <h1 className="mt-2.5 flex items-baseline gap-2 truncate text-3xl font-semibold text-ink">
            {status?.appName ?? "Waiting for the first tick"}
            {/* The app is rarely the answer on its own: Chrome showing YouTube and Chrome
                showing Canvas are not the same hour. */}
            {status?.windowTitle && (
              <span className="min-w-0 truncate text-base font-normal text-ink-mute">
                {status.windowTitle}
              </span>
            )}
          </h1>

          {work ? (
            // Stays put for the whole block: an alt-tab to Finder changes the colour, not
            // the answer to "what am I meant to be doing?".
            <p
              className={`mt-1 flex h-5 items-center gap-1.5 truncate text-sm ${
                onTask ? "text-ink-soft" : "text-ink-mute"
              }`}
            >
              {work.courseCode && (
                <span
                  className="shrink-0 rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[0.625rem] font-medium text-ink-soft"
                  title="Course this block is for"
                >
                  {work.courseCode}
                </span>
              )}
              <span className="truncate">{work.title}</span>
              <span className="shrink-0 text-xs text-ink-mute">
                {formatClock(work.blockStartTs)} – {formatClock(work.blockEndTs)}
              </span>
            </p>
          ) : (
            <p className="mt-1 h-5 truncate text-sm text-ink-mute">
              {status ? status.processName : ""}
            </p>
          )}

          {/* How the scheduled work is going, right here rather than only in the
              sidebar. Where a plan exists the number is measured working time, not the
              clock — sitting in front of a block you are not doing is not progress. A
              standalone block has nothing to measure against, so it reports the honest
              thing instead: how much of the block has gone by. */}
          {work && (
            <div className="mt-3 max-w-md">
              <div className="flex items-baseline justify-between gap-3 text-[0.6875rem]">
                <span className="text-ink-mute">
                  {work.planPercent !== null
                    ? `${formatDuration(work.workedSeconds)} of ${formatDuration(
                        work.estimateSeconds,
                      )} worked`
                    : "through this block"}
                </span>
                <span className="font-mono font-semibold tabular-nums text-ink-soft">
                  {work.planPercent ?? elapsedPercent(work.blockStartTs, work.blockEndTs)}%
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{
                    width: `${Math.max(
                      2,
                      work.planPercent ?? elapsedPercent(work.blockStartTs, work.blockEndTs),
                    )}%`,
                    background: onTask ? color : "var(--color-edge-strong)",
                  }}
                />
              </div>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {status && (
              <span
                className="rounded-full px-3 py-1 text-xs font-medium"
                style={{ background: `${color}22`, color }}
              >
                {status.category}
              </span>
            )}
            {status?.source === "rpc" && (
              <span className="flex items-center gap-1 rounded-full bg-rose-wash px-3 py-1 text-xs text-rose-deep">
                <Radio size={12} /> Rich Presence
              </span>
            )}
            {status && status.sessionStartedAt > 0 && (
              <span className="text-xs text-ink-mute">
                since {formatClock(status.sessionStartedAt)}
              </span>
            )}
          </div>
        </div>

        <div className="text-right">
          <div className="font-mono text-4xl tabular-nums text-ink">
            {formatDuration(sessionSeconds)}
          </div>
          <div className="mt-1 flex items-center justify-end gap-1 text-xs text-ink-mute">
            {paused ? <Pause size={12} /> : idle ? <Moon size={12} /> : <Zap size={12} />}
            {paused
              ? "held"
              : idle
                ? `idle ${formatDuration(status?.idleSeconds ?? 0)}`
                : "current session"}
          </div>
        </div>
      </div>
    </header>
  );
}
