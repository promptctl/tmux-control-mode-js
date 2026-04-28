import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { BRIDGE_PORT, WEB_PORT } from "./shared/config";

// Two HTML entries, one toolchain. Vite emits:
//   dist/index.html             (web entry, web/main.tsx → WebSocketBridge)
//   dist/electron/index.html    (electron entry, web/main-electron.tsx → ElectronBridge)
//
// `npm run dev:web` keeps serving the web entry from the project root for
// fast iteration; the Electron path is build-only (npm run demo:electron).
export default defineConfig({
  plugins: [react()],
  server: {
    port: WEB_PORT,
    strictPort: true,
    proxy: {
      "/ws": {
        target: `ws://localhost:${BRIDGE_PORT}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        electron: resolve(__dirname, "electron/index.html"),
      },
    },
  },
});
