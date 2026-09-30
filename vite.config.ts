import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

/**
 * What the built app's window may load. If a script were ever injected, this is what
 * stops it: no script but the app's own, no network but Tauri's IPC and assets, so it
 * could neither run more code nor send anything anywhere.
 *
 * - Fonts: Google Fonts, for the typeface picked in Appearance.
 * - Images: any https (a background picked by address), plus app assets and data URLs.
 * - Media: an imported notification sound is played from the app's data directory.
 * - Connect: Tauri's IPC — `ipc:` on macOS and Linux, `http://ipc.localhost` on Windows.
 *
 * Added to the built page only. The dev server injects an inline refresh script and talks
 * to itself over a websocket, and a policy strict enough to mean anything would block
 * both; Tauri's config-level CSP would also rewrite this one with nonces.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: asset: http://asset.localhost https:",
  "media-src 'self' data: blob: asset: http://asset.localhost",
  "connect-src 'self' ipc: http://ipc.localhost",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

const contentSecurityPolicy = {
  name: "nudgy-csp",
  apply: "build" as const,
  transformIndexHtml(html: string) {
    return html.replace(
      "<head>",
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
    );
  },
};

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss(), contentSecurityPolicy],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
