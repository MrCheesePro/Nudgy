import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
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
 * Size, judged against the real page.
 *
 * Settings closes and this floats over the app, because a preview swatch cannot tell you
 * whether a whole dashboard is readable — the only honest test is the thing itself.
 *
 * **Every dimension here is in pixels on purpose.** Both sliders change the units the
 * rest of the app is built from, so a control written in those units would grow as you
 * dragged it, move under the cursor and make the thing being measured impossible to
 * judge. It is rendered outside the zoomed root for the same reason.
 *
 * Nothing is written until Save, so Escape or Cancel puts it back exactly as it was.
 */
export function TextScalePreview({ open, onClose }: Props) {
  const appearance = useAppearance();
  const [text, setText] = useState(appearance.scale);
  const [ui, setUi] = useState(appearance.uiScale);
  /** What to go back to. Captured on open, before any dragging. */
  const [original, setOriginal] = useState({ scale: 1, uiScale: 1 });

  useEffect(() => {
    if (!open) return;
    setOriginal({ scale: appearance.scale, uiScale: appearance.uiScale });
    setText(appearance.scale);
    setUi(appearance.uiScale);
    // Read on open only: re-running as they change would fight the drag it reacts to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      applyAppearance(original);
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, original, onClose]);

  if (!open) return null;

  // Rendered into `body`, not into the app. The "Everything" slider zooms `#root`, and
  // `zoom` multiplies through ancestors — a control living inside it would scale itself
  // as you dragged, which is the one thing it must not do.
  return createPortal(
    <div
      className="fixed left-1/2 z-[60] flex -translate-x-1/2 items-center rounded-full border border-edge bg-surface shadow-2xl"
      // Fixed against both sliders, so the bar stays put while the page behind it moves.
      style={{
        bottom: "20px",
        gap: "16px",
        fontSize: "13px",
        padding: "10px 20px",
      }}
    >
      <Slider
        label="Text"
        value={text}
        onChange={(next) => {
          setText(next);
          applyAppearance({ scale: next });
        }}
      />

      <span className="shrink-0 bg-edge" style={{ height: "24px", width: "1px" }} />

      <Slider
        label="Everything"
        value={ui}
        onChange={(next) => {
          setUi(next);
          applyAppearance({ uiScale: next });
        }}
      />

      <span className="shrink-0 bg-edge" style={{ height: "24px", width: "1px" }} />

      <div className="flex shrink-0 items-center" style={{ gap: "8px" }}>
        {(text !== 1 || ui !== 1) && (
          <button
            type="button"
            onClick={() => {
              setText(1);
              setUi(1);
              applyAppearance({ scale: 1, uiScale: 1 });
            }}
            className="text-ink-mute transition hover:text-ink-soft"
            style={{ fontSize: "12px" }}
          >
            Reset
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            applyAppearance(original);
            onClose();
          }}
          className="flex items-center rounded-full border border-edge text-ink-soft transition hover:border-edge-strong"
          style={{ fontSize: "12px", padding: "6px 12px", gap: "6px" }}
        >
          <X size={13} />
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            void saveAppearance({ scale: text, uiScale: ui });
            onClose();
          }}
          className="flex items-center rounded-full bg-rose font-semibold text-white transition hover:bg-rose-deep"
          style={{ fontSize: "12px", padding: "6px 14px", gap: "6px" }}
        >
          <Check size={13} />
          Save
        </button>
      </div>
    </div>,
    document.body,
  );
}

function Slider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const percent = Math.round(value * 100);

  return (
    <label className="flex shrink-0 items-center" style={{ gap: "10px" }}>
      <span className="text-ink-mute" style={{ width: "62px" }}>
        {label}
      </span>
      <input
        type="range"
        min={MIN_SCALE * 100}
        max={MAX_SCALE * 100}
        step={5}
        value={percent}
        aria-label={`${label} size`}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
        className="cursor-pointer appearance-none rounded-full bg-surface-sunken accent-rose"
        style={{ width: "150px", height: "4px" }}
      />
      <span
        className="text-right font-mono tabular-nums text-ink"
        style={{ width: "42px", fontSize: "12px" }}
      >
        {percent}%
      </span>
    </label>
  );
}
