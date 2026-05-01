// examples/web-multiplexer/web/components/SocketBadge.tsx
// The header status badge for the connection. Two modes:
//
//   web target:    plain reconnect button (legacy behavior — clicking
//                  re-dials the WebSocket bridge when state === "closed").
//
//   electron:      Mantine Menu trigger. Clicking opens a dropdown of
//                  live tmux sockets read from window.demoIpc; selecting
//                  one swaps the demo's TmuxClient onto that socket.
//
// Mode is detected at render time via getDemoIpc() — the WebSocket
// preload doesn't expose demoIpc, so the picker simply isn't reachable
// there.

import { useEffect, useState } from "react";
import { observer } from "mobx-react-lite";
import { Badge, Menu, Tooltip, Text } from "@mantine/core";

import type { DemoStore } from "../store.ts";
import { getDemoIpc } from "../demo-ipc.ts";

interface Props {
  readonly demoStore: DemoStore;
  readonly connectUrl: string;
}

export const SocketBadge = observer(function SocketBadge({
  demoStore,
  connectUrl,
}: Props) {
  const ipc = getDemoIpc();
  // Web target — fall back to the legacy reconnect badge.
  if (ipc === null) {
    return <ReconnectBadge demoStore={demoStore} connectUrl={connectUrl} />;
  }
  return <PickerBadge demoStore={demoStore} connectUrl={connectUrl} />;
});

const ReconnectBadge = observer(function ReconnectBadge({
  demoStore,
  connectUrl,
}: Props) {
  const connState = demoStore.connState;
  const label =
    connState === "closed" ? "Click to reconnect" : `Bridge is ${connState}`;
  return (
    <Tooltip label={label}>
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
          if (connState === "closed") demoStore.connect(connectUrl);
        }}
      >
        bridge: {connState}
      </Badge>
    </Tooltip>
  );
});

const PickerBadge = observer(function PickerBadge({
  demoStore,
  connectUrl,
}: Props) {
  const ipc = getDemoIpc()!;
  const connState = demoStore.connState;
  const [opened, setOpened] = useState(false);
  const [sockets, setSockets] = useState<readonly string[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mount: fetch the current socket once so the badge label is correct
  // before the user opens the menu. Re-fetched after every swap and
  // whenever the bridge transitions to "ready" (catches main-side
  // changes the renderer didn't initiate).
  useEffect(() => {
    if (connState !== "ready") return;
    let cancelled = false;
    ipc
      .currentSocket()
      .then((cur) => {
        if (!cancelled) setCurrent(cur);
      })
      .catch(() => {
        // Best-effort. The badge falls back to "bridge: <state>" when
        // current is null.
      });
    return () => {
      cancelled = true;
    };
  }, [connState, ipc]);

  // Refresh the LIST whenever the menu opens. Cheap (one IPC + one
  // readdir on the main side); doing it lazily keeps the badge cost
  // near zero when the user never clicks it.
  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    setError(null);
    ipc
      .listSockets()
      .then((list) => {
        if (!cancelled) setSockets(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [opened, ipc]);

  async function selectSocket(name: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Tear down the renderer-side proxy first so the store's MobX
      // observers see a clean disconnect → reconnect cycle. The bridge
      // re-installs subscriptions on "ready" via DemoStore, which
      // refetches sessions/windows/panes against the new socket.
      demoStore.disconnectForReconnect();
      await ipc.switchSocket(name);
      demoStore.connect(connectUrl);
      // Mirror the main-side change locally so the badge re-renders
      // with the new label before the bridge's "ready" state lands.
      setCurrent(name);
      setOpened(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Best-effort recovery: try to reconnect to whatever the main
      // process is currently bound to (it may already have completed
      // the swap before throwing).
      demoStore.connect(connectUrl);
    } finally {
      setBusy(false);
    }
  }

  // The badge itself shows the current socket name — much more
  // informative than "bridge: ready" once switching is possible.
  const badgeLabel = current === null ? `bridge: ${connState}` : current;

  return (
    <Menu
      opened={opened}
      onChange={setOpened}
      shadow="md"
      width={280}
      position="bottom-end"
      closeOnItemClick={false}
    >
      <Menu.Target>
        <Tooltip label="Switch tmux socket">
          <Badge
            component="button"
            type="button"
            color={demoStore.statusColor}
            variant="light"
            aria-label={`Current socket: ${badgeLabel}. Click to switch.`}
            style={{ cursor: "pointer", userSelect: "none", border: "none" }}
          >
            {badgeLabel}
          </Badge>
        </Tooltip>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Current</Menu.Label>
        <Menu.Item disabled>{current ?? "(disconnected)"}</Menu.Item>
        <Menu.Divider />
        <Menu.Label>Live sockets</Menu.Label>
        {sockets === null && !error && (
          <Menu.Item disabled>Loading…</Menu.Item>
        )}
        {sockets !== null && sockets.length === 0 && (
          <Menu.Item disabled>
            <Text size="xs" c="dimmed">
              No other live sockets
            </Text>
          </Menu.Item>
        )}
        {sockets?.map((name) => (
          <Menu.Item
            key={name}
            disabled={busy}
            onClick={() => void selectSocket(name)}
          >
            {name}
          </Menu.Item>
        ))}
        {error !== null && (
          <>
            <Menu.Divider />
            <Menu.Item disabled c="red">
              <Text size="xs" c="red">
                {error}
              </Text>
            </Menu.Item>
          </>
        )}
      </Menu.Dropdown>
    </Menu>
  );
});
