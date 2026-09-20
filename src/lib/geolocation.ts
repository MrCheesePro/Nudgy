/**
 * Asking the machine where it is.
 *
 * Two paths, best first. `navigator.geolocation` is precise to a doorstep, but on a
 * desktop webview it may be unavailable, denied, or simply never answer — so it is raced
 * against a timeout rather than awaited in good faith. Whatever it returns (including
 * nothing) is handed to the backend, which falls back to inferring a rougher position
 * from the network.
 *
 * Nothing here decides anything. It gathers a hint; `detect_current_location` is what
 * actually resolves and stores a place.
 */

/** Past this, assume the prompt is sitting unanswered behind the window. */
const GEOLOCATION_TIMEOUT_MS = 6000;

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export async function browserCoordinates(): Promise<Coordinates | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Coordinates | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    // A webview that never calls either callback would otherwise hang the button.
    const timer = window.setTimeout(() => finish(null), GEOLOCATION_TIMEOUT_MS);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        window.clearTimeout(timer);
        finish({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      },
      () => {
        window.clearTimeout(timer);
        finish(null);
      },
      { enableHighAccuracy: false, timeout: GEOLOCATION_TIMEOUT_MS, maximumAge: 5 * 60 * 1000 },
    );
  });
}
