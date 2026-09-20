import { useCallback, useState } from "react";

/**
 * Small per-viewer conveniences — which range a chart was left on, a half-typed dialog.
 *
 * `localStorage` on purpose: none of this is data, it is where you left the furniture.
 * It never needs to reach Rust, survive a reinstall or be read back by anything else, and
 * keeping it out of the settings table means a chart toggle is not a database write.
 *
 * Every access is wrapped: storage throws in a private window and can come back empty
 * after a clear, and a remembered filter is never worth a blank screen.
 */

const PREFIX = "nudgy:";

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writePref<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Full, blocked or private: the setting simply does not persist this session.
  }
}

export function clearPref(key: string): void {
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    // As above — nothing to recover from.
  }
}

/** `useState`, but the value outlives the component that owns it. */
export function usePref<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, fallback));

  const update = useCallback(
    (next: T) => {
      setValue(next);
      writePref(key, next);
    },
    [key],
  );

  return [value, update];
}
