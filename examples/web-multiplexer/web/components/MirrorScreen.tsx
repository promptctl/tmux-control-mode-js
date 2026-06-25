// examples/web-multiplexer/web/components/MirrorScreen.tsx
// The PROJECTION surface: an `XtermSink` driven by a read-only
// `MirrorViewerBridge`. One component, used in two places — the operator's
// preview tile and the standalone second-browser viewer page. They are the
// SAME projection; only the chrome around them differs. [LAW:one-type-per-behavior]
//
// [LAW:single-enforcer] The ONLY place that wires mirror bytes to a terminal.
//   It owns the sink lifecycle, attaches `onBytes` BEFORE `connect()` (so the
//   seed is never missed — the bridge does no buffering), and resizes the sink
//   when the server reports the pane geometry.
// The sink's stdin is disabled: a mirror is read-only, so the terminal must not
//   even appear to accept keystrokes. [LAW:types-are-the-program] reinforced at
//   the view: the bridge has no write path, and the renderer has no input path.

import { useEffect, useRef } from "react";
import { observer } from "mobx-react-lite";
import { XtermSink } from "@promptctl/pane-terminal/xterm-sink";
import type { MirrorViewerBridge } from "../mirror-viewer-bridge.ts";

const FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace';

export const MirrorScreen = observer(function MirrorScreen({
  bridge,
  fontSize = 13,
}: {
  readonly bridge: MirrorViewerBridge;
  readonly fontSize?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sinkRef = useRef<XtermSink | null>(null);
  const initialFontSize = useRef(fontSize);

  // Own the sink for this bridge's lifetime: wire bytes → sink, THEN connect.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;
    const sink = new XtermSink({
      container,
      fontFamily: FONT_FAMILY,
      fontSize: initialFontSize.current,
    });
    // Read-only: the projection must not accept keystrokes. The escape hatch to
    // the underlying terminal is the supported way to set this option.
    sink.terminal.options.disableStdin = true;
    sink.terminal.options.cursorBlink = false;
    sinkRef.current = sink;

    // If geometry already arrived (fast connect), resize immediately so the
    // first writes paint; otherwise the size effect below handles it.
    if (bridge.cols > 0 && bridge.rows > 0) {
      sink.resize(bridge.cols, bridge.rows);
    }

    const detach = bridge.onBytes((data) => sink.write(data));
    bridge.connect();

    return () => {
      detach();
      bridge.disconnect();
      sink.dispose();
      sinkRef.current = null;
    };
  }, [bridge]);

  // Resize the sink whenever the server reports (or re-reports) pane geometry.
  // A fresh XtermSink buffers writes until its first resize, so this is what
  // unblocks the seed paint.
  useEffect(() => {
    const sink = sinkRef.current;
    if (sink === null || bridge.cols === 0 || bridge.rows === 0) return;
    sink.resize(bridge.cols, bridge.rows);
  }, [bridge.cols, bridge.rows]);

  useEffect(() => {
    sinkRef.current?.setFontSize(fontSize);
  }, [fontSize]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        width: "100%",
        overflow: "hidden",
        background: "var(--mantine-color-dark-9, #0b0d10)",
      }}
    />
  );
});
