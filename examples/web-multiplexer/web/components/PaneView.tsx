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

  // When tmux has a pane zoomed (C-b z), render only the active pane at
  // full size. The other panes still exist server-side — they're just
  // hidden from view, matching tmux's own zoom UX.
  const visible = win.zoomed
    ? win.panes.filter((p) => p.active)
    : win.panes;

  // Derive layout orientation from pane geometry. tmux sends us the actual
  // width/height per pane; from that we can tell whether the split is
  // side-by-side (`-h`, same height / different widths) or top/bottom
  // (`-v`, same width / different heights). For >2 panes we fall back to
  // a single stack — tmux's layout algebra (tiled, main-horizontal, …)
  // beyond 2 panes is out of scope for this demo.
  const cols = visible.length <= 1
    ? 1
    : isSideBySide(visible)
    ? visible.length
    : 1;

  return (
    <SimpleGrid cols={cols} spacing="xs" style={{ flex: 1, minHeight: 0 }}>
      {visible.map((p) => (
        <PaneCell key={p.id} pane={p} store={store} uiStore={uiStore} />
      ))}
    </SimpleGrid>
  );
});

// [LAW:single-enforcer] Orientation detection lives in exactly one place.
// Rule: if the panes' heights are all equal but widths differ, they are
// side-by-side (horizontal split from tmux's perspective — `split-window -h`).
// Otherwise treat them as stacked (vertical split, `split-window -v`).
function isSideBySide(panes: readonly PaneInfo[]): boolean {
  if (panes.length < 2) return false;
  const firstHeight = panes[0].height;
  const firstWidth = panes[0].width;
  const allSameHeight = panes.every((p) => p.height === firstHeight);
  const allSameWidth = panes.every((p) => p.width === firstWidth);
  if (allSameHeight && !allSameWidth) return true;
  if (allSameWidth && !allSameHeight) return false;
  // Ambiguous (all same or all different) — fall back to single-column
  // stack, which is always readable.
  return false;
}

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

  // When this pane becomes the active pane (window switch, keymap
  // select-pane, click), pull keyboard focus into its xterm. Without
  // this, C-b n would move tmux to the next window but focus would land
  // on <body> since the previous xterm was unmounted, and the follow-up
  // C-b chord would never reach a keymap handler.
  //
  // [LAW:dataflow-not-control-flow] Derived effect: "the focused pane's
  // xterm must have DOM focus" is a property of (pane.active, terminal).
  // React re-runs the effect whenever either changes.
  useEffect(() => {
    if (pane.active && terminal !== null) terminal.focus();
  }, [pane.active, terminal]);

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
