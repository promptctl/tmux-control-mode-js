// examples/web-multiplexer/web/components/CollabView.tsx
// Operator side of the collaborative pane. Pick a pane, get a shareable URL for
// a second browser, and type into the SAME pane in a writable preview that is
// itself just another collaborator — so when someone opens the link, both
// browsers' keystrokes land in one tmux pane and both see the merged result.
// [LAW:one-source-of-truth] tmux is authoritative; the operator's preview is one
// collaborator among N, never a privileged writer. No CRDT — tmux serialises.

import { useMemo } from "react";
import { observer } from "mobx-react-lite";
import {
  Stack,
  Group,
  Paper,
  Text,
  Badge,
  Button,
  Anchor,
  Code,
  CopyButton,
  ScrollArea,
  Tooltip,
} from "@mantine/core";
import type { DemoStore } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import type { CollabStore } from "../collab-store.ts";
import { CollabBridge } from "../collab-bridge.ts";
import { CollabScreen } from "./CollabScreen.tsx";

interface Props {
  readonly demoStore: DemoStore;
  readonly store: CollabStore;
  readonly uiStore: UiStore;
}

interface PaneRow {
  readonly paneId: number;
  readonly title: string;
  readonly where: string;
}

function allPanes(demoStore: DemoStore): PaneRow[] {
  const rows: PaneRow[] = [];
  for (const s of demoStore.sessions) {
    for (const w of s.windows) {
      for (const p of w.panes) {
        rows.push({
          paneId: p.id,
          title: p.title,
          where: `${s.name} › ${w.name}`,
        });
      }
    }
  }
  return rows;
}

export const CollabView = observer(function CollabView({
  demoStore,
  store,
  uiStore,
}: Props) {
  const ready = demoStore.connState === "ready";
  const panes = allPanes(demoStore);

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Paper withBorder p="xs">
        <Group gap="md" wrap="wrap">
          <Text fw={600} size="sm">
            Collaborative Pane
          </Text>
          <Text size="xs" c="dimmed">
            two browsers, one pane — both can type, tmux is the authoritative
            source (no CRDT). Open the link in another browser and type in both;
            every keystroke is serialised by tmux and fans back to all.
          </Text>
          {!ready && (
            <Badge variant="light" color="yellow">
              bridge connecting
            </Badge>
          )}
        </Group>
      </Paper>

      <Group align="stretch" gap="sm" style={{ flex: 1, minHeight: 0 }} wrap="nowrap">
        <Paper
          withBorder
          p="xs"
          style={{ width: 280, display: "flex", flexDirection: "column", minHeight: 0 }}
        >
          <Text size="xs" fw={600} c="dimmed" mb={6}>
            PANES ({panes.length})
          </Text>
          <ScrollArea style={{ flex: 1, minHeight: 0 }}>
            <Stack gap={4}>
              {panes.length === 0 && (
                <Text size="xs" c="dimmed">
                  {ready ? "No panes visible." : "Connecting…"}
                </Text>
              )}
              {panes.map((p) => {
                const selected = p.paneId === store.selectedPaneId;
                return (
                  <Paper
                    key={p.paneId}
                    withBorder
                    p={6}
                    onClick={() => store.select(p.paneId)}
                    style={{
                      cursor: "pointer",
                      borderColor: selected
                        ? "var(--mantine-color-teal-6)"
                        : undefined,
                      background: selected
                        ? "var(--mantine-color-dark-6)"
                        : undefined,
                    }}
                  >
                    <Group gap={6} wrap="nowrap" justify="space-between">
                      <Text size="xs" truncate="end" style={{ minWidth: 0 }}>
                        {p.title || "(untitled)"}
                      </Text>
                      <Code>%{p.paneId}</Code>
                    </Group>
                    <Text size="10px" c="dimmed" truncate="end">
                      {p.where}
                    </Text>
                  </Paper>
                );
              })}
            </Stack>
          </ScrollArea>
        </Paper>

        <Paper
          withBorder
          p="xs"
          style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
        >
          {store.selectedPaneId === null ? (
            <Text c="dimmed" m="auto">
              Pick a pane to collaborate on.
            </Text>
          ) : (
            <CollabPanel
              paneId={store.selectedPaneId}
              viewerUrl={store.viewerUrl}
              fontSize={uiStore.terminalFontSize}
            />
          )}
        </Paper>
      </Group>
    </Stack>
  );
});

/**
 * The selected pane's writable preview + shareable link. The preview is a
 * `CollabBridge` — the exact read-write transport a second browser uses — so the
 * operator types through the same path a remote collaborator does, and the
 * `viewers` count is the true number of browsers on the pane. Remounts when the
 * chosen pane changes (the `key` on this element in the parent's branch).
 */
const CollabPanel = observer(function CollabPanel({
  paneId,
  viewerUrl,
  fontSize,
}: {
  readonly paneId: number;
  readonly viewerUrl: string | null;
  readonly fontSize: number;
}) {
  const wsBase = useMemo(
    () =>
      `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`,
    [],
  );
  // One bridge per chosen pane; rebuilt (and the old one torn down by
  // CollabScreen's unmount) when `paneId` changes.
  const bridge = useMemo(() => new CollabBridge(wsBase, paneId), [wsBase, paneId]);

  const statusBadge = (() => {
    if (bridge.status === "gone") return <Badge color="red">pane closed</Badge>;
    if (bridge.status === "error")
      return <Badge color="red">{bridge.errorMessage ?? "error"}</Badge>;
    if (bridge.status === "closed")
      return <Badge color="gray">disconnected</Badge>;
    if (bridge.status === "connecting")
      return <Badge color="yellow">connecting…</Badge>;
    return <Badge color="teal">live</Badge>;
  })();

  return (
    <Stack gap="xs" style={{ flex: 1, minHeight: 0 }}>
      <Group gap="sm" wrap="wrap">
        <Text size="sm" fw={600}>
          Collaborating on <Code>%{paneId}</Code>
        </Text>
        {statusBadge}
        <Tooltip label="Browsers on this pane (this preview counts as one)">
          <Badge variant="light" color="blue">
            👥 {bridge.viewers} collaborating
          </Badge>
        </Tooltip>
      </Group>

      {viewerUrl !== null && (
        <Group gap="xs" wrap="nowrap">
          <Code style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {viewerUrl}
          </Code>
          <CopyButton value={viewerUrl}>
            {({ copied, copy }) => (
              <Button size="xs" variant="light" color={copied ? "teal" : "gray"} onClick={copy}>
                {copied ? "Copied" : "Copy link"}
              </Button>
            )}
          </CopyButton>
          <Anchor href={viewerUrl} target="_blank" rel="noreferrer">
            <Button size="xs" variant="light">
              Open collaborator ↗
            </Button>
          </Anchor>
        </Group>
      )}

      <Text size="xs" c="dimmed">
        Click the terminal and type — keystrokes go straight to tmux via
        send-keys; what you see is the pane&apos;s output fanned back, so every
        collaborator&apos;s screen is the same authoritative pane.
      </Text>

      <Paper
        withBorder
        style={{ flex: 1, minHeight: 200, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <CollabScreen key={paneId} bridge={bridge} fontSize={fontSize} />
      </Paper>
    </Stack>
  );
});
