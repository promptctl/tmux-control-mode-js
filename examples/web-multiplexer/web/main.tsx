import { createRoot } from "react-dom/client";
import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import "@xterm/xterm/css/xterm.css";
import "./fonts.css";
import { App } from "./App.tsx";
import { WSBridge } from "./ws-bridge.ts";

const theme = createTheme({
  primaryColor: "teal",
  defaultRadius: "sm",
});

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

// [LAW:single-enforcer] One bridge per page load. App calls connect/
// disconnect through React lifecycles; both are idempotent so React
// StrictMode's intentional double-mount in dev is benign.
const bridge = new WSBridge();

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme} defaultColorScheme="dark">
    <App bridge={bridge} connectUrl={WS_URL} />
  </MantineProvider>,
);
