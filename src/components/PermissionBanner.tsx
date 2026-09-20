import { ShieldAlert } from "lucide-react";

import { openPrivacySettings, requestScreenRecordingAccess } from "../lib/ipc";
import type { PermissionStatus } from "../lib/types";

interface Props {
  status: PermissionStatus | null;
  onRefresh: () => void;
}

/**
 * Screen Recording only affects window *titles* — app-level tracking works without it.
 * The banner says so, because a permission prompt with no explanation is how trackers
 * get uninstalled.
 */
export function PermissionBanner({ status, onRefresh }: Props) {
  if (!status || !status.applicable || status.screenRecording) return null;

  const grant = async () => {
    await requestScreenRecordingAccess().catch(() => undefined);
    await openPrivacySettings("screen_recording").catch(() => undefined);
    window.setTimeout(onRefresh, 1500);
  };

  return (
    <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-warn/30 bg-warn/10 px-5 py-4">
      <ShieldAlert className="shrink-0 text-warn" size={20} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">Screen Recording access is off</p>
        <p className="mt-0.5 text-xs text-ink-soft">
          Nudgy still tracks which app is in focus. Window titles stay blank until access is
          granted — and they are the only thing this permission is used for.
        </p>
      </div>
      <button
        type="button"
        onClick={() => void grant()}
        className="shrink-0 rounded-lg border border-warn/30 bg-surface px-3.5 py-2 text-xs font-medium text-warn transition hover:bg-warn/10"
      >
        Open System Settings
      </button>
    </div>
  );
}
