import { useCallback, useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, ChevronRight, ExternalLink, Megaphone, RefreshCw } from "lucide-react";

import {
  clearAnnouncementsFeed,
  getAnnouncements,
  hasAnnouncementsFeed,
  setAnnouncementsFeed,
} from "../lib/ipc";
import { usePref } from "../lib/prefs";
import type { Announcement } from "../lib/types";

/** Newer than this is marked New. */
const NEW_SECONDS = 3 * 86_400;
/** Shown before "Show all". */
const FIRST_FEW = 4;

function when(ts: number | null): string {
  if (ts === null) return "";
  const days = Math.floor((Date.now() / 1000 - ts) / 86_400);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(ts * 1000).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

/**
 * A class's announcements, from its Canvas feed.
 *
 * Canvas gives each class a private feed of its announcements — the RSS link on the
 * Announcements page — so this needs no API token, only that link, pasted once. The link
 * is kept in the keychain like the other feeds, and the announcements are read fresh each
 * time the class is opened and never saved.
 */
export function AnnouncementsPanel({ courseId }: { courseId: number }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [entries, setEntries] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  // One switch for every class: hiding announcements is a preference, not a per-class state.
  const [hidden, setHidden] = usePref("announcements:hidden", false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await getAnnouncements(courseId));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    let live = true;
    void hasAnnouncementsFeed(courseId)
      .then((has) => {
        if (!live) return;
        setConnected(has);
        if (has) void load();
      })
      .catch(() => live && setConnected(false));
    return () => {
      live = false;
    };
  }, [courseId, load]);

  const connect = async () => {
    setSaving(true);
    setError(null);
    try {
      await setAnnouncementsFeed(courseId, link.trim());
      setLink("");
      setConnected(true);
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  };

  const now = Date.now() / 1000;
  const shown = all ? entries : entries.slice(0, FIRST_FEW);

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setHidden(!hidden)}
          aria-expanded={!hidden}
          title={hidden ? "Show announcements" : "Hide announcements"}
          className="flex items-center gap-1.5 text-mini font-semibold tracking-wider text-ink-soft uppercase transition hover:text-ink"
        >
          {hidden ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <Megaphone size={12} />
          Announcements
        </button>
        {connected && !hidden && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              title="Check for new announcements"
              className="flex items-center gap-1 text-mini text-ink-mute transition hover:text-ink-soft disabled:opacity-50"
            >
              <RefreshCw size={11} className={loading ? "animate-spin" : undefined} />
              Refresh
            </button>
            <button
              type="button"
              onClick={() =>
                void clearAnnouncementsFeed(courseId).then(() => {
                  setConnected(false);
                  setEntries([]);
                })
              }
              title="Forget this class's announcements link"
              className="text-mini text-ink-mute transition hover:text-bad"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>

      {!hidden && (
        <>
          {connected === false && (
            <div className="mt-2 rounded-xl border border-dashed border-edge p-3">
              <p className="text-xs leading-relaxed text-ink-soft">
                In Canvas, open this class's <b>Announcements</b>, click the <b>RSS</b> feed link at
                the top right, and copy that page's address. No token needed.
              </p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  value={link}
                  onChange={(event) => setLink(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && link.trim() && void connect()}
                  placeholder="https://…/feeds/announcements/enrollment_….atom"
                  className="min-w-0 flex-1 rounded-lg border border-edge bg-canvas px-2.5 py-1.5 font-mono text-mini text-ink-soft outline-none select-text focus:border-edge-strong"
                />
                <button
                  type="button"
                  disabled={!link.trim() || saving}
                  onClick={() => void connect()}
                  className="rounded-lg bg-rose px-3 py-1.5 text-mini font-semibold text-white transition hover:bg-rose-deep disabled:opacity-40"
                >
                  {saving ? "Checking…" : "Connect"}
                </button>
              </div>
            </div>
          )}

          {error && <p className="mt-2 text-xs text-bad">{error}</p>}

          {connected && !loading && entries.length === 0 && !error && (
            <p className="mt-2 py-3 text-center text-xs text-ink-mute">No announcements yet.</p>
          )}

          {connected && entries.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {shown.map((entry, index) => {
                const expanded = open === index;
                const fresh = entry.postedAt !== null && now - entry.postedAt < NEW_SECONDS;
                return (
                  <li
                    key={`${entry.postedAt}-${entry.title}`}
                    className="rounded-lg border border-edge"
                  >
                    <button
                      type="button"
                      onClick={() => setOpen(expanded ? null : index)}
                      aria-expanded={expanded}
                      className="w-full px-3 py-2 text-left transition hover:bg-canvas"
                    >
                      <span className="flex items-center gap-2">
                        {fresh && (
                          <span className="shrink-0 rounded-full bg-rose px-1.5 py-0.5 text-tiny font-semibold text-white">
                            New
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
                          {entry.title}
                        </span>
                        <span className="shrink-0 text-tiny text-ink-mute">
                          {when(entry.postedAt)}
                        </span>
                      </span>
                      <span
                        className={`mt-1 block text-xs leading-relaxed whitespace-pre-line text-ink-soft select-text ${
                          expanded ? "" : "line-clamp-2"
                        }`}
                      >
                        {entry.text}
                      </span>
                    </button>
                    {expanded && (
                      <div className="flex items-center justify-between gap-2 border-t border-edge px-3 py-1.5">
                        <span className="truncate text-tiny text-ink-mute">
                          {entry.author ?? ""}
                        </span>
                        {entry.url && (
                          <button
                            type="button"
                            onClick={() => void openUrl(entry.url as string).catch(() => undefined)}
                            className="flex shrink-0 items-center gap-1 text-mini text-ink-mute transition hover:text-ink-soft"
                          >
                            Open in Canvas <ExternalLink size={10} />
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {connected && entries.length > FIRST_FEW && (
            <button
              type="button"
              onClick={() => setAll((value) => !value)}
              className="mt-1.5 text-mini text-ink-mute transition hover:text-ink-soft"
            >
              {all ? "Show fewer" : `Show all ${entries.length}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
