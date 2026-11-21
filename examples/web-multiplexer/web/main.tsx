import { mountRoot } from "./mount-root.ts";
import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import "@xterm/xterm/css/xterm.css";
import "./fonts.css";
import "./window-terminal.css";
import { App } from "./App.tsx";
import { webSocketBridge } from "./ws-bridge.ts";
import { HttpLlmClient } from "./llm-client.ts";

const theme = createTheme({
  primaryColor: "teal",
  defaultRadius: "sm",
});

// [LAW:single-enforcer] One bridge per page load. App calls connect/
// disconnect through React lifecycles; both are idempotent so React
// StrictMode's intentional double-mount in dev is benign.
const bridge = webSocketBridge();

mountRoot(
  <MantineProvider theme={theme} defaultColorScheme="dark">
    <App bridge={bridge} llm={new HttpLlmClient()} />
  </MantineProvider>,
);
