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
import { reaction } from "mobx";
import { observer } from "mobx-react-lite";
import type { XtermSink } from "../window-terminal-internals.ts";
import { FittedXtermSink, SCROLLBACK } from "../fitted-xterm-sink.ts";
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
    const sink = new FittedXtermSink({
      container,
      scrollback: SCROLLBACK,
      // Read-only: the projection must not accept keystrokes.
      xterm: {
        fontFamily: FONT_FAMILY,
        disableStdin: true,
        cursorBlink: false,
      },
      fontSize: initialFontSize.current,
    });
    sinkRef.current = sink;

    // Resize the sink whenever the server reports (or re-reports) pane
    // geometry. [LAW:no-ambient-temporal-coupling] A reaction runs as the size
    // frame is handled, so the size reaches the sink ahead of the seed bytes
    // the server sends after it; a React effect would run after them.
    const stopSize = reaction(
      () => [bridge.cols, bridge.rows] as const,
      ([cols, rows]) => sink.resize(cols, rows),
      { fireImmediately: true },
    );
    const detach = bridge.onBytes((data) => sink.write(data));
    bridge.connect();

    return () => {
      detach();
      stopSize();
      bridge.disconnect();
      sink.dispose();
      sinkRef.current = null;
    };
  }, [bridge]);

  useEffect(() => {
    sinkRef.current?.setFont(fontSize);
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
