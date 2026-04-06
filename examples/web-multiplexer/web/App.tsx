import { useEffect, useMemo, useState, useCallback } from "react";
import { AppShell, Group, Title, Badge, Text, Stack, Tabs } from "@mantine/core";
import { BridgeClient } from "./ws-client.ts";
import { loadSnapshot, type SessionInfo } from "./state.ts";
import { SessionList } from "./components/SessionList.tsx";
import { WindowTabs } from "./components/WindowTabs.tsx";
import { PaneView } from "./components/PaneView.tsx";
import { DebugPanel } from "./components/DebugPanel.tsx";
import { ErrorPanel } from "./components/ErrorPanel.tsx";
import type { SerializedTmuxMessage } from "../shared/protocol.ts";

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

export function App() {
  const client = useMemo(() => new BridgeClient(), []);
  const [connState, setConnState] = useState<
    "connecting" | "open" | "ready" | "closed"
  >("connecting");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSession, setActiveSession] = useState<number | null>(null);
  const [activeWindow, setActiveWindow] = useState<number | null>(null);
  const [events, setEvents] = useState<SerializedTmuxMessage[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  // Initialize connection and subscribe to bridge streams.
  useEffect(() => {
    const unsubState = client.onState(setConnState);
    const unsubError = client.onError((m) =>
      setErrors((prev) => [`${new Date().toLocaleTimeString()} — ${m}`, ...prev].slice(0, 50)),
    );
    const unsubEvent = client.onEvent((ev) => {
      setEvents((prev) => [ev, ...prev].slice(0, 200));
    });
    client.connect(WS_URL);
    return () => {
      unsubState();
      unsubError();
      unsubEvent();
    };
  }, [client]);

  // Load snapshot once the bridge is ready, and re-load when structural
  // events arrive.
  const refresh = useCallback(async () => {
    try {
      const snap = await loadSnapshot(client);
      setSessions(snap);
      setActiveSession((cur) => {
        if (cur !== null && snap.some((s) => s.id === cur)) return cur;
        const attached = snap.find((s) => s.attached) ?? snap[0];
        return attached?.id ?? null;
      });
    } catch (err) {
      setErrors((prev) => [
        `snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
        ...prev,
      ]);
    }
  }, [client]);

  useEffect(() => {
    if (connState !== "ready") return;
    void refresh();
  }, [connState, refresh]);

  // Re-load snapshot on any structural change.
  useEffect(() => {
    const structural = new Set([
      "window-add",
      "window-close",
      "window-renamed",
      "window-pane-changed",
      "unlinked-window-add",
      "unlinked-window-close",
      "unlinked-window-renamed",
      "session-changed",
      "session-renamed",
      "sessions-changed",
      "session-window-changed",
      "layout-change",
    ]);
    const unsub = client.onEvent((ev) => {
      if (structural.has(ev.type)) void refresh();
    });
    return unsub;
  }, [client, refresh]);

  // Keep activeWindow in sync with the active session's active window.
  useEffect(() => {
    if (activeSession === null) {
      setActiveWindow(null);
      return;
    }
    const s = sessions.find((x) => x.id === activeSession);
    if (s === undefined) return;
    setActiveWindow((cur) => {
      if (cur !== null && s.windows.some((w) => w.id === cur)) return cur;
      return s.windows.find((w) => w.active)?.id ?? s.windows[0]?.id ?? null;
    });
  }, [activeSession, sessions]);

  const currentSession = sessions.find((s) => s.id === activeSession) ?? null;
  const currentWindow =
    currentSession?.windows.find((w) => w.id === activeWindow) ?? null;

  const statusColor =
    connState === "ready"
      ? "teal"
      : connState === "open"
      ? "yellow"
      : connState === "closed"
      ? "red"
      : "gray";

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 260, breakpoint: "sm" }}
      aside={{ width: 360, breakpoint: "md" }}
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
          <Badge color={statusColor} variant="light">
            bridge: {connState}
          </Badge>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <SessionList
          sessions={sessions}
          activeId={activeSession}
          onSelect={(id) => {
            setActiveSession(id);
            // Tell the control client to switch its attached session so that
            // session-scoped notifications (e.g. %layout-change) follow the
            // UI's focus. By-id target works because tmux accepts "$<n>".
            void client.execute(`switch-client -t \\$${id}`);
          }}
        />
      </AppShell.Navbar>

      <AppShell.Main>
        {currentSession === null ? (
          <Text c="dimmed">
            {connState === "ready"
              ? "No sessions — create one with `tmux new-session -d -s demo` and it will appear here."
              : "Connecting to bridge…"}
          </Text>
        ) : (
          <Stack gap="sm" h="100%">
            <WindowTabs
              windows={currentSession.windows}
              activeId={activeWindow}
              onSelect={setActiveWindow}
              sessionName={currentSession.name}
              client={client}
            />
            {currentWindow !== null && (
              <PaneView
                window={currentWindow}
                sessionName={currentSession.name}
                client={client}
              />
            )}
          </Stack>
        )}
      </AppShell.Main>

      <AppShell.Aside p="sm">
        <Tabs defaultValue="debug">
          <Tabs.List>
            <Tabs.Tab value="debug">Debug ({events.length})</Tabs.Tab>
            <Tabs.Tab value="errors" color="red">
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
}
