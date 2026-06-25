import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { BRIDGE_PORT, WEB_PORT } from "./shared/config";

// Four HTML entries, one toolchain. Vite emits:
//   dist/index.html             (web entry, web/main.tsx → WebSocketBridge)
//   dist/electron/index.html    (electron entry, web/main-electron.tsx → ElectronBridge)
//   dist/mirror.html            (read-only viewer, web/main-mirror.tsx → MirrorViewerBridge)
//   dist/collab.html            (read-write collaborator, web/main-collab.tsx → CollabBridge)
//
// `pnpm run dev:web` keeps serving the web entry from the project root for
// fast iteration; the Electron path is build-only (pnpm run demo:electron).
//
// Asset path policy: the web target loads over http(s) from a Vite server,
// so absolute paths (/assets/...) are correct. The Electron target loads
// over file:// where absolute paths resolve to the filesystem root and
// 404; emitted assets must be referenced relatively. We set
// `base: ./` only when ELECTRON_BUILD=1 — the build:electron script
// flips it.
const electronBuild = process.env.ELECTRON_BUILD === "1";

export default defineConfig({
  plugins: [react()],
  base: electronBuild ? "./" : "/",
  server: {
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      "/ws": {
        target: `ws://localhost:${BRIDGE_PORT}`,
        ws: true,
        changeOrigin: true,
      },
      // Read-only pane-mirror endpoint the second-browser viewer dials. A path
      // distinct from the `/mirror.html` PAGE (which Vite serves statically) so
      // this prefix-matched proxy never shadows the page.
      "/mirror-ws": {
        target: `ws://localhost:${BRIDGE_PORT}`,
        ws: true,
        changeOrigin: true,
      },
      // Collaborative (read-write) pane endpoint the second-browser page dials.
      // A path distinct from the `/collab.html` PAGE (served statically) so this
      // prefix-matched proxy never shadows the page.
      "/collab-ws": {
        target: `ws://localhost:${BRIDGE_PORT}`,
        ws: true,
        changeOrigin: true,
      },
      // AI co-pilot LLM relay — the ONE non-WebSocket bridge route (an HTTP
      // request/response RPC). `ws` is omitted; this is a plain http proxy to
      // the bridge, which holds the LLM endpoint + key.
      "/copilot": {
        target: `http://localhost:${BRIDGE_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        electron: resolve(__dirname, "electron/index.html"),
        // Standalone read-only viewer page (the "second browser").
        mirror: resolve(__dirname, "mirror.html"),
        // Standalone read-write collaborator page (the "second browser" that
        // can also type).
        collab: resolve(__dirname, "collab.html"),
      },
    },
  },
});
