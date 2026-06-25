// examples/web-multiplexer/web/main-electron.tsx
// Renderer entry point for the Electron variant. Constructs an
// ElectronBridge against window.tmuxIpc (exposed by the preload script
// under contextIsolation+sandbox) and renders the same App.tsx tree the
// web entry uses.
//
// [LAW:one-source-of-truth] One App component, two entry points. Adding
// a UI feature in App is automatically picked up by both transports.

import { createRoot } from "react-dom/client";
import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import "@xterm/xterm/css/xterm.css";
import "./fonts.css";
import { App } from "./App.tsx";
import { ElectronBridge } from "./electron-bridge.ts";
import { getDemoIpc } from "./demo-ipc.ts";
import type { IpcRendererLike } from "@promptctl/tmux-control-mode-js/electron/renderer";

declare global {
  interface Window {
    /**
     * Provided by examples/web-multiplexer/electron/preload.ts via
     * contextBridge.exposeInMainWorld. Structurally assignable to the
     * library's IpcRendererLike contract — no casts needed downstream.
     */
    readonly tmuxIpc: IpcRendererLike;
  }
}

const theme = createTheme({
  primaryColor: "teal",
  defaultRadius: "sm",
});

// demoIpc is always present in the Electron variant (exposed by preload.ts);
// the firehose channel rides it. [LAW:no-silent-failure] If the preload didn't
// install it, fail loudly at construction rather than silently losing the
// firehose feature.
const demoIpc = getDemoIpc();
if (demoIpc === null) {
  throw new Error(
    "Electron entry: window.demoIpc is missing — preload did not expose it",
  );
}
const bridge = new ElectronBridge(window.tmuxIpc, demoIpc);

// connectUrl is unused by ElectronBridge — pass an empty string to keep
// the App prop contract uniform across transports.
createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme} defaultColorScheme="dark">
    <App bridge={bridge} connectUrl="" />
  </MantineProvider>,
);
