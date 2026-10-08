import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, X } from "lucide-react";

import {
  applyAppearance,
  FONTS,
  MAX_SCALE,
  MIN_PANEL_OPACITY,
  MIN_SCALE,
  saveAppearance,
  useAppearance,
} from "../lib/appearance";
import { applyAccent, chooseAccent, useAccent } from "../lib/theme";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Everything this bar can change, so "has anything changed?" is one comparison. */
interface Draft {
  scale: number;
  panelOpacity: number;
  font: string;
  /** One colour the whole theme is derived from, or "" for the app's own. */
  accent: string;
}

/**
 * How the app looks, judged against the app.
 *
 * Settings steps aside and this floats over the real page, because no preview swatch can
 * tell you whether a whole dashboard is readable at 120%, or whether a translucent card
 * still reads over your own photograph. The only honest test is the thing itself, which
 * is why the controls that change how things *look* live here rather than in a dialog
 * covering the thing they change.
 *
 * **Every dimension here is in pixels on purpose.** The text slider changes the unit the
 * rest of the app is built from, so a control written in that unit would grow as you
 * dragged it and move out from under the cursor.
 *
 * For the same reason nothing here is conditionally rendered while a drag can be in
 * progress. The bar is centred with a transform, so anything that changes its width also
 * moves it sideways — a Reset button that appeared as you crossed 100% shifted the whole
 * bar mid-drag, which is exactly the kind of bug that feels like the slider is broken.
 *
 * Nothing is written until Save, so Escape or Cancel puts it back exactly as it was.
 */
