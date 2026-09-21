import { useEffect, useRef, useState, type RefObject } from "react";

import {
  digits,
  hourComplete,
  minuteComplete,
  padTyped,
  settleHour,
  settleMinute,
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

  const fallbackHour = useRef<HTMLInputElement>(null);
  const hour = hourRef ?? fallbackHour;
  const minute = useRef<HTMLInputElement>(null);
  const meridiem = useRef<HTMLButtonElement>(null);

  // A value set from outside — cleared by "Any time", or loaded from a draft — replaces
  // what is here. What is being typed is left alone, or every keystroke fights the parent.
  useEffect(() => {
    setParts((current) => (toValue(current) === value ? current : toParts(value)));
  }, [value]);

  const commit = (next: ClockParts) => {
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
    >
      <input
        ref={hour}
        value={parts.hour}
        disabled={disabled}
        inputMode="numeric"
        placeholder="--"
        aria-label={`${label}, hour`}
        onFocus={(event) => event.target.select()}
        onChange={(event) => {
          const next = digits(event.target.value);
          commit({ ...parts, hour: next });
          // The whole point: a segment that cannot take another digit hands over.
          if (hourComplete(next)) minute.current?.focus();
        }}
        onBlur={() => commit({ ...parts, hour: settleHour(parts.hour) })}
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
        onFocus={(event) => event.target.select()}
        onChange={(event) => {
          const next = digits(event.target.value);
          const done = minuteComplete(next);
          // Padded on the way out, so a lone 7 is 07 rather than 70.
          commit({ ...parts, minute: done ? padTyped(next) : next });
          if (done) meridiem.current?.focus();
        }}
        onBlur={() => commit({ ...parts, minute: settleMinute(parts.minute) })}
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
          commit({ ...parts, meridiem: parts.meridiem === "PM" ? "AM" : "PM" })
        }
        onKeyDown={(event) => {
          const key = event.key.toLowerCase();
          if (key !== "a" && key !== "p" && key !== "arrowleft") return;
          event.preventDefault();
          if (key === "arrowleft") {
            minute.current?.focus();
            return;
          }
          commit({ ...parts, meridiem: (key === "a" ? "AM" : "PM") as Meridiem });
        }}
        className="ml-1.5 rounded px-1 text-mini font-semibold text-ink-soft transition hover:text-ink focus:text-ink focus:outline-none focus-visible:bg-surface-sunken"
      >
        {parts.meridiem || "--"}
      </button>
    </span>
  );
}
