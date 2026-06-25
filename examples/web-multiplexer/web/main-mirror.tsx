// examples/web-multiplexer/web/main-mirror.tsx
// Entry point for the standalone read-only viewer page (mirror.html) — the
// "second browser" the demo is about. It loads NONE of the operator app: no
// session model, no command path, no input handling. It reads the pane id from
// its own URL, opens a read-only `MirrorViewerBridge`, and renders the pane.
// The page is a projection and nothing else. [LAW:decomposition]

import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { observer } from "mobx-react-lite";
import {
  MantineProvider,
  createTheme,
  Group,
  Stack,
  Text,
  Badge,
  Code,
} from "@mantine/core";
import "@mantine/core/styles.css";
import "@xterm/xterm/css/xterm.css";
import "./fonts.css";
import { parseMirrorPane } from "../shared/mirror-frame.ts";
import { MirrorViewerBridge } from "./mirror-viewer-bridge.ts";
import { MirrorScreen } from "./components/MirrorScreen.tsx";

const theme = createTheme({ primaryColor: "teal", defaultRadius: "sm" });

const ViewerApp = observer(function ViewerApp({ paneId }: { paneId: number }) {
  const wsBase = useMemo(
    () =>
      `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`,
    [],
  );
  const bridge = useMemo(() => new MirrorViewerBridge(wsBase, paneId), [wsBase, paneId]);

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
    <Stack gap={0} style={{ height: "100vh" }}>
      <Group
        justify="space-between"
        px="sm"
        py={6}
        style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}
      >
        <Group gap="sm">
          <Badge color="grape" variant="filled">
            READ-ONLY MIRROR
          </Badge>
          <Text size="sm">
            pane <Code>%{paneId}</Code>
          </Text>
          {statusBadge}
        </Group>
        <Badge variant="light" color="blue">
          👁 {bridge.viewers} watching
        </Badge>
      </Group>
      <MirrorScreen bridge={bridge} />
    </Stack>
  );
});

function NoPane() {
  return (
    <Stack align="center" justify="center" style={{ height: "100vh" }} gap="xs">
      <Text fw={600}>No pane to mirror</Text>
      <Text size="sm" c="dimmed">
        This page needs a <Code>?pane=%N</Code> in its URL. Open it from the
        Pane Mirror tab of the multiplexer demo.
      </Text>
    </Stack>
  );
}

const paneId = parseMirrorPane(window.location.search);

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme} defaultColorScheme="dark">
    {paneId === null ? <NoPane /> : <ViewerApp paneId={paneId} />}
  </MantineProvider>,
);
