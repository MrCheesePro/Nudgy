import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";

import { resolveAppForText } from "../lib/ipc";
import { categoryColor, useAssignableCategories } from "../lib/categories";
import { clearPref, readPref, writePref } from "../lib/prefs";
import type { AppRule, Category } from "../lib/types";

const DRAFT_KEY = "task.draft";

interface TaskDraft {
  title: string;
  category: Category;
  dueDate: string;
  dueTime: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onAdd: (task: {
    title: string;
    category: Category;
    targetProcess: string | null;
    /** Epoch seconds, or null when nothing is due. */
    dueAt: number | null;
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
  const categories = useAssignableCategories();
  const [dueDate, setDueDate] = useState("");
  const [dueTime, setDueTime] = useState("");

  /**
   * The dialog closes on a backdrop click, so it no longer wipes what you typed. The
   * draft is restored on reopen and only cleared once the task is actually added.
   */
  useEffect(() => {
    if (!open) return;
    const saved = readPref<TaskDraft | null>(DRAFT_KEY, null);
    setTitle(saved?.title ?? "");
    setCategory(saved?.category ?? "Productivity");
    setDueDate(saved?.dueDate ?? "");
    setDueTime(saved?.dueTime ?? "");
    setDetected(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    writePref<TaskDraft>(DRAFT_KEY, { title, category, dueDate, dueTime });
  }, [open, title, category, dueDate, dueTime]);

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

  /**
   * A date, and optionally a time on it. A date with no time means end of day rather than
   * midnight — "due Friday" has never meant "due Friday 00:00", and treating it that way
   * would make everything look a day late.
   */
  const parseDue = (date: string, time: string): number | null => {
    if (!date) return null;
    const [year, month, day] = date.split("-").map(Number);
    if (!year || !month || !day) return null;
    const [hour, minute] = time ? time.split(":").map(Number) : [23, 59];
    const stamp = new Date(year, month - 1, day, hour ?? 23, minute ?? 59, 0, 0);
    return Math.floor(stamp.getTime() / 1000);
  };

  const submit = () => {
    if (!title.trim()) return;
    clearPref(DRAFT_KEY);
    onAdd({
      title: title.trim(),
      category,
      targetProcess: detected?.pattern ?? null,
      dueAt: parseDue(dueDate, dueTime),
    });
    onClose();
  };

  return (
    <div
      className="scroll-area fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-8 backdrop-blur-sm"
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


          <div>
            <span className="text-xs font-medium tracking-wide text-ink-soft">
              Due <span className="text-ink-mute">(optional)</span>
            </span>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
                aria-label="Due date"
                className="rounded-lg border border-edge bg-canvas px-2.5 py-2 text-sm text-ink-soft outline-none transition focus:border-edge-strong"
              />
              <input
                type="time"
                value={dueTime}
                disabled={!dueDate}
                onChange={(event) => setDueTime(event.target.value)}
                aria-label="Due time"
                className="rounded-lg border border-edge bg-canvas px-2.5 py-2 text-sm text-ink-soft outline-none transition focus:border-edge-strong disabled:opacity-50"
              />
              {dueDate && (
                <button
                  type="button"
                  onClick={() => {
                    setDueDate("");
                    setDueTime("");
                  }}
                  className="text-mini text-ink-mute transition hover:text-ink-soft"
                >
                  Clear
                </button>
              )}
            </div>
            <span className="mt-1 block text-mini text-ink-mute">
              {dueDate && !dueTime
                ? "No time given, so it is due by the end of that day."
                : "A deadline moves it ahead of undated work when planning."}
            </span>
          </div>

          <label className="block">
            <span className="text-xs font-medium tracking-wide text-ink-soft">
              Type of activity
            </span>
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value as Category)}
              className="mt-1.5 w-full rounded-lg border border-edge bg-canvas px-2.5 py-2 text-sm text-ink-soft outline-none transition focus:border-edge-strong"
            >
              {categories.map((entry) => (
                <option key={entry.id} value={entry.name}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>


          {detected && (
            <span
              className="flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-mini font-medium"
              style={{
                background: `${categoryColor(detected.category)}1f`,
                color: categoryColor(detected.category),
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
