import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { getLiveStatus } from "../lib/ipc";
import type { LiveStatus } from "../lib/types";

/**
 * Live foreground state, with a session counter that reads as a clock.
 *
 * The count is **derived from `sessionStartedAt` and the wall clock**, never accumulated.
 * The previous version added a locally-ticked `elapsed` to whatever the last backend tick
 * reported, and the two timers were never in phase: a tick landing just before the local
 * one made the counter jump two seconds, landing just after made it sit still for nearly
 * two. That is the stutter. Subtracting two timestamps cannot drift, so the one-second
 * interval below is only a reason to re-render — its phase no longer matters.
 */
export function useLiveActivity() {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [, setFrame] = useState(0);

  useEffect(() => {
    let active = true;

    getLiveStatus()
      .then((value) => active && setStatus(value))
      .catch(() => undefined);

    const unlisten = listen<LiveStatus>("nudgy://tick", (event) => {
      if (!active) return;
      setStatus(event.payload);
    });

    return () => {
      active = false;
      unlisten.then((dispose) => dispose()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setFrame((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Paused, the backend holds the number and there is nothing to derive: a stopped clock
  // must not be recomputed against a moving one.
  const sessionSeconds = !status
    ? 0
    : status.paused || status.sessionStartedAt <= 0
      ? status.sessionSeconds
      : Math.max(0, Math.floor(Date.now() / 1000) - status.sessionStartedAt);

  return { status, sessionSeconds };
}
