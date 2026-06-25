// examples/web-multiplexer/web/components/MirrorView.tsx
// Operator side of the read-only pane mirror. Pick a pane, get a shareable URL
// for a second browser, and watch the SAME pane live in a preview that is
// itself just another read-only viewer — so the "N watching" count ticks up the
// moment someone opens the link. [LAW:one-source-of-truth] one pane, many
// projections; the operator's preview is one of them, never a privileged copy.

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
import type { MirrorStore } from "../mirror-store.ts";
import { MirrorViewerBridge } from "../mirror-viewer-bridge.ts";
import { MirrorScreen } from "./MirrorScreen.tsx";

interface Props {
  readonly demoStore: DemoStore;
  readonly store: MirrorStore;
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

export const MirrorView = observer(function MirrorView({
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
            Pane Mirror
          </Text>
          <Text size="xs" c="dimmed">
            one server-side tmux client is the source of truth; every browser is
            a read-only projection — open the link in another browser to watch
            the same pane live
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
              Pick a pane to mirror.
            </Text>
          ) : (
            <MirrorPanel
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
 * The selected pane's live preview + shareable link. The preview is a
 * `MirrorViewerBridge` — the exact read-only transport a remote viewer uses —
 * so its `viewers` count is the true number of browsers watching, and the
 * operator sees lockstep updates without any privileged channel. Remounts when
 * the chosen pane changes (the `key` on this element in the parent's branch).
 */
const MirrorPanel = observer(function MirrorPanel({
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
  // MirrorScreen's unmount) when `paneId` changes.
  const bridge = useMemo(() => new MirrorViewerBridge(wsBase, paneId), [wsBase, paneId]);

  const statusBadge = (() => {
    if (bridge.status === "gone")
      return <Badge color="red">pane closed</Badge>;
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
          Mirroring <Code>%{paneId}</Code>
        </Text>
        {statusBadge}
        <Tooltip label="Browsers watching this pane (this preview counts as one)">
          <Badge variant="light" color="blue">
            👁 {bridge.viewers} watching
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
              Open viewer ↗
            </Button>
          </Anchor>
        </Group>
      )}

      <Text size="xs" c="dimmed">
        The viewer is read-only by construction — its transport has no way to
        send input back to the pane.
      </Text>

      <Paper
        withBorder
        style={{ flex: 1, minHeight: 200, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <MirrorScreen key={paneId} bridge={bridge} fontSize={fontSize} />
      </Paper>
    </Stack>
  );
});
