import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { ClipboardPaste, FileText, TriangleAlert, X } from "lucide-react";

import { readDocument } from "../lib/ipc";
import {
  readGradesPage,
  readWeights,
  type ImportedItem,
  type ImportedWeight,
} from "../services/gradeImport";

interface Props {
  open: boolean;
  /** `grades`: a copied Canvas Grades page. `syllabus`: weights out of a syllabus. */
  mode: "grades" | "syllabus";
  courseCode: string;
  /** This class's assignment names from the feed — the reader anchors rows on them. */
  knownTitles: string[];
  onClose: () => void;
  /** Only what was left ticked. The caller writes it. */
  onConfirm: (picked: { items: ImportedItem[]; weights: ImportedWeight[] }) => Promise<void>;
}

/**
 * Paste, read, look, confirm — and only then write.
 *
 * Invariant 46: grades are read, never trusted. The reader is pattern matching and will
 * sometimes pick up a row that is not an assignment or miss one that is, so every row it
 * found is shown with a checkbox, ticked, and nothing leaves this dialog until the button
 * is pressed. Unticking is how a wrong row is thrown away.
 */
export function GradesImportDialog({
  open,
  mode,
  courseCode,
  knownTitles,
  onClose,
  onConfirm,
}: Props) {
  const [text, setText] = useState("");
  const [skipItems, setSkipItems] = useState<Set<number>>(new Set());
  const [skipWeights, setSkipWeights] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setText("");
    setSkipItems(new Set());
    setSkipWeights(new Set());
    setError(null);
  }, [open, mode]);

  const read = useMemo(() => {
    if (!text.trim()) return { items: [], weights: [], warning: null as string | null };
    if (mode === "grades") return { ...readGradesPage(text, knownTitles), warning: null };
    const { weights, warning } = readWeights(text);
    return { items: [], weights, warning };
  }, [text, mode, knownTitles]);

  // A new paste is a new list; old unticks would point at different rows.
  useEffect(() => {
    setSkipItems(new Set());
    setSkipWeights(new Set());
  }, [read]);

  if (!open) return null;

  const items = read.items.filter((_, index) => !skipItems.has(index));
  const weights = read.weights.filter((_, index) => !skipWeights.has(index));
  const nothingFound = text.trim().length > 0 && read.items.length === 0 && read.weights.length === 0;

  const choose = async () => {
    setError(null);
    try {
      const picked = await pickFile({
        multiple: false,
        directory: false,
        filters: [{ name: "Syllabus", extensions: ["pdf", "txt", "md"] }],
      });
      if (typeof picked !== "string") return;
      setText(await readDocument(picked));
    } catch (cause) {
      setError(String(cause));
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm({ items, weights });
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (set: Set<number>, index: number) => {
    const next = new Set(set);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    return next;
  };

  // Portalled to <body>: rendered inside a page, the dialog would sit under
  // `.panels-see-through` and inherit its translucent surface (invariant 39).
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-6">
      <div className="scroll-area flex max-h-full w-full max-w-xl flex-col rounded-2xl border border-edge bg-surface p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            {mode === "grades" ? <ClipboardPaste size={15} /> : <FileText size={15} />}
            {mode === "grades" ? `Paste grades · ${courseCode}` : `Weights from the syllabus · ${courseCode}`}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 text-ink-mute transition hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        <p className="mt-2 text-xs leading-relaxed text-ink-soft">
          {mode === "grades" ? (
            <>
              In Canvas, open this class's <b>Grades</b> page, press <b>⌘A</b> (Ctrl+A on
              Windows) then <b>⌘C</b>, and paste it below. No token needed. You will see every
              row before anything is saved.
            </>
          ) : (
            <>
              Paste the syllabus's grading section, or open the file. Lines like{" "}
              <span className="font-mono">Homework 20%</span> become categories. The letter
              scale is skipped.
            </>
          )}
        </p>

        <div className="mt-3 flex items-center gap-2">
          <textarea
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={4}
            placeholder={mode === "grades" ? "Paste the Grades page here" : "Homework 20%\nMidterm 30%\nFinal 50%"}
            className="scroll-area w-full rounded-lg border border-edge bg-canvas px-3 py-2 font-mono text-xs text-ink-soft outline-none transition select-text focus:border-edge-strong"
          />
        </div>
        {mode === "syllabus" && (
          <button
            type="button"
            onClick={() => void choose()}
            className="mt-2 flex w-fit items-center gap-1.5 rounded-lg border border-edge px-3 py-1.5 text-xs text-ink-soft transition hover:border-edge-strong"
          >
            <FileText size={12} />
            Open a PDF or text file…
          </button>
        )}

        {nothingFound && (
          <p className="mt-3 text-xs text-ink-mute">
            {mode === "grades"
              ? "No scores found. Make sure you copied the Grades page itself — rows like “9 / 10” are what it looks for."
              : "No weights found. It looks for one name and one percentage per line."}
          </p>
        )}

        <div className="scroll-area mt-3 min-h-0 flex-1 space-y-3">
          {read.weights.length > 0 && (
            <section>
              <h3 className="text-mini font-semibold tracking-wider text-ink-soft uppercase">
                Weights
              </h3>
              <ul className="mt-1.5 space-y-1">
                {read.weights.map((entry, index) => (
                  <Row
                    key={`w-${entry.name}`}
                    checked={!skipWeights.has(index)}
                    onToggle={() => setSkipWeights((current) => toggle(current, index))}
                    label={entry.name}
                    value={`${entry.weight}%`}
                  />
                ))}
              </ul>
              {read.warning && (
                <p className="mt-1.5 flex items-center gap-1.5 text-mini text-warn">
                  <TriangleAlert size={11} />
                  {read.warning}
                </p>
              )}
            </section>
          )}

          {read.items.length > 0 && (
            <section>
              <h3 className="text-mini font-semibold tracking-wider text-ink-soft uppercase">
                Assignments
              </h3>
              <ul className="mt-1.5 space-y-1">
                {read.items.map((entry, index) => (
                  <Row
                    key={`i-${entry.title}`}
                    checked={!skipItems.has(index)}
                    onToggle={() => setSkipItems((current) => toggle(current, index))}
                    label={entry.title}
                    hint={entry.category}
                    value={`${entry.score === null ? "–" : entry.score} / ${entry.points}`}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>

        {error && <p className="mt-3 text-xs text-bad">{error}</p>}

        <div className="mt-4 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-ink-mute transition hover:text-ink-soft"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || (items.length === 0 && weights.length === 0)}
            onClick={() => void confirm()}
            className="rounded-lg bg-rose px-4 py-2 text-xs font-semibold text-white transition hover:bg-rose-deep disabled:opacity-40"
          >
            Save {items.length > 0 && `${items.length} ${items.length === 1 ? "grade" : "grades"}`}
            {items.length > 0 && weights.length > 0 && " and "}
            {weights.length > 0 && `${weights.length} ${weights.length === 1 ? "weight" : "weights"}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Row({
  checked,
  onToggle,
  label,
  hint,
  value,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  hint?: string | null;
  value: string;
}) {
  return (
    <li>
      <label
        className={`flex cursor-pointer items-center gap-2 rounded-lg border border-edge px-2.5 py-1.5 text-xs transition ${
          checked ? "text-ink-soft" : "text-ink-mute line-through"
        }`}
      >
        <input type="checkbox" checked={checked} onChange={onToggle} className="accent-rose" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {hint && <span className="shrink-0 text-mini text-ink-mute">{hint}</span>}
        <span className="shrink-0 font-mono tabular-nums">{value}</span>
      </label>
    </li>
  );
}
