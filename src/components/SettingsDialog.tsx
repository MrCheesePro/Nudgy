import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRound, TriangleAlert, X } from "lucide-react";

import { clearSecret, getSettings, hasSecret, setSecret, setSetting } from "../lib/ipc";
import {
  SECRET_CALENDAR_ICS_URL,
  SECRET_CANVAS_TOKEN,
  SECRET_LLM_API_KEY,
  SETTING_CANVAS_BASE_URL,
} from "../lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
}

const SETTING_LLM_BASE_URL = "llm_base_url";
const SETTING_LLM_MODEL = "llm_model";

const DEFAULT_LLM_URL = "https://api.openai.com/v1";
const DEFAULT_LLM_MODEL = "gpt-4o-mini";

/** The plain settings, as loaded. Secrets are not here — they are never read back. */
interface SettingsForm {
  canvasUrl: string;
  llmUrl: string;
  llmModel: string;
}

const EMPTY_FORM: SettingsForm = { canvasUrl: "", llmUrl: "", llmModel: "" };

export function SettingsDialog({ open, onClose }: Props) {
  const [form, setForm] = useState<SettingsForm>(EMPTY_FORM);
  /** What was loaded from disk — the yardstick for "has anything changed?". */
  const [baseline, setBaseline] = useState<SettingsForm>(EMPTY_FORM);

  const [canvasToken, setCanvasToken] = useState("");
  const [llmKey, setLlmKey] = useState("");
  const [calendarUrl, setCalendarUrl] = useState("");

  const [canvasTokenStored, setCanvasTokenStored] = useState(false);
  const [llmKeyStored, setLlmKeyStored] = useState(false);
  const [calendarStored, setCalendarStored] = useState(false);

  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const settings = new Map(await getSettings().catch(() => []));
      const loaded: SettingsForm = {
        canvasUrl: settings.get(SETTING_CANVAS_BASE_URL) ?? "",
        llmUrl: settings.get(SETTING_LLM_BASE_URL) ?? DEFAULT_LLM_URL,
        llmModel: settings.get(SETTING_LLM_MODEL) ?? DEFAULT_LLM_MODEL,
      };
      setForm(loaded);
      setBaseline(loaded);

      setCanvasTokenStored(await hasSecret(SECRET_CANVAS_TOKEN).catch(() => false));
      setLlmKeyStored(await hasSecret(SECRET_LLM_API_KEY).catch(() => false));
      setCalendarStored(await hasSecret(SECRET_CALENDAR_ICS_URL).catch(() => false));

      setCanvasToken("");
      setLlmKey("");
      setCalendarUrl("");
      setStatus(null);
      setConfirmingClose(false);
    })();
  }, [open]);

  // Typing into a secret field counts: the value is write-only, so anything in the box
  // is by definition not yet saved.
  const dirty = useMemo(
    () =>
      form.canvasUrl !== baseline.canvasUrl ||
      form.llmUrl !== baseline.llmUrl ||
      form.llmModel !== baseline.llmModel ||
      canvasToken.trim() !== "" ||
      llmKey.trim() !== "" ||
      calendarUrl.trim() !== "",
    [form, baseline, canvasToken, llmKey, calendarUrl],
  );

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await setSetting(SETTING_CANVAS_BASE_URL, form.canvasUrl.trim());
      await setSetting(SETTING_LLM_BASE_URL, form.llmUrl.trim());
      await setSetting(SETTING_LLM_MODEL, form.llmModel.trim());

      // A blank secret field means "leave the keychain alone", not "erase it" — blank is
      // the normal state, since the stored value is never echoed back into the form.
      if (canvasToken.trim()) {
        await setSecret(SECRET_CANVAS_TOKEN, canvasToken.trim());
        setCanvasTokenStored(true);
        setCanvasToken("");
      }
      if (llmKey.trim()) {
        await setSecret(SECRET_LLM_API_KEY, llmKey.trim());
        setLlmKeyStored(true);
        setLlmKey("");
      }
      if (calendarUrl.trim()) {
        await setSecret(SECRET_CALENDAR_ICS_URL, calendarUrl.trim());
        setCalendarStored(true);
        setCalendarUrl("");
      }

      setBaseline({
        canvasUrl: form.canvasUrl.trim(),
        llmUrl: form.llmUrl.trim(),
        llmModel: form.llmModel.trim(),
      });
      setForm((current) => ({
        canvasUrl: current.canvasUrl.trim(),
        llmUrl: current.llmUrl.trim(),
        llmModel: current.llmModel.trim(),
      }));
      setStatus("Saved");
      return true;
    } catch (cause) {
      setStatus(String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }, [form, canvasToken, llmKey, calendarUrl]);

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
    setLlmKey("");
    setCalendarUrl("");
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
    else if (key === SECRET_CALENDAR_ICS_URL) setCalendarStored(false);
    else setLlmKeyStored(false);
    setStatus("Removed from keychain");
  };

  const update = (patch: Partial<SettingsForm>) =>
    setForm((current) => ({ ...current, ...patch }));

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/25 p-8 backdrop-blur-sm"
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
            <Field
              label="LLM endpoint"
              hint="Any OpenAI-compatible /chat/completions server"
              value={form.llmUrl}
              onChange={(llmUrl) => update({ llmUrl })}
            />
          </div>

          <Field
            label="Model"
            value={form.llmModel}
            onChange={(llmModel) => update({ llmModel })}
          />

          <SecretField
            label="LLM API key"
            stored={llmKeyStored}
            value={llmKey}
            onChange={setLlmKey}
            onForget={() => void forget(SECRET_LLM_API_KEY)}
          />
        </div>

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
