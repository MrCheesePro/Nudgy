import { useState } from "react";
import { FileText, Upload, X } from "lucide-react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";

import { DateField } from "./DateField";
import { createEvent, readDocument, readSyllabus } from "../lib/ipc";
import type { MeetingPattern } from "../lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called once classes have been written, so the calendar can pick them up. */
  onAdded: () => void;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A candidate, plus the two things only the reader can decide. */
interface Row {
  meeting: MeetingPattern;
  keep: boolean;
}

/**
 * Reading class times out of a syllabus.
 *
 * The parser understands the meeting-pattern grammar and nothing else, so it will miss
 * unusual layouts and will happily offer you your own office hours. That is survivable
 * because **nothing is written until it is confirmed** — the list below is a proposal, and
 * unchecking a row is the whole of rejecting it.
 *
 * What is confirmed becomes an ordinary weekly event through `createEvent`, so these are
 * immovable commitments the planner will not schedule work over, exactly like a class you
 * typed in by hand.
 */
export function SyllabusDialog({ open, onClose, onAdded }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [text, setText] = useState("");
  const [from, setFrom] = useState(todayKey());
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [read, setRead] = useState(false);

  if (!open) return null;

  const close = () => {
    setRows([]);
    setText("");
    setError(null);
    setRead(false);
    onClose();
  };

  const parse = async (source: string) => {
    setError(null);
    const found = await readSyllabus(source);
    setRows(found.map((meeting) => ({ meeting, keep: true })));
    setRead(true);
  };

  const choose = async () => {
    setBusy(true);
    setError(null);
    try {
      const picked = await pickFile({
        multiple: false,
        directory: false,
        filters: [{ name: "Syllabus", extensions: ["pdf", "txt", "md"] }],
      });
      if (typeof picked !== "string") return;

      const contents = await readDocument(picked);
      setText(contents);
      await parse(contents);
    } catch (cause) {
      setError(String(cause));
      setRead(false);
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const keeping = rows.filter((row) => row.keep);
    if (keeping.length === 0) return;

    setBusy(true);
    setError(null);
    try {
      for (const { meeting } of keeping) {
        const start = firstOccurrence(from, meeting.weekdays);
        await createEvent({
          title: meeting.label ? `${meeting.label}` : "Class",
          kind: meeting.label ?? "Class",
          location: meeting.location,
          startTs: stamp(start, meeting.startMinutes),
          endTs: stamp(start, meeting.endMinutes),
          repeat: "weekly",
          weekdays: meeting.weekdays,
          untilTs: until ? stamp(until, 23 * 60 + 59) : null,
        });
      }
      onAdded();
      close();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const keeping = rows.filter((row) => row.keep).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/20 p-6">
      <div className="scroll-area max-h-full w-full max-w-lg rounded-2xl border border-edge bg-surface p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
            <FileText size={15} />
            Read a syllabus
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="shrink-0 text-ink-mute transition hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void choose()}
            className="flex items-center gap-1.5 rounded-lg bg-rose px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-rose-deep disabled:opacity-40"
          >
            <Upload size={13} />
            Choose a PDF
          </button>
          <span className="text-xs text-ink-mute">or paste the text below</span>
        </div>

        {/* The paste box is not a fallback nobody needs: a scanned syllabus is a
            photograph with no text in it, and this is the answer when that happens. */}
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => text.trim() && void parse(text)}
          rows={4}
          placeholder="Lecture: MWF 10:00–10:50 AM, Pierce 201"
          className="scroll-area mt-3 w-full rounded-lg border border-edge bg-canvas px-3 py-2 font-mono text-xs text-ink-soft outline-none transition select-text focus:border-edge-strong"
        />

        {error && <p className="mt-2 text-xs text-bad">{error}</p>}

        {read && rows.length === 0 && (
          <p className="mt-4 rounded-lg border border-edge bg-canvas px-3 py-2 text-xs text-ink-mute">
            No class times found. The reader looks for a day and a time on one line, like
            “MWF 10:00–10:50 AM”. Anything it misses can still be added by hand.
          </p>
        )}

        {rows.length > 0 && (
          <>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-xs text-ink-soft">Term runs</span>
              <DateField value={from} onChange={setFrom} label="First week" />
              <span className="text-xs text-ink-mute">to</span>
              <DateField value={until} onChange={setUntil} label="Last week" />
              {!until && <span className="text-mini text-ink-mute">blank keeps going</span>}
            </div>

            <ul className="mt-3 space-y-2">
              {rows.map((row, index) => (
                <li
                  key={`${row.meeting.label ?? ""}-${index}`}
                  className="flex items-center gap-3 rounded-lg border border-edge px-3 py-2"
                >
                  <input
                    type="checkbox"
                    checked={row.keep}
                    aria-label={`Keep ${row.meeting.label ?? "this class"}`}
                    onChange={() =>
                      setRows((current) =>
                        current.map((entry, at) =>
                          at === index ? { ...entry, keep: !entry.keep } : entry,
                        ),
                      )
                    }
                    className="h-4 w-4 shrink-0 accent-rose"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-ink">
                      {row.meeting.label ?? "Class"}
                      {row.meeting.location ? ` · ${row.meeting.location}` : ""}
                    </div>
                    <div className="truncate font-mono text-mini text-ink-mute">
                      {row.meeting.weekdays.map((day) => DAYS[day]).join(" ")}{" "}
                      {clock(row.meeting.startMinutes)}–{clock(row.meeting.endMinutes)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={close}
            className="text-xs text-ink-mute transition hover:text-ink-soft"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={keeping === 0 || busy}
            onClick={() => void add()}
            className="rounded-lg bg-rose px-4 py-2 text-xs font-semibold text-white transition hover:bg-rose-deep disabled:opacity-40"
          >
            {keeping === 0
              ? "Add to calendar"
              : `Add ${keeping} ${keeping === 1 ? "class" : "classes"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * The first day on or after `from` that the class actually meets.
 *
 * Without this, a Monday class imported on a Wednesday would have its first occurrence on
 * the Wednesday — and the expansion keeps the first occurrence's time of day, so every
 * later week would be wrong too.
 */
function firstOccurrence(from: string, weekdays: number[]): string {
  const [year, month, day] = from.split("-").map(Number);
  const cursor = new Date(year, month - 1, day);
  for (let step = 0; step < 7; step += 1) {
    if (weekdays.length === 0 || weekdays.includes(cursor.getDay())) break;
    cursor.setDate(cursor.getDate() + 1);
  }
  return `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(
    cursor.getDate(),
  ).padStart(2, "0")}`;
}

function stamp(day: string, minutes: number): number {
  const [year, month, date] = day.split("-").map(Number);
  return Math.floor(
    new Date(year, month - 1, date, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime() / 1000,
  );
}

function clock(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const suffix = hour >= 12 ? "PM" : "AM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${String(minutes % 60).padStart(2, "0")} ${suffix}`;
}
