import { useEffect, useRef, useState, type RefObject } from "react";

import {
  applyDigit,
  settle,
  toParts,
  toValue,
  type ClockParts,
  type Meridiem,
} from "../lib/clockInput";

interface Props {
  /** 24-hour `HH:MM`, or "" for unset. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label: string;
  /** So a caller can send the caret here — it lands on the hour. */
  hourRef?: RefObject<HTMLInputElement | null>;
}

/**
 * A clock you can type straight through: 1, 2, 3, 0, P.
 *
 * `<input type="time">` was doing this job, and on some platforms it advances between its
 * own segments and on others it waits to be clicked into each one. Typing a time is the
 * single most common thing this app asks anybody to do, so it is worth owning rather than
 * inheriting — three fields, and the caret moves the moment a segment cannot take another
 * digit.
 *
 * The value it reports stays 24-hour `HH:MM`, so nothing downstream knows this changed.
 */
export function TimeField({ value, onChange, disabled, label, hourRef }: Props) {
  const [parts, setParts] = useState<ClockParts>(() => toParts(value));

  /**
   * The same segments, readable without waiting for a render.
   *
   * Advancing focus fires the old segment's `onBlur` in the same turn as the `onChange`
   * that filled it, and a handler closing over `parts` sees the render *before* the
   * keystroke. Settling from that stale copy put the hour back to empty the moment it
   * completed, and turned a typed 55 into 05. Every handler reads this instead.
   */
  const latest = useRef<ClockParts>(parts);

  const fallbackHour = useRef<HTMLInputElement>(null);
  const hour = hourRef ?? fallbackHour;
  const minute = useRef<HTMLInputElement>(null);
  const meridiem = useRef<HTMLButtonElement>(null);

  // A value set from outside — cleared by "Any time", or loaded from a draft — replaces
  // what is here. What is being typed is left alone, or every keystroke fights the parent.
  useEffect(() => {
    if (toValue(latest.current) === value) return;
    latest.current = toParts(value);
    setParts(latest.current);
  }, [value]);

  const commit = (next: ClockParts) => {
    latest.current = next;
    setParts(next);
    onChange(toValue(next));
  };

  return (
    <span
      className={`inline-flex items-center rounded-lg border border-edge bg-canvas px-2.5 py-2 text-sm transition focus-within:border-edge-strong ${
        disabled ? "opacity-50" : ""
      }`}
      role="group"
      aria-label={label}
      onMouseDown={(event) => {
        // Clicking the frame — the colon, the padding — starts at the hour rather than
        // doing nothing and leaving you to aim at a six-pixel box.
        if (event.target === event.currentTarget) {
          event.preventDefault();
          hour.current?.focus();
        }
      }}
    >
      <input
        ref={hour}
        value={parts.hour}
        disabled={disabled}
        inputMode="numeric"
        placeholder="--"
        aria-label={`${label}, hour`}
        // The caret starts at the front of an empty segment rather than behind the
        // placeholder; a filled one is selected, so typing replaces it.
        onFocus={(event) =>
          event.target.value
            ? event.target.select()
            : event.target.setSelectionRange(0, 0)
        }
        onChange={(event) => {
          const step = applyDigit(latest.current, "hour", event.target.value);
          commit(step.parts);
          // The whole point: a segment that cannot take another digit hands over. The
          // blur this triggers settles from `latest`, which `commit` has already moved
          // on — reading the render's copy instead is what emptied a finished hour.
          if (step.advance) minute.current?.focus();
        }}
        onBlur={() => commit(settle(latest.current, "hour"))}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" && parts.hour) minute.current?.focus();
        }}
        className="w-6 bg-transparent text-center text-ink outline-none select-text placeholder:text-ink-mute"
      />

      <span className="text-ink-mute">:</span>

      <input
        ref={minute}
        value={parts.minute}
        disabled={disabled}
        inputMode="numeric"
        placeholder="--"
        aria-label={`${label}, minute`}
        // The caret starts at the front of an empty segment rather than behind the
        // placeholder; a filled one is selected, so typing replaces it.
        onFocus={(event) =>
          event.target.value
            ? event.target.select()
            : event.target.setSelectionRange(0, 0)
        }
        onChange={(event) => {
          const step = applyDigit(latest.current, "minute", event.target.value);
          commit(step.parts);
          if (step.advance) meridiem.current?.focus();
        }}
        onBlur={() => commit(settle(latest.current, "minute"))}
        onKeyDown={(event) => {
          // Backspace out of an empty minute goes back to the hour, the way every other
          // segmented field on the machine behaves.
          if (event.key === "Backspace" && !parts.minute) hour.current?.focus();
          if (event.key === "ArrowLeft" && !parts.minute) hour.current?.focus();
          if (event.key === "ArrowRight" && parts.minute) meridiem.current?.focus();
        }}
        className="w-6 bg-transparent text-center text-ink outline-none select-text placeholder:text-ink-mute"
      />

      {/* A button rather than a third text box: there are two answers, so typing one is a
          keystroke and clicking is a toggle, and neither needs a caret. */}
      <button
        ref={meridiem}
        type="button"
        disabled={disabled}
        aria-label={`${label}, AM or PM`}
        onClick={() =>
          commit({
            ...latest.current,
            meridiem: latest.current.meridiem === "PM" ? "AM" : "PM",
          })
        }
        onKeyDown={(event) => {
          const key = event.key.toLowerCase();
          if (key !== "a" && key !== "p" && key !== "arrowleft") return;
          event.preventDefault();
          if (key === "arrowleft") {
            minute.current?.focus();
            return;
          }
          commit({ ...latest.current, meridiem: (key === "a" ? "AM" : "PM") as Meridiem });
        }}
        className="ml-1.5 rounded px-1 text-mini font-semibold text-ink-soft transition hover:text-ink focus:text-ink focus:outline-none focus-visible:bg-surface-sunken"
      >
        {parts.meridiem || "--"}
      </button>
    </span>
  );
}
