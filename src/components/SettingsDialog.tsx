import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, TriangleAlert, X } from "lucide-react";

import {
  clearActivityData,
  clearSecret,
  getSettings,
  hasSecret,
  setSecret,
  setLmsProvider,
  setSetting,
} from "../lib/ipc";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { chooseTheme, THEMES, useTheme } from "../lib/theme";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  SECRET_CALENDAR_ICS_URL,
  SECRET_CANVAS_TOKEN,
  SECRET_LMS_FEED_URL,
  SETTING_CANVAS_BASE_URL,
  SETTING_LMS_PROVIDER,
  LMS_LABELS,
  type LmsProvider,
} from "../lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
}


/** The plain settings, as loaded. Secrets are not here — they are never read back. */
interface SettingsForm {
  canvasUrl: string;
  lmsProvider: LmsProvider;
}

const EMPTY_FORM: SettingsForm = { canvasUrl: "", lmsProvider: "canvas" };

export function SettingsDialog({ open, onClose }: Props) {
  const [form, setForm] = useState<SettingsForm>(EMPTY_FORM);
  /** What was loaded from disk — the yardstick for "has anything changed?". */
  const [baseline, setBaseline] = useState<SettingsForm>(EMPTY_FORM);

  const [canvasToken, setCanvasToken] = useState("");
  const [calendarUrl, setCalendarUrl] = useState("");
  const [lmsFeed, setLmsFeed] = useState("");

  const [canvasTokenStored, setCanvasTokenStored] = useState(false);
  const [calendarStored, setCalendarStored] = useState(false);
  const [lmsFeedStored, setLmsFeedStored] = useState(false);

  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingWipe, setConfirmingWipe] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const theme = useTheme();
  const [autostart, setAutostart] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const settings = new Map(await getSettings().catch(() => []));
      const loaded: SettingsForm = {
        canvasUrl: settings.get(SETTING_CANVAS_BASE_URL) ?? "",
        lmsProvider: (settings.get(SETTING_LMS_PROVIDER) as LmsProvider) ?? "canvas",
          };
      setForm(loaded);
      setBaseline(loaded);

      setCanvasTokenStored(await hasSecret(SECRET_CANVAS_TOKEN).catch(() => false));
      setCalendarStored(await hasSecret(SECRET_CALENDAR_ICS_URL).catch(() => false));
      setLmsFeedStored(await hasSecret(SECRET_LMS_FEED_URL).catch(() => false));
      setAutostart(await autostartEnabled().catch(() => false));

      setCanvasToken("");
      setCalendarUrl("");
      setLmsFeed("");
      setStatus(null);
      setConfirmingClose(false);
    })();
  }, [open]);

  // Typing into a secret field counts: the value is write-only, so anything in the box
  // is by definition not yet saved.
  const dirty = useMemo(
    () =>
      form.canvasUrl !== baseline.canvasUrl ||
      form.lmsProvider !== baseline.lmsProvider ||
      canvasToken.trim() !== "" ||
      calendarUrl.trim() !== "" ||
      lmsFeed.trim() !== "",
    [form, baseline, canvasToken, calendarUrl, lmsFeed],
  );

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await setSetting(SETTING_CANVAS_BASE_URL, form.canvasUrl.trim());
      await setLmsProvider(form.lmsProvider);

      // A blank secret field means "leave the keychain alone", not "erase it" — blank is
      // the normal state, since the stored value is never echoed back into the form.
      if (canvasToken.trim()) {
        await setSecret(SECRET_CANVAS_TOKEN, canvasToken.trim());
        setCanvasTokenStored(true);
        setCanvasToken("");
      }
      if (lmsFeed.trim()) {
        await setSecret(SECRET_LMS_FEED_URL, lmsFeed.trim());
        setLmsFeedStored(true);
        setLmsFeed("");
      }
      if (calendarUrl.trim()) {
        await setSecret(SECRET_CALENDAR_ICS_URL, calendarUrl.trim());
        setCalendarStored(true);
        setCalendarUrl("");
      }

      setBaseline({
        canvasUrl: form.canvasUrl.trim(),
        lmsProvider: form.lmsProvider,
      });
      setForm((current) => ({
        ...current,
        canvasUrl: current.canvasUrl.trim(),
      }));
      setStatus("Saved");
      return true;
    } catch (cause) {
      setStatus(String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }, [form, canvasToken, calendarUrl, lmsFeed]);

  /** Closing with unsaved edits asks first, instead of quietly throwing them away. */
  const requestClose = useCallback(() => {
    if (dirty) {
      setConfirmingClose(true);
      return;
    }
    onClose();
  }, [dirty, onClose]);

  const saveAndClose = useCallback(async () => {
    if (await save()) onClose();
    else setConfirmingClose(false);
  }, [save, onClose]);

  const discardAndClose = useCallback(() => {
    setForm(baseline);
    setCanvasToken("");
    setCalendarUrl("");
    setLmsFeed("");
    setConfirmingClose(false);
    onClose();
  }, [baseline, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (confirmingClose) setConfirmingClose(false);
        else requestClose();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, confirmingClose, requestClose, save]);

  if (!open) return null;

  const forget = async (key: string) => {
    await clearSecret(key).catch(() => undefined);
    if (key === SECRET_CANVAS_TOKEN) setCanvasTokenStored(false);
    else if (key === SECRET_LMS_FEED_URL) setLmsFeedStored(false);
    else setCalendarStored(false);
    setStatus("Removed from keychain");
  };

  /** The command drains the sample buffer first, so nothing already measured leaks back
   *  in on the next flush, and emits `nudgy://flushed` so every chart empties together. */
  const wipe = async () => {
    setWiping(true);
    try {
      const deleted = await clearActivityData();
      setStatus(`Cleared ${deleted.toLocaleString()} recorded samples`);
    } catch (cause) {
      setStatus(String(cause));
    } finally {
      setWiping(false);
    }
  };

  const update = (patch: Partial<SettingsForm>) =>
    setForm((current) => ({ ...current, ...patch }));

  return (
    <div
      className="scroll-area fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-8 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className="relative w-full max-w-lg rounded-2xl border border-edge bg-surface p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-ink">Settings</h2>
            {dirty && (
              <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-medium text-warn">
                Unsaved
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close settings"
            className="rounded-lg p-1 text-ink-mute transition hover:bg-canvas hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>

        <div className="mt-6 space-y-5">
          <div>
            <span className="text-xs font-medium tracking-wide text-ink-soft">Colours</span>
            <p className="mt-1 text-xs text-ink-mute">
              Applies straight away. Category colours are set on the App registry tab and
              are left alone — they mean something specific, so a theme does not repaint
              them.
            </p>
            <ul className="mt-2.5 flex flex-wrap gap-2">
              {THEMES.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => void chooseTheme(entry.id)}
                    aria-pressed={entry.id === theme}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition ${
                      entry.id === theme
                        ? "border-edge-strong bg-canvas font-medium text-ink"
                        : "border-edge text-ink-soft hover:border-edge-strong"
                    }`}
                  >
                    <span className="flex shrink-0 overflow-hidden rounded-full border border-edge">
                      {entry.swatch.map((shade) => (
                        <span
                          key={shade}
                          className="h-3.5 w-3"
                          style={{ background: shade }}
                        />
                      ))}
                    </span>
                    {entry.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <label className="block">
            <span className="text-xs font-medium tracking-wide text-ink-soft">
              Where your coursework comes from
            </span>
            <select
              value={form.lmsProvider}
              onChange={(event) => update({ lmsProvider: event.target.value as LmsProvider })}
              className="mt-1.5 w-full rounded-lg border border-edge bg-canvas px-2.5 py-2 text-sm text-ink-soft outline-none transition focus:border-edge-strong"
            >
              {(Object.keys(LMS_LABELS) as LmsProvider[]).map((id) => (
                <option key={id} value={id}>
                  {LMS_LABELS[id].name}
                </option>
              ))}
            </select>
          </label>

          <SecretField
            label={`Your ${LMS_LABELS[form.lmsProvider].name} calendar URL`}
            stored={lmsFeedStored}
            value={lmsFeed}
            onChange={setLmsFeed}
            onForget={() => void forget(SECRET_LMS_FEED_URL)}
          />
          <p className="-mt-3 text-xs text-ink-mute">
            {LMS_LABELS[form.lmsProvider].where} No API key needed. A feed carries titles
            and due dates but not what you have handed in, so ticking work off stays
            manual.
          </p>

          {/* Canvas only, and framed as the upgrade it is rather than the way in. */}
          {form.lmsProvider === "canvas" && (
            <details className="rounded-xl border border-edge bg-canvas px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-ink-soft">
                Have a Canvas API token? It adds submission status
              </summary>
              <div className="mt-3 space-y-3">
                <p className="text-xs text-ink-mute">
                  With a token Nudgy can see what you have already submitted and tick it
                  off for you. Many institutions disable tokens — if yours has, the
                  calendar URL above is the whole feature minus that.
                </p>
                <Field
                  label="Canvas base URL"
                  hint="e.g. https://canvas.institution.edu"
                  value={form.canvasUrl}
                  onChange={(canvasUrl) => update({ canvasUrl })}
                />
                <SecretField
                  label="Canvas API token"
                  stored={canvasTokenStored}
                  value={canvasToken}
                  onChange={setCanvasToken}
                  onForget={() => void forget(SECRET_CANVAS_TOKEN)}
                />
              </div>
            </details>
          )}

          <div className="border-t border-edge pt-5">
            <SecretField
              label="Google Calendar secret iCal URL"
              stored={calendarStored}
              value={calendarUrl}
              onChange={setCalendarUrl}
              onForget={() => void forget(SECRET_CALENDAR_ICS_URL)}
            />
            <p className="mt-1 text-xs text-ink-mute">
              Google Calendar → Settings and sharing → Integrate calendar → “Secret address
              in iCal format”. Anyone with that link can read the calendar, so it is kept
              in the keychain.
            </p>
          </div>

          <div className="border-t border-edge pt-5">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={autostart}
                onChange={async (event) => {
                  const next = event.target.checked;
                  setAutostart(next);
                  try {
                    if (next) await enableAutostart();
                    else await disableAutostart();
                  } catch (cause) {
                    setAutostart(!next);
                    setStatus(String(cause));
                  }
                }}
                className="mt-0.5 h-4 w-4 shrink-0 accent-rose"
              />
              <span>
                <span className="text-xs font-medium tracking-wide text-ink-soft">
                  Start Nudgy when I log in
                </span>
                <span className="mt-1 block text-xs text-ink-mute">
                  Nudgy opens by itself after you restart or sign in, so the day is tracked
                  without you having to remember. It starts in the background — no window
                  appears until you click the tray icon. Turn this off and nothing is
                  tracked between a reboot and the next time you open it, which is also how
                  a streak gets lost to a restart rather than to you.
                </span>
              </span>
            </label>
          </div>

          <div className="border-t border-edge pt-5">
            <span className="text-xs font-medium tracking-wide text-ink-soft">
              Tracked activity
            </span>
            <p className="mt-1 text-xs text-ink-mute">
              Deletes every recorded sample, so categories can be tested against a clean
              day. Plans, schedule, tasks and your app rules are kept.
            </p>
            <button
              type="button"
              disabled={wiping}
              onClick={() => setConfirmingWipe(true)}
              className="mt-2.5 rounded-lg border border-edge px-3 py-1.5 text-xs text-ink-soft transition hover:border-bad/40 hover:text-bad disabled:opacity-50"
            >
              {wiping ? "Clearing…" : "Clear tracked activity"}
            </button>
          </div>
        </div>

        <ConfirmDialog
          open={confirmingWipe}
          title="Clear tracked activity?"
          body="Every recorded sample is deleted, so today's chart and every past day go back to empty. Plans, schedule blocks, Canvas tasks and your app rules are kept. This cannot be undone."
          confirmLabel="Delete it all"
          onConfirm={() => {
            setConfirmingWipe(false);
            void wipe();
          }}
          onCancel={() => setConfirmingWipe(false)}
        />

        <p className="mt-5 flex items-start gap-2 text-xs text-ink-mute">
          <KeyRound size={13} className="mt-0.5 shrink-0" />
          Tokens are stored in the system keychain, never in Nudgy's database and never
          sent back to this window.
        </p>

        <div className="mt-6 flex items-center justify-end gap-3">
          {status && <span className="mr-auto text-xs text-ink-mute">{status}</span>}
          <button
            type="button"
            onClick={requestClose}
            className="rounded-lg px-4 py-2 text-sm text-ink-mute transition hover:text-ink"
          >
            Close
          </button>
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => void save()}
            className="rounded-lg bg-rose px-4 py-2 text-sm font-medium text-white transition hover:bg-rose-deep disabled:bg-rose-wash disabled:text-rose-deep disabled:opacity-60"
          >
            {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
        </div>

        {confirmingClose && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-surface/85 p-6 backdrop-blur-sm">
            <div className="w-full max-w-xs rounded-xl border border-edge bg-surface p-5 shadow-xl">
              <div className="flex items-center gap-2">
                <TriangleAlert size={16} className="text-warn" />
                <h3 className="text-sm font-semibold text-ink">Unsaved changes</h3>
              </div>
              <p className="mt-2 text-xs text-ink-soft">
                You've changed settings without saving. Save them before closing?
              </p>

              <div className="mt-4 space-y-2">
                <button
                  type="button"
                  onClick={() => void saveAndClose()}
                  className="w-full rounded-lg bg-rose py-2 text-xs font-semibold text-white transition hover:bg-rose-deep"
                >
                  Save and close
                </button>
                <button
                  type="button"
                  onClick={discardAndClose}
                  className="w-full rounded-lg border border-edge py-2 text-xs font-medium text-ink-soft transition hover:border-bad/40 hover:text-bad"
                >
                  Discard changes
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingClose(false)}
                  className="w-full rounded-lg py-2 text-xs text-ink-mute transition hover:text-ink"
                >
                  Keep editing
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium tracking-wide text-ink-soft">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5 w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-ink outline-none transition select-text focus:border-edge-strong"
      />
      {hint && <span className="mt-1 block text-xs text-ink-mute">{hint}</span>}
    </label>
  );
}

function SecretField({
  label,
  stored,
  value,
  onChange,
  onForget,
}: {
  label: string;
  stored: boolean;
  value: string;
  onChange: (next: string) => void;
  onForget: () => void;
}) {
  return (
    <label className="block">
      <span className="flex items-center justify-between text-xs font-medium tracking-wide text-ink-soft">
        <span className="flex items-center gap-1.5">
          {label}
          {stored && (
            <span className="rounded-full bg-ok/15 px-1.5 py-0.5 text-[9px] font-medium text-ok">
              saved
            </span>
          )}
        </span>
        {stored && (
          <button
            type="button"
            onClick={onForget}
            className="text-xs font-normal text-ink-mute underline underline-offset-2 hover:text-bad"
          >
            forget
          </button>
        )}
      </span>
      <input
        type="password"
        value={value}
        autoComplete="off"
        placeholder={stored ? "•••••••• stored in keychain" : "paste value"}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5 w-full rounded-lg border border-edge bg-canvas px-3 py-2 text-sm text-ink outline-none transition select-text focus:border-edge-strong"
      />
    </label>
  );
}
