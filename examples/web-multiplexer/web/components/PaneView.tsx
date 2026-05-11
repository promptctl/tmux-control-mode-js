// examples/web-multiplexer/web/components/PaneView.tsx
//
// Thin view layer over the @promptctl/pane-terminal package.
// PaneView lays out one cell per pane in the active window. Each PaneCell:
//   1. Creates one `ObservablePaneStream` per pane id (stable across re-renders).
//   2. Uses `mountPaneTerminal` (vanilla adapter) to wire `XtermSink` to the
//      stream in an effect — giving us direct `sink.focus()` access.
//   3. Renders `<PaneToolbar>` with the observable stream for the activity badge.
//
// [LAW:single-enforcer] `store.paneStreamClient` is the one adapter per
//   bridge — not re-created per pane. All pane streams share it.
// [LAW:dataflow-not-control-flow] Focus is a derived side-effect of
//   `pane.active` changing; an effect declares the dependency and the MobX
//   observer invalidates the component when the flag changes.

import { useEffect, useRef, useMemo } from "react";
import { observer } from "mobx-react-lite";
import { SimpleGrid, Paper } from "@mantine/core";
import { mountPaneTerminal } from "@promptctl/pane-terminal/vanilla";
import type { XtermSink } from "@promptctl/pane-terminal/xterm-sink";
import { ObservablePaneStream } from "../pane-stream-bridge.ts";
import type { DemoStore, PaneInfo } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import { PaneToolbar } from "./PaneToolbar.tsx";

// [LAW:one-source-of-truth] The same font family string is used both as the
// xterm.js fontFamily option and as the font-load probe in the XtermSink's
// font cache. Keeping it in one place prevents the cache from measuring the
// wrong font if the two strings drifted.
const FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace';

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
  const sinkRef = useRef<XtermSink | null>(null);

  // [LAW:single-enforcer] One `ObservablePaneStream` per pane id. The stream
  // subscribes to byte events at construction (O2) and lives until the pane
  // leaves the tree. `useMemo` keeps identity stable across re-renders so
  // `<PaneTerminal>` never tears down and rebuilds the xterm sink on a prop
  // change that doesn't change the stream (O10).
  const obs = useMemo(
    () => new ObservablePaneStream({ client: store.paneStreamClient, paneId: pane.id }),
    [pane.id, store.paneStreamClient],
  );
  // Dispose the stream when the pane unmounts or pane.id changes.
  useEffect(() => () => obs.dispose(), [obs]);

  // Capture the initial font size in a ref so the mount effect doesn't
  // depend on it (preventing a remount on every font-size change).
  const initialFontSize = useRef(uiStore.terminalFontSize);

  // [LAW:single-enforcer] The ONLY place that constructs an XtermSink and
  // attaches it to the stream. The cleanup is the ONLY place that disposes
  // the mount. React StrictMode's double-invoke runs attach → detach →
  // attach; `PaneStream.attach()` replays the cached seed on the second
  // attach — no second capture-pane (gate #4).
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;
    const mount = mountPaneTerminal(obs.stream, container, {
      fontFamily: FONT_FAMILY,
      fontSize: initialFontSize.current,
    });
    sinkRef.current = mount.sink;
    return () => {
      mount.dispose();
      sinkRef.current = null;
    };
  }, [obs.stream]);

  // Live font-size updates — in-place setter, no remount (O10).
  useEffect(() => {
    sinkRef.current?.setFontSize(uiStore.terminalFontSize);
  }, [uiStore.terminalFontSize]);

  // When this pane becomes the active pane (window switch, keymap
  // select-pane, click), pull keyboard focus into its xterm. Without
  // this, C-b n would move tmux to the next window but focus would land
  // on <body> since the previous xterm was unmounted, and the follow-up
  // C-b chord would never reach a keymap handler.
  //
  // [LAW:dataflow-not-control-flow] Derived effect: "the focused pane's
  // xterm must have DOM focus" is a property of (pane.active). React
  // re-runs the effect whenever pane.active changes.
  useEffect(() => {
    if (pane.active) sinkRef.current?.focus();
  }, [pane.active]);

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
      <PaneToolbar pane={pane} uiStore={uiStore} obs={obs} />
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
