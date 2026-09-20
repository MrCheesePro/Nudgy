import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { getLiveStatus } from "../lib/ipc";
import type { LiveStatus } from "../lib/types";

/**
 * Live foreground state. The backend pushes a tick every 5 seconds; between ticks the
 * session counter advances locally so the timer reads as a clock, not a stutter.
 */
export function useLiveActivity() {
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    let active = true;

    getLiveStatus()
      .then((value) => active && setStatus(value))
      .catch(() => undefined);

    const unlisten = listen<LiveStatus>("nudgy://tick", (event) => {
      if (!active) return;
      setStatus(event.payload);
      setElapsed(0);
    });

    return () => {
      active = false;
      unlisten.then((dispose) => dispose()).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const sessionSeconds = status ? status.sessionSeconds + elapsed : 0;
  return { status, sessionSeconds };
}
