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
import { WebSocketBridge } from "./ws-client.ts";
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
  const uiStore = useMemo(() => new UiStore(), []);
  // Demo-side policy hooks: the library's keymap emits `choose-session`
  // for C-b s, but the demo handles it by popping the sidebar open rather
  // than firing tmux's `choose-tree` (which renders inside a pane and
  // doesn't translate well to the browser UX).
  const demoStore = useMemo(
    () =>
      new DemoStore(new WebSocketBridge(), {
        onChooseSession: () => uiStore.expandNavbar(),
      }),
    [uiStore],
  );
  // [LAW:one-source-of-truth] InspectorStore subscribes to the SAME
  // TmuxBridge as DemoStore. Both stores are pure projections of the
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

  // Document-level keymap routing.
  //
  // Why this lives at window scope (and not on xterm's attachCustomKey-
  // EventHandler): tmux-style shortcuts should keep working even when the
  // focus drifts off the terminal — e.g. after C-b n unmounts the old
  // xterm and the new one hasn't grabbed focus yet, or when the user
  // clicked a UI control. Attaching per-xterm would make the keymap deaf
  // in exactly those moments.
  //
  // Capture phase (useCapture: true) runs this listener BEFORE xterm's
  // own keydown handler on its textarea, so consumed chords can be
  // preventDefault'd before xterm translates them into pane bytes.
  //
  // Text-input exclusion: when the user is typing into a real form
  // input (filter boxes, inspector search) we must NOT interpret those
  // keystrokes as tmux commands. The xterm helper textarea is an
  // exception — that's where the keymap SHOULD fire.
  useEffect(() => {
    function isRegularTextInput(el: Element | null): boolean {
      if (el === null) return false;
      // xterm's invisible textarea is how xterm captures input. Treat it
      // as "not a text input" so the keymap handles C-b there.
      if (el.classList.contains("xterm-helper-textarea")) return false;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
      if ((el as HTMLElement).isContentEditable) return true;
      return false;
    }
    function onKeyDown(ev: KeyboardEvent): void {
      if (isRegularTextInput(document.activeElement)) return;
      // When a confirm/action modal is open, let it handle keys itself.
      // Otherwise our capture-phase listener would swallow Enter/Escape
      // before the Modal's button could react.
      if (demoStore.pendingConfirm !== null) return;
      const consumed = demoStore.handleKeyEvent({
        key: ev.key,
        ctrl: ev.ctrlKey,
        alt: ev.altKey,
        shift: ev.shiftKey,
        meta: ev.metaKey,
      });
      if (consumed) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [demoStore]);

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
            {/* Click to reconnect when the bridge is closed — e.g. after
                C-b d (detach) or a dropped connection. Rendered as a real
                <button> via Mantine's polymorphic `component` prop so the
                control is keyboard-focusable and has a screen-reader-
                accessible label, not just a clickable visual badge. The
                `disabled` attribute disables BOTH the click and any focus/
                Enter activation when the bridge is healthy, matching the
                cursor: default visual cue. */}
            <Tooltip
              label={
                connState === "closed"
                  ? "Click to reconnect"
                  : `Bridge is ${connState}`
              }
            >
              <Badge
                component="button"
                type="button"
                color={demoStore.statusColor}
                variant="light"
                disabled={connState !== "closed"}
                aria-label={
                  connState === "closed"
                    ? "Reconnect to the tmux bridge"
                    : `Bridge status: ${connState}`
                }
                style={{
                  cursor: connState === "closed" ? "pointer" : "default",
                  userSelect: "none",
                  border: "none",
                }}
                onClick={() => {
                  if (connState === "closed") demoStore.connect(WS_URL);
                }}
              >
                bridge: {connState}
              </Badge>
            </Tooltip>
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
              // Mantine's focus trap uses `data-autofocus` — React's
              // `autoFocus` prop is ignored by the trap because Modal runs
              // its own focus management after mount. Wrap the attr in a
              // truthy value so Mantine picks this as the initial target.
              data-autofocus
            >
              Kill
            </Button>
          </Group>
        </Stack>
      </Modal>
    </AppShell>
  );
});
