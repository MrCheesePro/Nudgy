import { useCallback, useEffect, useState } from "react";

import { checkMacosPermissions } from "../lib/ipc";
import type { PermissionStatus } from "../lib/types";

/** Polls slowly: granting a permission in System Settings happens out of band, and the
 *  banner should disappear on its own once it does. */
export function usePermissions() {
  const [status, setStatus] = useState<PermissionStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await checkMacosPermissions());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { status, refresh };
}
