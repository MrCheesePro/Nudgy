/**
 * Which desktop this window is drawn on.
 *
 * Only the chrome cares. macOS draws its close/minimise/zoom buttons over the top-left
 * of the webview when the title bar is set to `Overlay`, so the app has to leave that
 * corner empty; Windows and Linux keep a title bar of their own above the page and need
 * no such gap. Getting it wrong is visible either way — a hole in the corner, or the
 * breadcrumb underneath three buttons.
 *
 * Read from the user agent rather than `@tauri-apps/plugin-os` because this is needed
 * during the first render, and a plugin call is a promise.
 */
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/**
 * Width of the macOS traffic lights plus the margin around them.
 *
 * Apple does not publish this and it has not moved in years: three 12px buttons on 20px
 * centres starting 20px in. 78px clears them with a little air.
 */
export const TRAFFIC_LIGHTS_WIDTH = 78;
