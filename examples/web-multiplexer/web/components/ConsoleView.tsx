// examples/web-multiplexer/web/components/ConsoleView.tsx
//
// Console tab shell. The Console turns the browser into an operator
// surface for the tmux server: a REPL that drives commands and a Format
// Playground that evaluates format strings live. The REPL pane
// (tmux-showcase-bhx.25.2) and the Format Playground pane (.25.3) each own
// their surface; this shell only lays them out side by side.
//
// The split is flex-basis driven rather than a media query: each panel
// wants ~420px, so the two sit side-by-side on wide viewports and stack
// vertically once the container drops below ~900px. [LAW:locality-or-seam]
// App.tsx mounts this with a stable prop shape, so landing the panes does
// not ripple back into App.

import { observer } from "mobx-react-lite";
import { Paper } from "@mantine/core";
import type { DemoStore } from "../store.ts";
import type { ConsoleStore } from "../console-store.ts";
import { ConsoleRepl } from "./ConsoleRepl.tsx";
import { ConsoleFormatPlayground } from "./ConsoleFormatPlayground.tsx";

interface Props {
  readonly store: ConsoleStore;
  readonly demoStore: DemoStore;
}

export const ConsoleView = observer(function ConsoleView({ store, demoStore }: Props) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "var(--mantine-spacing-md)",
        flex: 1,
        minHeight: 0,
        alignItems: "stretch",
      }}
    >
      <Paper
        withBorder
        p="md"
        style={{ flex: "1 1 420px", minWidth: 0, display: "flex", flexDirection: "column" }}
      >
        <ConsoleRepl store={store} />
      </Paper>

      <Paper
        withBorder
        p="md"
        style={{ flex: "1 1 420px", minWidth: 0, display: "flex", flexDirection: "column" }}
      >
        <ConsoleFormatPlayground store={store} demoStore={demoStore} />
      </Paper>
    </div>
  );
});
