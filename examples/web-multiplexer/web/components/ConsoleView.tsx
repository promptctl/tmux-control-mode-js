// examples/web-multiplexer/web/components/ConsoleView.tsx
//
// Console tab shell. The Console turns the browser into an operator
// surface for the tmux server: a REPL that drives commands and a Format
// Playground that evaluates format strings live. This is the foundation
// slice (tmux-showcase-bhx.25.1) — the layout shell with placeholders.
// The REPL pane (25.2) and the Format Playground pane (25.3) replace the
// placeholders with their respective components, both reading `store`.
//
// The split is flex-basis driven rather than a media query: each panel
// wants ~420px, so the two sit side-by-side on wide viewports and stack
// vertically once the container drops below ~900px. [LAW:locality-or-seam]
// App.tsx mounts this with a stable prop shape, so landing the panes does
// not ripple back into App.

import { observer } from "mobx-react-lite";
import { Paper, Stack, Group, Title, Text, Code } from "@mantine/core";
import type { DemoStore } from "../store.ts";
import type { ConsoleStore } from "../console-store.ts";
import { ConsoleRepl } from "./ConsoleRepl.tsx";

interface Props {
  readonly store: ConsoleStore;
  readonly demoStore: DemoStore;
}

/** Total panes across every session/window — the Playground's target pool. */
function countPanes(demoStore: DemoStore): number {
  return demoStore.sessions.reduce(
    (acc, s) => acc + s.windows.reduce((a, w) => a + w.panes.length, 0),
    0,
  );
}

export const ConsoleView = observer(function ConsoleView({ store, demoStore }: Props) {
  const targetPool = countPanes(demoStore);

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
        <Group justify="space-between" mb="sm">
          <Title order={5}>Format Playground</Title>
          <Text size="xs" c="dimmed">
            {targetPool} target{targetPool === 1 ? "" : "s"}
          </Text>
        </Group>
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Evaluate a tmux format string live, one-shot or subscribed. Lands next.
          </Text>
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              format
            </Text>
            <Code>{store.playgroundFormat}</Code>
          </Group>
        </Stack>
      </Paper>
    </div>
  );
});
