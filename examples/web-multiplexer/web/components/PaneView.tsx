// examples/web-multiplexer/web/components/PaneView.tsx
//
// Thin view layer over PaneTerminal. The grid lays out one cell per pane
// in the active window; each cell mounts a PaneTerminal instance in its
// container div. All xterm / capture-pane / seeding logic lives inside
// PaneTerminal — this file only does React wiring.

import { useEffect, useMemo, useRef, useState } from "react";
import { observer } from "mobx-react-lite";
import { SimpleGrid, Paper } from "@mantine/core";
import type { DemoStore, PaneInfo } from "../store.ts";
import { PaneTerminal } from "../pane-terminal.ts";
import { PaneToolbar } from "./PaneToolbar.tsx";

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

const PaneCell = observer(function PaneCell({ pane, store }: CellProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // One PaneTerminal per pane.id for this cell's lifetime. `useMemo` keyed
  // on pane.id + store identity — neither changes during a normal session,
  // so this runs once per pane mount. When the user navigates to a
  // different window (different panes), React unmounts the old cells and
  // mounts new ones, each with a fresh PaneTerminal instance.
  const terminal = useMemo(
    () => new PaneTerminal(pane.id, store),
    [pane.id, store],
  );

  // React uses this purely to cause re-renders of the toolbar after the
  // terminal instance is ready (the toolbar reads `terminal.status.*`).
  // Without this, the first paint would pass `terminal=null` even though
  // we just created it above; this is a no-op after the first render.
  const [, forceRender] = useState({});

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    terminal.mount(container);
    forceRender({});
    return () => {
      terminal.dispose();
    };
  }, [terminal]);

  return (
    <Paper
      withBorder
      p="xs"
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        borderColor: pane.active ? "var(--mantine-color-teal-6)" : undefined,
      }}
      onClick={() => store.selectPane(pane)}
    >
      <PaneToolbar pane={pane} store={store} terminal={terminal} />
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 0,
          // Horizontal scrolling is forbidden per the plan; vertical is
          // xterm-internal. The container clips anything stray.
          overflow: "hidden",
        }}
      />
    </Paper>
  );
});
