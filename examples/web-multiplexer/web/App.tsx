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
  Modal,
  Button,
} from "@mantine/core";
import { BridgeClient } from "./ws-client.ts";
import { DemoStore } from "./store.ts";
import { UiStore } from "./ui-store.ts";
import { InspectorStore } from "./inspector-store.ts";
import { HeatmapStore } from "./heatmap-store.ts";
import { SessionList } from "./components/SessionList.tsx";
import { WindowTabs } from "./components/WindowTabs.tsx";
import { PaneView } from "./components/PaneView.tsx";
import { DebugPanel } from "./components/DebugPanel.tsx";
import { ErrorPanel } from "./components/ErrorPanel.tsx";
import { NavbarResizer } from "./components/NavbarResizer.tsx";
import { InspectorView } from "./components/InspectorView.tsx";
import { HeatmapView } from "./components/HeatmapView.tsx";
import { SegmentedControl } from "@mantine/core";

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

export const App = observer(function App() {
  const demoStore = useMemo(() => new DemoStore(new BridgeClient()), []);
  const uiStore = useMemo(() => new UiStore(), []);
  // [LAW:one-source-of-truth] InspectorStore subscribes to the SAME
  // BridgeClient as DemoStore. Both stores are pure projections of the
  // wire — InspectorStore sees everything, DemoStore sees only events.
  const inspectorStore = useMemo(
    () => new InspectorStore(demoStore.client),
    [demoStore],
  );
  const heatmapStore = useMemo(
    () => new HeatmapStore(demoStore.client),
    [demoStore],
  );

  useEffect(() => {
    demoStore.connect(WS_URL);
    return () => {
      heatmapStore.dispose();
      inspectorStore.dispose();
      demoStore.disconnect();
    };
  }, [demoStore, heatmapStore, inspectorStore]);

  const { currentSession, currentWindow, connState, sessions, events, errors } =
    demoStore;

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{
        width: uiStore.navbarWidth,
        breakpoint: 0,
        collapsed: { desktop: uiStore.navbarCollapsed, mobile: uiStore.navbarCollapsed },
      }}
      aside={{
        width: 420,
        breakpoint: 0,
        collapsed: { desktop: uiStore.asideCollapsed, mobile: uiStore.asideCollapsed },
      }}
      padding="md"
    >
      <AppShell.Header p="sm">
        <Group justify="space-between" h="100%" wrap="nowrap">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, overflow: "hidden" }}>
            <Tooltip
              label={uiStore.navbarCollapsed ? "Show session sidebar" : "Hide session sidebar"}
            >
              <ActionIcon
                variant="subtle"
                onClick={() => uiStore.toggleNavbar()}
                aria-label="toggle session sidebar"
              >
                {uiStore.navbarCollapsed ? "▶" : "◀"}
              </ActionIcon>
            </Tooltip>
            <Title order={4}>tmux-control-mode-js</Title>
            <Text c="dimmed" size="sm" truncate="end">
              Web Multiplexer Demo
            </Text>
            <SegmentedControl
              size="xs"
              value={uiStore.appMode}
              onChange={(v) =>
                uiStore.setAppMode(
                  v === "inspector"
                    ? "inspector"
                    : v === "heatmap"
                    ? "heatmap"
                    : "multiplexer",
                )
              }
              data={[
                { label: "Multiplexer", value: "multiplexer" },
                { label: "Protocol Inspector", value: "inspector" },
                { label: "Activity Heatmap", value: "heatmap" },
              ]}
            />
          </Group>
          <Group gap="xs" wrap="nowrap">
            {/* Prefix-active indicator. Only rendered when the keymap
                engine is in prefix mode; occupies no space otherwise so
                the header layout doesn't jitter. */}
            {demoStore.prefixActive && (
              <Badge color="yellow" variant="filled">
                prefix: C-b
              </Badge>
            )}
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

      <AppShell.Navbar p="sm">
        {/* Wrap the navbar content in a relative-positioned full-size box
            so the absolutely-positioned resizer handle anchors to it.
            DO NOT set position: relative on AppShell.Navbar itself —
            that overrides Mantine's intended fixed positioning and
            collapses the entire AppShell layout. */}
        <div style={{ position: "relative", height: "100%", width: "100%" }}>
          <SessionList store={demoStore} />
          <NavbarResizer uiStore={uiStore} />
        </div>
      </AppShell.Navbar>

      <AppShell.Main
        style={{
          display: "flex",
          flexDirection: "column",
          // 100vh because Mantine AppShell's grid cell uses `min-height`,
          // so `height: 100%` on Main never resolves. Mantine automatically
          // adds `padding-top: var(--app-shell-header-offset)` to Main, so
          // the content area (box minus padding-top) is viewport minus the
          // header — which is exactly what we want.
          height: "100vh",
        }}
      >
        {uiStore.appMode === "inspector" ? (
          <InspectorView store={inspectorStore} demoStore={demoStore} />
        ) : uiStore.appMode === "heatmap" ? (
          <HeatmapView
            demoStore={demoStore}
            heatmapStore={heatmapStore}
            uiStore={uiStore}
          />
        ) : currentSession === null ? (
          <Text c="dimmed">
            {connState === "ready"
              ? sessions.length === 0
                ? "No sessions visible — tmux returned an empty list."
                : "Pick a session from the sidebar."
              : `Connecting to bridge (${connState})…`}
          </Text>
        ) : (
          <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
            <WindowTabs store={demoStore} />
            {currentWindow !== null && (
              <PaneView store={demoStore} uiStore={uiStore} />
            )}
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
            <DebugPanel demoStore={demoStore} uiStore={uiStore} key="debug" />
          </Tabs.Panel>
          <Tabs.Panel value="errors" pt="xs">
            <ErrorPanel demoStore={demoStore} />
          </Tabs.Panel>
        </Tabs>
      </AppShell.Aside>

      {/* Confirm modal for destructive keymap actions (C-b x, C-b &).
          The demo intercepts kill-pane / kill-window in DemoStore and
          shows this prompt before dispatching — matching tmux's own
          `confirm-before` UX without forcing that policy into the
          library layer. */}
      <Modal
        opened={demoStore.pendingConfirm !== null}
        onClose={() => demoStore.cancelPendingAction()}
        title="Confirm"
        centered
        size="sm"
      >
        <Stack gap="md">
          <Text>{demoStore.pendingConfirm?.prompt ?? ""}</Text>
          <Group justify="flex-end" gap="xs">
            <Button
              variant="default"
              onClick={() => demoStore.cancelPendingAction()}
            >
              Cancel
            </Button>
            <Button
              color="red"
              onClick={() => demoStore.confirmPendingAction()}
              autoFocus
            >
              Kill
            </Button>
          </Group>
        </Stack>
      </Modal>
    </AppShell>
  );
});
