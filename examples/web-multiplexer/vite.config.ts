import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { BRIDGE_PORT, WEB_PORT } from "./shared/config";

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
});
