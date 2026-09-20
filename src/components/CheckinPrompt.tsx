import { useState } from "react";
import { CircleCheckBig, Clock3 } from "lucide-react";

import { formatDuration } from "../lib/time";
import type { CheckinResponse, PlanProgress } from "../lib/types";

interface Props {
  checkin: PlanProgress | null;
  onAnswer: (response: CheckinResponse) => void;
}

const EXTEND_PRESETS = [30, 60, 120];

/**
 * The halfway question. It appears when measured work crosses the threshold, and the
 * answer feeds straight back into the estimate — the point is that the plan learns, not
 * that the user is judged against a number they guessed hours ago.
 */
export function CheckinPrompt({ checkin, onAnswer }: Props) {
  const [custom, setCustom] = useState(30);

  if (!checkin) return null;

  const { plan, workedSeconds, percent } = checkin;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/30 p-8 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-edge bg-surface p-6 shadow-2xl">
        <span className="text-[11px] font-semibold tracking-widest text-rose-deep uppercase">
          Checking in
        </span>
        <h2 className="mt-2 text-lg font-semibold text-ink">{plan.title}</h2>

        <p className="mt-1 text-sm text-ink-soft">
          You've worked{" "}
          <span className="font-mono text-ink">{formatDuration(workedSeconds)}</span> of the{" "}
          <span className="font-mono text-ink">{formatDuration(plan.estimateSeconds)}</span> you
          estimated. How's it going?
        </p>

        <div className="mt-4 h-2 overflow-hidden rounded-full bg-surface-sunken">
          <div
            className="h-full rounded-full bg-rose transition-[width] duration-500"
            style={{ width: `${Math.min(100, percent)}%` }}
          />
        </div>

        <div className="mt-6 space-y-2">
          <button
            type="button"
            onClick={() =>
              onAnswer({ planId: plan.id, action: "on_track", extraSeconds: 0 })
            }
            className="flex w-full items-center gap-2 rounded-xl border border-edge px-4 py-3 text-sm text-ink transition hover:border-edge-strong hover:bg-canvas"
          >
            <Clock3 size={15} className="text-ink-mute" />
            Still on track — keep the estimate
          </button>

          <button
            type="button"
            onClick={() => onAnswer({ planId: plan.id, action: "done", extraSeconds: 0 })}
            className="flex w-full items-center gap-2 rounded-xl border border-ok/30 bg-ok/10 px-4 py-3 text-sm font-medium text-ok transition hover:bg-ok/20"
          >
            <CircleCheckBig size={15} />
            Done — finish this plan
          </button>

          <div className="rounded-xl border border-edge p-3">
            <span className="text-xs font-medium text-ink-soft">Needs longer — add:</span>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {EXTEND_PRESETS.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  onClick={() =>
                    onAnswer({
                      planId: plan.id,
                      action: "extend",
                      extraSeconds: minutes * 60,
                    })
                  }
                  className="rounded-lg border border-edge px-3 py-1.5 font-mono text-xs text-ink-soft transition hover:border-edge-strong hover:text-ink"
                >
                  +{minutes < 60 ? `${minutes}m` : `${minutes / 60}h`}
                </button>
              ))}
              <input
                type="number"
                min={5}
                step={5}
                value={custom}
                onChange={(event) => setCustom(Math.max(5, Number(event.target.value)))}
                aria-label="Custom minutes to add"
                className="w-16 rounded-lg border border-edge bg-canvas px-2 py-1.5 text-xs text-ink outline-none select-text focus:border-edge-strong"
              />
              <button
                type="button"
                onClick={() =>
                  onAnswer({ planId: plan.id, action: "extend", extraSeconds: custom * 60 })
                }
                className="rounded-lg bg-rose-wash px-3 py-1.5 text-xs font-medium text-rose-deep transition hover:bg-edge-strong"
              >
                Add
              </button>
            </div>
          </div>
        </div>

        <p className="mt-4 text-xs text-ink-mute">
          Nudgy will ask again halfway through whatever is left, until you mark it done.
        </p>
      </div>
    </div>
  );
}
