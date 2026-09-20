import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";

interface Props {
  open: boolean;
  title: string;
  /** What will actually happen, including the parts that are not obvious. */
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  /** A second way out, for when the real question is "which of these two". */
  secondaryLabel?: string;
  onSecondary?: () => void;
  onCancel: () => void;
}

/**
 * The question asked before something cannot be taken back.
 *
 * It exists because deleting a goal also deletes its plan and every block on the timeline
 * that plan owns — consequences the button that starts it does not show. The body text is
 * for naming those, so nobody learns about them afterwards.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  secondaryLabel,
  onSecondary,
  onCancel,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-ink/25 p-8 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-edge bg-surface p-6 shadow-2xl">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <TriangleAlert size={16} className="shrink-0 text-warn" />
          {title}
        </h2>

        {/* `body` sets user-select: none, so this has to opt back in to be readable. */}
        <p className="mt-2.5 text-xs leading-relaxed text-ink-soft select-text">{body}</p>

        <div className="mt-6 space-y-2">
          <button
            type="button"
            autoFocus
            onClick={onCancel}
            className="w-full rounded-lg bg-rose py-2 text-xs font-semibold text-white transition hover:bg-rose-deep"
          >
            Keep it
          </button>
          {/* The reversible option sits above the destructive one, and only the
              destructive one turns red on hover. */}
          {secondaryLabel && onSecondary && (
            <button
              type="button"
              onClick={onSecondary}
              className="w-full rounded-lg border border-edge py-2 text-xs font-medium text-ink-soft transition hover:border-edge-strong hover:text-ink"
            >
              {secondaryLabel}
            </button>
          )}
          <button
            type="button"
            onClick={onConfirm}
            className="w-full rounded-lg border border-edge py-2 text-xs font-medium text-ink-soft transition hover:border-bad/40 hover:text-bad"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
