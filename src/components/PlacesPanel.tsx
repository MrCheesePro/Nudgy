import { useEffect, useState } from "react";
import { Crosshair, Home, Loader2, MapPin, Plus, RefreshCw, Trash2 } from "lucide-react";

import {
  addPlace,
  detectCurrentLocation,
  deletePlace,
  getPlaces,
  getTravelTimes,
  lookupTravel,
  setBasePlace,
  setTravelTime,
} from "../lib/ipc";
import { browserCoordinates } from "../lib/geolocation";
import { describeTravel } from "../services/travel";
import type { Place, TravelRow } from "../lib/types";

/**
 * The places a day happens in, and how far apart they are.
 *
 * One of them is the base — where you start and end — because "how long before I have to
 * leave" is meaningless without somewhere to leave from. Travel times are looked up once
 * and kept: an address does not move, so a plan made offline still knows how far the
 * library is.
 */
export function PlacesPanel({ onChanged }: { onChanged?: () => void }) {
  const [places, setPlaces] = useState<Place[]>([]);
  const [travel, setTravel] = useState<TravelRow[]>([]);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = async () => {
    const [nextPlaces, nextTravel] = await Promise.all([
      getPlaces().catch(() => []),
      getTravelTimes().catch(() => []),
    ]);
    setPlaces(nextPlaces);
    setTravel(nextTravel);
    onChanged?.();
  };

  useEffect(() => {
    void load();
    // `load` is stable enough here — it closes over nothing that changes per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const base = places.find((place) => place.isBase) ?? null;

  /** Minutes from the base to this place, if that leg has ever been looked up. */
  const fromBase = (place: Place): number | null => {
    if (!base || place.id === base.id) return null;
    const row =
      travel.find(([from, to]) => from === base.id && to === place.id) ??
      travel.find(([from, to]) => from === place.id && to === base.id);
    return row ? row[3] : null;
  };

  const run = async (key: string, action: () => Promise<string | null>) => {
    setBusy(key);
    setStatus(null);
    try {
      setStatus(await action());
      await load();
    } catch (cause) {
      setStatus(String(cause));
    } finally {
      setBusy(null);
    }
  };

  /** Minutes being typed, before they are committed on blur. */
  const [draft, setDraft] = useState<Record<number, string>>({});

  const saveMinutes = (place: Place) => {
    const typed = draft[place.id];
    if (typed === undefined) return Promise.resolve();
    const minutes = Number(typed);
    const current = fromBase(place);
    // Nothing typed, or the same number that is already stored: no write, no message.
    if (typed.trim() === "" || !Number.isFinite(minutes) || minutes <= 0) {
      setDraft(({ [place.id]: _dropped, ...rest }) => rest);
      return Promise.resolve();
    }
    if (current !== null && Math.round(current / 60) === minutes) {
      setDraft(({ [place.id]: _dropped, ...rest }) => rest);
      return Promise.resolve();
    }

    return run(`minutes:${place.id}`, async () => {
      if (!base) return "Set a base first — travel is measured from it.";
      await setTravelTime(base.id, place.id, minutes);
      setDraft(({ [place.id]: _dropped, ...rest }) => rest);
      return `${base.name} → ${place.name}: ${minutes} min.`;
    });
  };

  /** Detects where you are and makes it the base, so nothing has to be typed first. */
  const detect = () =>
    run("detect", async () => {
      // The browser first, because a doorstep beats a neighbourhood. It is allowed to
      // decline or to never answer; the backend then infers a rougher position.
      const coords = await browserCoordinates();
      const found = await detectCurrentLocation(coords?.latitude, coords?.longitude);
      return found.coarse
        ? `Found you near ${found.address} — rough, but enough to time a trip. Edit it if you want exact.`
        : `You are at ${found.address}. macOS will ask permission the first time.`;
    });

  const measure = (place: Place) =>
    run(`measure:${place.id}`, async () => {
      if (!base) return "Set a base first — travel is measured from it.";
      const estimate = await lookupTravel(base.id, place.id, "driving", true);
      return `${base.name} → ${place.name}: ${describeTravel(estimate.seconds)}`;
    });

  return (
    <div className="border-t border-edge pt-5">
      <span className="text-xs font-medium tracking-wide text-ink-soft">Places</span>
      <p className="mt-1 text-xs text-ink-mute">
        Somewhere you go, and how far it is from your base. The base is where a day
        starts and ends — travel to your first commitment is counted from there, so a 2pm
        class twenty-five minutes away ends your morning at 1:35. Type the minutes if you
        know them; the refresh button looks them up instead, and needs a maps API key.
      </p>

      {places.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {places.map((place) => {
            const seconds = fromBase(place);
            return (
              <li
                key={place.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-canvas px-2.5 py-2"
              >
                <button
                  type="button"
                  title={place.isBase ? "This is your base" : "Make this the base"}
                  aria-label={place.isBase ? `${place.name} is the base` : `Make ${place.name} the base`}
                  disabled={place.isBase || busy !== null}
                  onClick={() =>
                    void run(`base:${place.id}`, async () => {
                      await setBasePlace(place.id);
                      return `${place.name} is now your base.`;
                    })
                  }
                  className={`shrink-0 rounded p-1 transition ${
                    place.isBase
                      ? "text-rose-deep"
                      : "text-ink-mute hover:text-ink-soft disabled:opacity-50"
                  }`}
                >
                  {place.isBase ? <Home size={13} /> : <MapPin size={13} />}
                </button>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-ink">
                    {place.name}
                    {place.isBase && (
                      <span className="ml-1.5 text-[10px] tracking-wide text-ink-mute uppercase">
                        base
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[10px] text-ink-mute">
                    {place.address || "no address — type the minutes instead"}
                  </div>
                </div>

                {place.isBase ? (
                  <span className="shrink-0 font-mono text-[10px] text-ink-mute">—</span>
                ) : (
                  <>
                    {/* Typed minutes and looked-up minutes land in the same row, so
                        someone who knows their own commute never needs an API key. */}
                    <label className="flex shrink-0 items-center gap-1">
                      <input
                        type="number"
                        min={1}
                        inputMode="numeric"
                        value={draft[place.id] ?? (seconds !== null ? Math.round(seconds / 60) : "")}
                        placeholder="—"
                        aria-label={`Minutes from base to ${place.name}`}
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, [place.id]: event.target.value }))
                        }
                        onBlur={() => void saveMinutes(place)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                        className="w-12 rounded border border-edge bg-surface px-1.5 py-0.5 text-right font-mono text-[10px] tabular-nums text-ink-soft outline-none focus:border-edge-strong"
                      />
                      <span className="text-[10px] text-ink-mute">min</span>
                    </label>

                    <button
                      type="button"
                      title="Look it up instead (needs a maps API key)"
                      aria-label={`Measure travel to ${place.name}`}
                      disabled={busy !== null}
                      onClick={() => void measure(place)}
                      className="shrink-0 rounded p-1 text-ink-mute transition hover:text-ink-soft disabled:opacity-50"
                    >
                      {busy === `measure:${place.id}` ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <RefreshCw size={12} />
                      )}
                    </button>
                  </>
                )}

                <button
                  type="button"
                  aria-label={`Remove ${place.name}`}
                  disabled={busy !== null}
                  onClick={() =>
                    void run(`delete:${place.id}`, async () => {
                      await deletePlace(place.id);
                      return `${place.name} removed.`;
                    })
                  }
                  className="shrink-0 rounded p-1 text-ink-mute transition hover:text-bad disabled:opacity-50"
                >
                  <Trash2 size={12} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void detect()}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-edge bg-canvas px-3 py-2 text-xs font-medium text-ink-soft transition hover:border-edge-strong disabled:opacity-50"
      >
        {busy === "detect" ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Crosshair size={13} />
        )}
        Use where I am now
      </button>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Campus"
          className="min-w-25 flex-1 rounded-lg border border-edge bg-canvas px-2.5 py-1.5 text-xs text-ink-soft outline-none focus:border-edge-strong"
        />
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="400 College Ave (optional)"
          className="min-w-40 flex-2 rounded-lg border border-edge bg-canvas px-2.5 py-1.5 text-xs text-ink-soft outline-none focus:border-edge-strong"
        />
        <button
          type="button"
          disabled={!name.trim() || busy !== null}
          onClick={() =>
            void run("add", async () => {
              const added = name.trim();
              await addPlace(added, address.trim());
              setName("");
              setAddress("");
              return places.length === 0
                ? `${added} added, and set as your base.`
                : `${added} added. Type how many minutes away it is, or look it up.`;
            })
          }
          className="flex items-center gap-1.5 rounded-lg bg-rose-wash px-3 py-1.5 text-xs font-medium text-rose-deep transition hover:bg-edge-strong disabled:opacity-40"
        >
          <Plus size={13} />
          Add
        </button>
      </div>

      {status && <p className="mt-2 text-[11px] text-ink-mute">{status}</p>}
    </div>
  );
}