export function AppearanceBar({ open, onClose }: Props) {
  const appearance = useAppearance();
  const accent = useAccent();
  const [draft, setDraft] = useState<Draft>(() => snapshot(appearance, accent));
  /** What to go back to. Captured on open, before any dragging. */
  const original = useRef<Draft>(snapshot(appearance, accent));
  /** Set briefly when a click is refused, to point at the button that would allow it. */
  const [nagging, setNagging] = useState(false);

  useEffect(() => {
    if (!open) return;
    original.current = snapshot(appearance, accent);
    setDraft(snapshot(appearance, accent));
    // Read on open only: re-running as they change would fight the drag it reacts to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      applyAppearance(original.current);
      applyAccent(original.current.accent);
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const dirty =
    draft.scale !== original.current.scale ||
    draft.panelOpacity !== original.current.panelOpacity ||
    draft.font !== original.current.font ||
    draft.accent !== original.current.accent;

  const change = (next: Partial<Draft>) => {
    const merged = { ...draft, ...next };
    setDraft(merged);
    applyAppearance(merged);
    if (merged.accent !== draft.accent) applyAccent(merged.accent);
  };

  const cancel = () => {
    applyAppearance(original.current);
    applyAccent(original.current.accent);
    onClose();
  };

  const save = () => {
    const { accent: colour, ...rest } = draft;
    void saveAppearance(rest);
    void chooseAccent(colour);
    onClose();
  };

  // Rendered into `body`, not into the app, so nothing the app does to itself reaches it.
  return createPortal(
    <>
      {/*
        Clicking the page does not quietly discard a change.
        With nothing changed, clicking away is just a way to close — so it closes. With
        something changed, it would throw the change away without saying so, so instead
        the Save button flashes: the answer to "how do I keep this?" is the thing that
        just moved.
      */}
      <div
        className="fixed inset-0 z-[55]"
        onMouseDown={() => {
          if (!dirty) {
            cancel();
            return;
          }
          setNagging(false);
          // A frame off and on again, or the animation does not restart on a second click.
          requestAnimationFrame(() => setNagging(true));
        }}
      />

      <div
        className="fixed left-1/2 z-[60] flex -translate-x-1/2 items-center rounded-full border border-edge bg-surface shadow-2xl"
        style={{ bottom: "20px", gap: "14px", fontSize: "13px", padding: "10px 20px" }}
      >
        {/* One colour; the other eleven are derived from it (invariant 40). Previewed
            live like everything else here, and written only on Save. */}
        <label className="flex shrink-0 items-center" style={{ gap: "8px" }}>
          <span className="text-ink-mute">Colour</span>
          <input
            type="color"
            value={draft.accent || "#e0919c"}
            onChange={(event) => change({ accent: event.target.value })}
            aria-label="Theme colour"
            className="cursor-pointer rounded border border-edge bg-canvas"
            style={{ height: "24px", width: "34px" }}
          />
        </label>

        <Divider />

        <Slider
          label="Text"
          value={draft.scale}
          min={MIN_SCALE}
          max={MAX_SCALE}
          onChange={(scale) => change({ scale })}
        />

        {/* Only when there is something to see through to — with no background behind
            them, translucent cards are just grey ones. This cannot appear mid-drag, so it
            does not move the bar under anybody's cursor. */}
        {appearance.background.trim() && (
          <>
            <Divider />
            <Slider
              label="Panels"
              value={draft.panelOpacity}
              min={MIN_PANEL_OPACITY}
              max={1}
              onChange={(panelOpacity) => change({ panelOpacity })}
            />
          </>
        )}

        <Divider />

        <label className="flex shrink-0 items-center" style={{ gap: "8px" }}>
          <span className="text-ink-mute">Font</span>
          <select
            value={draft.font}
            onChange={(event) => change({ font: event.target.value })}
            aria-label="Typeface"
            className="rounded-full border border-edge bg-canvas text-ink-soft outline-none"
            style={{ fontSize: "12px", padding: "4px 8px" }}
          >
            {FONTS.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
            {/* Families added in Settings. Their value is the family name, which
                `applyAppearance` loads from Google Fonts. */}
            {appearance.savedFonts.map((family) => (
              <option key={family} value={family}>
                {family}
              </option>
            ))}
            {/* One chosen before it could be listed must not look like it was lost. */}
            {!FONTS.some((entry) => entry.id === draft.font) &&
              !appearance.savedFonts.includes(draft.font) && (
                <option value={draft.font}>{draft.font}</option>
              )}
          </select>
        </label>

        <Divider />

        <div className="flex shrink-0 items-center" style={{ gap: "8px" }}>
          {/* Always rendered, disabled rather than absent: see the note above about the
              bar's width. */}
          <button
            type="button"
            disabled={!dirty}
            onClick={() => change(snapshot(undefined, ""))}
            className="text-ink-mute transition hover:text-ink-soft disabled:opacity-30 disabled:hover:text-ink-mute"
            style={{ fontSize: "12px" }}
          >
            Reset
          </button>
          <button
            type="button"
            onClick={cancel}
            className="flex items-center rounded-full border border-ink-mute/40 text-ink-soft transition hover:border-ink-mute"
            style={{ fontSize: "12px", padding: "6px 12px", gap: "6px" }}
          >
            <X size={13} />
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            onAnimationEnd={() => setNagging(false)}
            // Ink, not the accent: a bright picked colour made a bright button with white text
            // on it, and Save is the one control that has to be readable at any colour.
            className={`flex items-center rounded-full bg-ink font-semibold text-surface transition hover:bg-ink-soft ${
              nagging ? "attention" : ""
            }`}
            style={{ fontSize: "12px", padding: "6px 14px", gap: "6px" }}
          >
            <Check size={13} />
            Save
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}

/** The defaults, or what a given appearance currently holds. */
function snapshot(
  from: { scale: number; panelOpacity: number; font: string } | undefined,
  accent: string,
): Draft {
  return {
    scale: from?.scale ?? 1,
    panelOpacity: from?.panelOpacity ?? 1,
    font: from?.font ?? "default",
    accent,
  };
}

function Divider() {
  return <span className="shrink-0 bg-edge" style={{ height: "24px", width: "1px" }} />;
}

function Slider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const percent = Math.round(value * 100);

  return (
    <label className="flex shrink-0 items-center" style={{ gap: "10px" }}>
      <span className="text-ink-mute" style={{ width: "42px" }}>
        {label}
      </span>
      <input
        type="range"
        min={min * 100}
        max={max * 100}
        step={5}
        value={percent}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
        className="cursor-pointer appearance-none rounded-full bg-surface-sunken accent-rose"
        style={{ width: "140px", height: "4px" }}
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
