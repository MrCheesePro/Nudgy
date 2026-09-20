import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";

import { resolveAppForText } from "../lib/ipc";
import { CATEGORIES, CATEGORY_COLORS, type AppRule, type Category } from "../lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  onAdd: (task: {
    title: string;
    category: Category;
    targetProcess: string | null;
  }) => void;
}


/**
 * Adding a task by hand. The app to verify against is inferred from the title — "draw in
 * Clip Studio" resolves to Clip Studio Paint — so nothing here asks for an executable
 * name. No match is fine: the task is then verified against any active time in its block.
 */
export function AddTaskDialog({ open, onClose, onAdd }: Props) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<Category>("Productivity");
  const [detected, setDetected] = useState<AppRule | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setCategory("Productivity");
    setDetected(null);
  }, [open]);

  // Debounced so it does not fire a command on every keystroke.
  useEffect(() => {
    const text = title.trim();
    if (text.length < 3) {
      setDetected(null);
      return;
    }
    const timer = window.setTimeout(() => {
      resolveAppForText(text)
        .then((rule) => {
          setDetected(rule);
          if (rule) setCategory(rule.category);
        })
        .catch(() => setDetected(null));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [title]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const submit = () => {
    if (!title.trim()) return;
    onAdd({
      title: title.trim(),
      category,
      targetProcess: detected?.pattern ?? null,
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/25 p-8 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-2xl border border-edge bg-surface p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">Add task</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-ink-mute transition hover:bg-canvas hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <label className="block">
            <span className="text-xs font-medium tracking-wide text-ink-soft">Title</span>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && submit()}
              className="mt-1.5 w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-ink outline-none transition select-text focus:border-edge-strong"
            />
          </label>


          <label className="block">
            <span className="text-xs font-medium tracking-wide text-ink-soft">
              Type of activity
            </span>
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as Category)}
              className="mt-1.5 w-full rounded-lg border border-edge bg-canvas px-2.5 py-2 text-sm text-ink-soft outline-none transition focus:border-edge-strong"
            >
              {CATEGORIES.filter((entry) => entry !== "Idle").map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>

          {detected && (
            <span
              className="flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
              style={{
                background: `${CATEGORY_COLORS[detected.category]}1f`,
                color: CATEGORY_COLORS[detected.category],
              }}
            >
              <Sparkles size={11} />
              Verifying against {detected.displayName}
            </span>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-ink-mute transition hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!title.trim()}
            onClick={submit}
            className="rounded-lg bg-rose px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-deep disabled:opacity-40"
          >
            Add task
          </button>
        </div>
      </div>
    </div>
  );
}
