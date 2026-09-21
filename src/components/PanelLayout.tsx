import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Check, Eye, EyeOff, GripVertical, RotateCcw } from "lucide-react";

import {
  DEFAULT_LAYOUT,
  gridColumns,
  MAX_RATIO,
  MIN_RATIO,
  PANEL_NAMES,
  useLayout,
  visiblePanels,
  type PanelId,
} from "../lib/layout";

interface Props {
  editing: boolean;
  onDone: () => void;
  /** One entry per panel. Only the visible ones are rendered. */
  panels: Record<PanelId, ReactNode>;
}

/**
 * The two Today panels, arranged.
 *
 * Out of edit mode this is a grid and nothing more — no handles, no borders, no cost.
 * Edit mode adds a hide toggle to each panel and a draggable divider between them,
 * because "this one needs more room" is a layout question and answering it anywhere but
 * on the layout itself means guessing.
 *
 * The order is fixed. Panels can be resized and hidden, not moved: reading left to right
 * is the one thing about this page that should be the same on every machine.
 *
 * The split is a ratio rather than a pixel width, so it survives a resized window and a
 * different monitor — the thing a stored pixel width gets wrong the moment you unplug.
 */
export function PanelLayout({ editing, onDone, panels }: Props) {
  const [layout, setLayout] = useLayout();
  const container = useRef<HTMLDivElement>(null);
  const resizing = useRef(false);

  const visible = visiblePanels(layout);
  const showDivider = editing && visible.length > 1;

  const onResize = useCallback(
    (event: PointerEvent) => {
      if (!resizing.current || !container.current) return;
      const box = container.current.getBoundingClientRect();
      const fraction = (event.clientX - box.left) / box.width;
      // Guarded both ends: a ratio past these leaves one panel too narrow to read, and
      // dragging off the edge of the window would otherwise send it to zero.
      const ratio = Math.min(
        MAX_RATIO,
        Math.max(MIN_RATIO, fraction / Math.max(0.01, 1 - fraction)),
      );
      setLayout({ ...layout, ratio });
    },
    [layout, setLayout],
  );

  useEffect(() => {
    if (!editing) return;
    const stop = () => {
      resizing.current = false;
    };
    window.addEventListener("pointermove", onResize);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", onResize);
      window.removeEventListener("pointerup", stop);
    };
  }, [editing, onResize]);

  return (
    <>
      <div
        ref={container}
        className="grid min-h-0 flex-1 gap-5"
        style={{ gridTemplateColumns: gridColumns(layout) }}
      >
        {visible.map((id, index) => (
          <div key={id} className="relative flex min-h-0 min-w-0 flex-col">
            {editing && (
              <div className="absolute -top-3 left-3 z-10 flex items-center gap-1.5 rounded-full border border-edge bg-surface px-2.5 py-1 shadow-md">
                <span className="text-micro font-medium text-ink-soft">
                  {PANEL_NAMES[id]}
                </span>
                <button
                  type="button"
                  onClick={() => setLayout({ ...layout, hidden: [...layout.hidden, id] })}
                  // The last one standing cannot be hidden: a blank page with no way back
                  // is not a layout anybody chose.
                  disabled={visible.length <= 1}
                  title="Hide this panel"
                  className="text-ink-mute transition hover:text-bad disabled:opacity-30"
                >
                  <EyeOff size={11} />
                </button>
              </div>
            )}

            <div
              className={`flex min-h-0 flex-1 flex-col ${
                editing ? "rounded-2xl outline-2 outline-dashed outline-edge-strong" : ""
              }`}
            >
              {panels[id]}
            </div>

            {showDivider && index === 0 && (
              <span
                onPointerDown={(event) => {
                  resizing.current = true;
                  event.preventDefault();
                }}
                title="Drag to resize"
                className="absolute top-1/2 -right-5 z-10 flex h-12 w-5 -translate-y-1/2 cursor-col-resize items-center justify-center rounded-full border border-edge bg-surface text-ink-mute shadow-md"
              >
                <GripVertical size={12} />
              </span>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-edge bg-surface px-4 py-2.5">
          <span className="text-mini text-ink-mute">
            Drag the divider between the panels to resize them, or hide one you do not
            want.
          </span>

          <span className="ml-auto flex items-center gap-2">
            {layout.hidden.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() =>
                  setLayout({
                    ...layout,
                    hidden: layout.hidden.filter((entry) => entry !== id),
                  })
                }
                className="flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1 text-mini text-ink-soft transition hover:border-edge-strong"
              >
                <Eye size={11} />
                Show {PANEL_NAMES[id]}
              </button>
            ))}

            <button
              type="button"
              onClick={() => setLayout(DEFAULT_LAYOUT)}
              className="flex items-center gap-1.5 rounded-lg border border-edge px-2.5 py-1 text-mini text-ink-soft transition hover:border-edge-strong"
            >
              <RotateCcw size={11} />
              Reset
            </button>
            <button
              type="button"
              onClick={onDone}
              className="flex items-center gap-1.5 rounded-lg bg-rose px-3 py-1 text-mini font-semibold text-white transition hover:bg-rose-deep"
            >
              <Check size={12} />
              Done
            </button>
          </span>
        </div>
      )}
    </>
  );
}
