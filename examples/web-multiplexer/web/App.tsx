// examples/web-multiplexer/web/App.tsx
// Top-level component — all UI state lives in a MobX DemoStore. Components
// use `observer()` and read store fields directly.

import { useEffect, useMemo } from "react";
import { observer } from "mobx-react-lite";
import { AppShell, Group, Title, Badge, Text, Stack, Tabs } from "@mantine/core";
import { BridgeClient } from "./ws-client.ts";
import { DemoStore } from "./store.ts";
import { SessionList } from "./components/SessionList.tsx";
import { WindowTabs } from "./components/WindowTabs.tsx";
import { PaneView } from "./components/PaneView.tsx";
import { DebugPanel } from "./components/DebugPanel.tsx";
import { ErrorPanel } from "./components/ErrorPanel.tsx";

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

export const App = observer(function App() {
  const store = useMemo(() => new DemoStore(new BridgeClient()), []);

  useEffect(() => {
    store.connect(WS_URL);
  }, [store]);

  const { currentSession, currentWindow, connState, sessions, events, errors } = store;

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 260, breakpoint: 0 }}
      aside={{ width: 380, breakpoint: 0 }}
      padding="md"
    >
      <AppShell.Header p="sm">
        <Group justify="space-between" h="100%">
          <Group gap="sm">
            <Title order={4}>tmux-control-mode-js</Title>
            <Text c="dimmed" size="sm">
              Web Multiplexer Demo
            </Text>
          </Group>
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              {sessions.length} sessions
            </Text>
            <Badge color={store.statusColor} variant="light">
              bridge: {connState}
            </Badge>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <SessionList store={store} />
      </AppShell.Navbar>

      <AppShell.Main>
        {currentSession === null ? (
          <Text c="dimmed">
            {connState === "ready"
              ? sessions.length === 0
                ? "No sessions visible — tmux returned an empty list."
                : "Pick a session from the sidebar."
              : `Connecting to bridge (${connState})…`}
          </Text>
        ) : (
          <Stack gap="sm" h="100%">
            <WindowTabs store={store} />
            {currentWindow !== null && <PaneView store={store} />}
          </Stack>
        )}
      </AppShell.Main>

      <AppShell.Aside p="sm">
        <Tabs defaultValue="debug">
          <Tabs.List>
            <Tabs.Tab value="debug">Debug ({events.length})</Tabs.Tab>
            <Tabs.Tab value="errors" color={errors.length > 0 ? "red" : undefined}>
              Errors ({errors.length})
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="debug" pt="xs">
            <DebugPanel events={events} />
          </Tabs.Panel>
          <Tabs.Panel value="errors" pt="xs">
            <ErrorPanel errors={errors} />
          </Tabs.Panel>
        </Tabs>
      </AppShell.Aside>
    </AppShell>
  );
});
