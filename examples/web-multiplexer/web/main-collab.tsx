// examples/web-multiplexer/web/main-collab.tsx
// Entry point for the standalone collaborator page (collab.html) — the "second
// browser" the demo is about. It loads NONE of the operator app: no session
// model, no command path, no keymap. It reads the pane id from its own URL,
// opens a read-write `CollabBridge`, and renders a writable terminal. The page
// is a collaborator on one pane and nothing else. [LAW:decomposition]

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
import { CollabBridge } from "./collab-bridge.ts";
import { CollabScreen } from "./components/CollabScreen.tsx";

const theme = createTheme({ primaryColor: "teal", defaultRadius: "sm" });

const CollabApp = observer(function CollabApp({ paneId }: { paneId: number }) {
  const wsBase = useMemo(
    () =>
      `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`,
    [],
  );
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
    <Stack gap={0} style={{ height: "100vh" }}>
      <Group
        justify="space-between"
        px="sm"
        py={6}
        style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}
      >
        <Group gap="sm">
          <Badge color="teal" variant="filled">
            COLLABORATOR
          </Badge>
          <Text size="sm">
            pane <Code>%{paneId}</Code> — click and type
          </Text>
          {statusBadge}
        </Group>
        <Badge variant="light" color="blue">
          👥 {bridge.viewers} collaborating
        </Badge>
      </Group>
      <CollabScreen bridge={bridge} />
    </Stack>
  );
});

function NoPane() {
  return (
    <Stack align="center" justify="center" style={{ height: "100vh" }} gap="xs">
      <Text fw={600}>No pane to collaborate on</Text>
      <Text size="sm" c="dimmed">
        This page needs a <Code>?pane=%N</Code> in its URL. Open it from the
        Collaborative Pane tab of the multiplexer demo.
      </Text>
    </Stack>
  );
}

const paneId = parseMirrorPane(window.location.search);

createRoot(document.getElementById("root")!).render(
  <MantineProvider theme={theme} defaultColorScheme="dark">
    {paneId === null ? <NoPane /> : <CollabApp paneId={paneId} />}
  </MantineProvider>,
);
