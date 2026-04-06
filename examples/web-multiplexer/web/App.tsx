// examples/web-multiplexer/web/App.tsx
// Top-level component. Two MobX stores:
//   - DemoStore: tmux model (sessions, windows, panes, events)
//   - UiStore:   UI preferences (navbar width, aside collapsed, filters)
// UiStore auto-persists to sessionStorage.

import { useEffect, useMemo } from "react";
import { observer } from "mobx-react-lite";
import {
  AppShell,
  Group,
  Title,
  Badge,
  Text,
  Stack,
  Tabs,
  ActionIcon,
  Tooltip,
} from "@mantine/core";
import { BridgeClient } from "./ws-client.ts";
import { DemoStore } from "./store.ts";
import { UiStore } from "./ui-store.ts";
import { SessionList } from "./components/SessionList.tsx";
import { WindowTabs } from "./components/WindowTabs.tsx";
import { PaneView } from "./components/PaneView.tsx";
import { DebugPanel } from "./components/DebugPanel.tsx";
import { ErrorPanel } from "./components/ErrorPanel.tsx";
import { NavbarResizer } from "./components/NavbarResizer.tsx";

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

export const App = observer(function App() {
  const demoStore = useMemo(() => new DemoStore(new BridgeClient()), []);
  const uiStore = useMemo(() => new UiStore(), []);

  useEffect(() => {
    demoStore.connect(WS_URL);
  }, [demoStore]);

  const { currentSession, currentWindow, connState, sessions, events, errors } =
    demoStore;

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: uiStore.navbarWidth, breakpoint: 0 }}
      aside={{
        width: 420,
        breakpoint: 0,
        collapsed: { desktop: uiStore.asideCollapsed, mobile: uiStore.asideCollapsed },
      }}
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
            <Badge color={demoStore.statusColor} variant="light">
              bridge: {connState}
            </Badge>
            <Tooltip label={uiStore.asideCollapsed ? "Show debug panel" : "Hide debug panel"}>
              <ActionIcon
                variant="subtle"
                onClick={() => uiStore.toggleAside()}
                aria-label="toggle debug panel"
              >
                {uiStore.asideCollapsed ? "◀" : "▶"}
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm" style={{ position: "relative" }}>
        <SessionList store={demoStore} />
        <NavbarResizer uiStore={uiStore} />
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
            <WindowTabs store={demoStore} />
            {currentWindow !== null && <PaneView store={demoStore} />}
          </Stack>
        )}
      </AppShell.Main>

      <AppShell.Aside p="sm">
        <Tabs
          value={uiStore.activeAsideTab}
          onChange={(v) => v !== null && uiStore.setActiveAsideTab(v)}
        >
          <Tabs.List>
            <Tabs.Tab value="debug">Debug ({events.length})</Tabs.Tab>
            <Tabs.Tab value="errors" color={errors.length > 0 ? "red" : undefined}>
              Errors ({errors.length})
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="debug" pt="xs">
            <DebugPanel demoStore={demoStore} uiStore={uiStore} />
          </Tabs.Panel>
          <Tabs.Panel value="errors" pt="xs">
            <ErrorPanel errors={errors} />
          </Tabs.Panel>
        </Tabs>
      </AppShell.Aside>
    </AppShell>
  );
});
