import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { deletePlan, getPlans, respondCheckin } from "../lib/ipc";
import type { CheckinResponse, PlanProgress } from "../lib/types";

const REFRESH_MS = 60_000;

/**
 * Active work plans and the check-in conversation.
 *
 * The backend decides when to ask; this hook only surfaces the question and sends back
 * the answer.
 */
export function usePlans() {
  const [plans, setPlans] = useState<PlanProgress[]>([]);
  const [checkin, setCheckin] = useState<PlanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await getPlans();
      setPlans(next);
      // A plan awaiting an answer when the window opens — the notification may have
      // fired while the dashboard was hidden in the tray.
      setCheckin((current) => current ?? next.find((entry) => entry.checkinDue) ?? null);
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The minute timer is the backstop. A flush is the actual signal: worked time is
    // measured from the table, so it cannot change between one flush and the next, and
    // waiting out a poll after it did left the bar a minute behind the work.
    const flushed = listen("nudgy://flushed", () => void refresh());
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    const unlisten = listen<PlanProgress>("nudgy://checkin", (event) => {
      setCheckin(event.payload);
      void refresh();
    });

    return () => {
      window.clearInterval(timer);
      unlisten.then((dispose) => dispose()).catch(() => undefined);
      flushed.then((dispose) => dispose()).catch(() => undefined);
    };
  }, [refresh]);

  const answer = useCallback(
    async (response: CheckinResponse) => {
      setCheckin(null);
      try {
        await respondCheckin(response);
        await refresh();
      } catch (cause) {
        setError(String(cause));
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: number) => {
      try {
        await deletePlan(id);
        await refresh();
      } catch (cause) {
        setError(String(cause));
      }
    },
    [refresh],
  );

  return { plans, checkin, answer, remove, refresh, error };
}
