// examples/web-multiplexer/web/components/PaneView.tsx
//
// Thin view layer over PaneTerminal. The grid lays out one cell per pane
// in the active window; each cell mounts a PaneTerminal instance in its
// container div. All xterm / capture-pane / seeding logic lives inside
// PaneTerminal — this file only does React wiring.

import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react-lite";
import { SimpleGrid, Paper } from "@mantine/core";
import type { DemoStore, PaneInfo } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import { PaneTerminal } from "../pane-terminal.ts";
import { PaneToolbar } from "./PaneToolbar.tsx";

interface Props {
  readonly store: DemoStore;
  readonly uiStore: UiStore;
}

export const PaneView = observer(function PaneView({ store, uiStore }: Props) {
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
        <PaneCell key={p.id} pane={p} store={store} uiStore={uiStore} />
      ))}
    </SimpleGrid>
  );
});

interface CellProps {
  readonly pane: PaneInfo;
  readonly store: DemoStore;
  readonly uiStore: UiStore;
}

const PaneCell = observer(function PaneCell({ pane, store, uiStore }: CellProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // PaneTerminal lifecycle is tied to the mount effect, NOT to useMemo.
  // React StrictMode double-invokes effects in dev (mount → cleanup →
  // mount). Creating a fresh instance on each effect run makes StrictMode
  // safe at the cost of one extra capture-pane in dev only.
  const [terminal, setTerminal] = useState<PaneTerminal | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const t = new PaneTerminal(pane.id, store, uiStore);
    t.mount(container);
    setTerminal(t);
    return () => {
      t.dispose();
      setTerminal(null);
    };
  }, [pane.id, store, uiStore]);

  // Visual signal for the keymap prefix state: when the user has pressed
  // C-b, the focused pane's border switches to a warning color so the next
  // keystroke is understood to be a tmux command. Non-active panes stay
  // quiet even when the prefix is armed — only one pane has "focus" at a
  // time, and that's where the user's typing is going.
  //
  // [LAW:dataflow-not-control-flow] The border color is a pure projection
  // of (pane.active, store.prefixActive). No imperative setAttribute;
  // MobX invalidates the observer on either change and the value is
  // recomputed.
  const borderColor = pane.active
    ? store.prefixActive
      ? "var(--mantine-color-yellow-5)"
      : "var(--mantine-color-teal-6)"
    : undefined;
  return (
    <Paper
      withBorder
      p="xs"
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        borderColor,
        borderWidth: pane.active && store.prefixActive ? 2 : undefined,
        transition: "border-color 80ms ease-out, border-width 80ms ease-out",
      }}
      onClick={() => store.selectPane(pane)}
    >
      <PaneToolbar pane={pane} uiStore={uiStore} terminal={terminal} />
      <div
        ref={containerRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
        }}
      />
    </Paper>
  );
});
