import { useEffect, useRef } from "react";
import { observer } from "mobx-react-lite";
import { SimpleGrid, Paper, Text, Group, Badge } from "@mantine/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { DemoStore, PaneInfo } from "../store.ts";
import { decodeBase64 } from "../ws-client.ts";
import type { SerializedTmuxMessage } from "../../shared/protocol.ts";

interface Props {
  readonly store: DemoStore;
}

export const PaneView = observer(function PaneView({ store }: Props) {
  const win = store.currentWindow;
  if (win === null) return null;
  const cols = Math.min(win.panes.length, 2);
  return (
    <SimpleGrid
      cols={cols > 0 ? cols : 1}
      spacing="xs"
      style={{ flex: 1, minHeight: 0 }}
    >
      {win.panes.map((p) => (
        <PaneCell key={p.id} pane={p} store={store} />
      ))}
    </SimpleGrid>
  );
});

interface CellProps {
  readonly pane: PaneInfo;
  readonly store: DemoStore;
}

function PaneCell({ pane, store }: CellProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current === null) return;
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'Menlo, "DejaVu Sans Mono", monospace',
      fontSize: 12,
      theme: { background: "#0b1120" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try {
      fit.fit();
    } catch {
      /* container not sized yet */
    }

    const unsubEvent = store.client.onEvent((ev: SerializedTmuxMessage) => {
      if (
        (ev.type === "output" || ev.type === "extended-output") &&
        ev.paneId === pane.id
      ) {
        term.write(decodeBase64(ev.dataBase64));
      }
    });

    const disp = term.onData((data) => store.sendKeysToPane(pane.id, data));

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* no-op */
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      unsubEvent();
      disp.dispose();
      term.dispose();
    };
  }, [pane.id, store]);

  return (
    <Paper
      withBorder
      p="xs"
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 240,
        borderColor: pane.active ? "var(--mantine-color-teal-6)" : undefined,
      }}
      onClick={() => store.selectPane(pane)}
    >
      <Group gap="xs" justify="space-between" pb={4}>
        <Text size="xs" c="dimmed">
          %{pane.id} ({pane.index}) {pane.title}
        </Text>
        {pane.active && (
          <Badge size="xs" color="teal" variant="light">
            active
          </Badge>
        )}
      </Group>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
    </Paper>
  );
}
