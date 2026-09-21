import { useEffect, useRef, useState } from "react";

import {
  applyDateDigit,
  settleDate,
  toDateParts,
  toDateValue,
  type DateParts,
  type DateSegment,
} from "../lib/dateInput";

interface Props {
  /** ISO `YYYY-MM-DD`, or "" for unset. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label: string;
  /** Where the caret goes once the year is whole — usually the time beside it. */
  onComplete?: () => void;
}

/**
 * A date you can type straight through, the same way [TimeField](./TimeField.tsx) works.
 *
 * Three segments, and the caret moves the moment one cannot take another digit: 9 is a
 * month on its own, 1 waits because it might become 12. Same reasoning as the clock, and
 * the same reason for existing — `<input type="date">` advances its own segments on some
 * platforms and waits to be clicked into each one on others.
 *
 * It reports ISO `YYYY-MM-DD`, so nothing downstream knows this changed.
 */
export function DateField({ value, onChange, disabled, label, onComplete }: Props) {
  const [parts, setParts] = useState<DateParts>(() => toDateParts(value));

  /** Readable without waiting for a render — see the note in `TimeField`. */
  const latest = useRef<DateParts>(parts);

  const month = useRef<HTMLInputElement>(null);
  const day = useRef<HTMLInputElement>(null);
  const year = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (toDateValue(latest.current) === value) return;
    latest.current = toDateParts(value);
    setParts(latest.current);
  }, [value]);

  const commit = (next: DateParts) => {
    latest.current = next;
    setParts(next);
    onChange(toDateValue(next));
  };

  const after: Record<DateSegment, () => void> = {
    month: () => day.current?.focus(),
    day: () => year.current?.focus(),
    year: () => onComplete?.(),
  };

  const segment = (
    id: DateSegment,
    ref: React.RefObject<HTMLInputElement | null>,
    width: string,
    placeholder: string,
    back?: React.RefObject<HTMLInputElement | null>,
  ) => (
    <input
      ref={ref}
      value={parts[id]}
      disabled={disabled}
      inputMode="numeric"
      placeholder={placeholder}
      aria-label={`${label}, ${id}`}
      // The caret starts at the front of an empty segment rather than sitting behind the
      // placeholder; a filled one is selected, so typing replaces it.
      onFocus={(event) =>
        parts[id]
          ? event.target.select()
          : event.target.setSelectionRange(0, 0)
      }
      onChange={(event) => {
        const step = applyDateDigit(latest.current, id, event.target.value);
        commit(step.parts);
        if (step.advance) after[id]();
      }}
      onBlur={() => commit(settleDate(latest.current, id))}
      onKeyDown={(event) => {
        if (!back) return;
        if ((event.key === "Backspace" || event.key === "ArrowLeft") && !parts[id]) {
          back.current?.focus();
        }
      }}
      className={`${width} bg-transparent text-center text-ink outline-none select-text placeholder:text-ink-mute`}
    />
  );

  return (
    <span
      className={`inline-flex items-center rounded-lg border border-edge bg-canvas px-2.5 py-2 text-sm transition focus-within:border-edge-strong ${
        disabled ? "opacity-50" : ""
      }`}
      role="group"
      aria-label={label}
    >
      {segment("month", month, "w-6", "--")}
      <span className="text-ink-mute">/</span>
      {segment("day", day, "w-6", "--", month)}
      <span className="text-ink-mute">/</span>
      {segment("year", year, "w-10", "----", day)}
    </span>
  );
}
