import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// [LAW:one-source-of-truth] Bridge port lives in exactly one place.
// Change it here AND in server/bridge.ts if you need a different port.
const BRIDGE_PORT = 5174;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        target: `ws://localhost:${BRIDGE_PORT}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
