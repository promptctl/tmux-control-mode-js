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
    const container = containerRef.current;
    if (container === null) return;

    // `disposed` guards every operation on the terminal so late-arriving
    // events (base64 writes, resize-observer fires, animation-frame
    // callbacks) don't touch the terminal after cleanup. React StrictMode
    // double-invokes effects in dev — without this guard, the first
    // terminal's disposed state gets hit by a stray write and xterm
    // throws `_renderer.value.dimensions` is undefined.
    let disposed = false;
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'Menlo, "DejaVu Sans Mono", monospace',
      fontSize: 12,
      theme: { background: "#0b1120" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // Defer initial fit until the next animation frame — at mount time the
    // container may not have been laid out yet and fit() would throw.
    const rafId = requestAnimationFrame(() => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        /* container still not sized; ignore */
      }
    });

    const unsubEvent = store.client.onEvent((ev: SerializedTmuxMessage) => {
      if (disposed) return;
      if (
        (ev.type === "output" || ev.type === "extended-output") &&
        ev.paneId === pane.id
      ) {
        try {
          term.write(decodeBase64(ev.dataBase64));
        } catch {
          /* write-on-disposed; swallow */
        }
      }
    });

    const disp = term.onData((data) => {
      if (disposed) return;
      store.sendKeysToPane(pane.id, data);
    });

    const ro = new ResizeObserver(() => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        /* no-op */
      }
    });
    ro.observe(container);

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
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
