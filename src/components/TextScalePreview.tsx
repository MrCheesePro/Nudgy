import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";

import {
  applyAppearance,
  MAX_SCALE,
  MIN_SCALE,
  saveAppearance,
  useAppearance,
} from "../lib/appearance";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Text size, judged against the real page.
 *
 * Settings closes and this floats over the app, because a preview swatch cannot tell you
 * whether a whole dashboard is readable — the only honest test is the thing itself, at
 * the size you are considering. The slider sits bottom-left and Save top-right, out of
 * the way of the content being judged.
 *
 * Every drag applies immediately and nothing is written until Save, so backing out puts
 * it back exactly as it was.
 */
export function TextScalePreview({ open, onClose }: Props) {
  const appearance = useAppearance();
  const [draft, setDraft] = useState(appearance.scale);
  /** What to go back to. Captured on open, before any dragging. */
  const [original, setOriginal] = useState(appearance.scale);

  useEffect(() => {
    if (!open) return;
    setOriginal(appearance.scale);
    setDraft(appearance.scale);
    // Reading `appearance.scale` on open only: re-running as it changes would fight the
    // drag it is reacting to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        applyAppearance({ scale: original });
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, original, onClose]);

  if (!open) return null;

  const percent = Math.round(draft * 100);

  return (
    <>
      <div className="fixed top-4 right-5 z-[60] flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            applyAppearance({ scale: original });
            onClose();
          }}
          className="flex items-center gap-1.5 rounded-full border border-edge bg-surface px-3 py-2 text-xs text-ink-soft shadow-lg transition hover:border-edge-strong"
        >
          <X size={13} />
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            void saveAppearance({ scale: draft });
            onClose();
          }}
          className="flex items-center gap-1.5 rounded-full bg-rose px-4 py-2 text-xs font-semibold text-white shadow-lg transition hover:bg-rose-deep"
        >
          <Check size={13} />
          Save
        </button>
      </div>

      <div className="fixed bottom-5 left-20 z-[60] flex items-center gap-3 rounded-full border border-edge bg-surface px-4 py-2.5 shadow-lg">
        <span className="text-xs text-ink-mute">Text size</span>
        <input
          type="range"
          min={MIN_SCALE * 100}
          max={MAX_SCALE * 100}
          step={5}
          value={percent}
          aria-label="Text size"
          onChange={(event) => {
            const next = Number(event.target.value) / 100;
            setDraft(next);
            // Applied as you drag: the whole point is watching the real page move.
            applyAppearance({ scale: next });
          }}
          className="h-1 w-56 cursor-pointer appearance-none rounded-full bg-surface-sunken accent-rose"
        />
        <span className="w-12 text-right font-mono text-xs tabular-nums text-ink">
          {percent}%
        </span>
        {percent !== 100 && (
          <button
            type="button"
            onClick={() => {
              setDraft(1);
              applyAppearance({ scale: 1 });
            }}
            className="text-[0.6875rem] text-ink-mute transition hover:text-ink-soft"
          >
            Reset
          </button>
        )}
      </div>
    </>
  );
}
