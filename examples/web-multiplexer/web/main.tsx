import { createRoot } from "react-dom/client";
import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import "@xterm/xterm/css/xterm.css";
import "./fonts.css";
import { App } from "./App.tsx";

const theme = createTheme({
  primaryColor: "teal",
  defaultRadius: "sm",
});

// [LAW:single-enforcer] Demo connection lifecycle is owned by App. React
// StrictMode's intentional double-mount injects synthetic connect/disconnect
// churn that is unrelated to the bridge behavior this example validates.
createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme} defaultColorScheme="dark">
    <App />
  </MantineProvider>,
);
