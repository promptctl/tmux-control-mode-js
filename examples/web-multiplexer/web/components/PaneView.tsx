import { useEffect, useRef } from "react";
import { SimpleGrid, Paper, Text, Group, Badge } from "@mantine/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { WindowInfo, PaneInfo } from "../state.ts";
import type { BridgeClient } from "../ws-client.ts";
import { decodeBase64 } from "../ws-client.ts";
import type { SerializedTmuxMessage } from "../../shared/protocol.ts";

interface Props {
  readonly window: WindowInfo;
  readonly sessionName: string;
  readonly client: BridgeClient;
}

export function PaneView({ window: win, sessionName, client }: Props) {
  // One grid cell per pane, each hosting an xterm.js Terminal.
  const cols = Math.min(win.panes.length, 2);
  return (
    <SimpleGrid cols={cols > 0 ? cols : 1} spacing="xs" style={{ flex: 1, minHeight: 0 }}>
      {win.panes.map((p) => (
        <PaneCell
          key={p.id}
          pane={p}
          sessionName={sessionName}
          windowIndex={win.index}
          client={client}
        />
      ))}
    </SimpleGrid>
  );
}

interface CellProps {
  readonly pane: PaneInfo;
  readonly sessionName: string;
  readonly windowIndex: number;
  readonly client: BridgeClient;
}

function PaneCell({ pane, sessionName, windowIndex, client }: CellProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

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
      // FitAddon throws if the container has no size yet; ignore.
    }
    termRef.current = term;

    // Forward pane output bytes into xterm for THIS pane id.
    const unsubEvent = client.onEvent((ev: SerializedTmuxMessage) => {
      if (ev.type === "output" && ev.paneId === pane.id) {
        term.write(decodeBase64(ev.dataBase64));
      } else if (ev.type === "extended-output" && ev.paneId === pane.id) {
        term.write(decodeBase64(ev.dataBase64));
      }
    });

    // Forward local keystrokes to this pane via send-keys.
    const disp = term.onData((data) => {
      void client.sendKeys(`%${pane.id}`, data);
    });

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
      termRef.current = null;
    };
  }, [client, pane.id]);

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
      onClick={() => {
        void client.execute(
          `select-pane -t ${sessionName}:${windowIndex}.${pane.index}`,
        );
      }}
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
