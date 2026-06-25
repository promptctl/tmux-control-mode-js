// examples/web-multiplexer/web/components/CollabScreen.tsx
// The WRITABLE projection surface: an `XtermSink` driven by a read-write
// `CollabBridge`. The collaborative inverse of `MirrorScreen` — same byte-in
// rendering, but stdin is ENABLED and keystrokes are wired OUT to the pane.
//
// [LAW:single-enforcer] The ONLY place that wires collab bytes to a terminal
//   and the terminal's input back to the bridge. It owns the sink lifecycle,
//   attaches `onBytes` BEFORE `connect()` (so the seed is never missed), and
//   resizes the sink when the server reports geometry.
// [LAW:one-source-of-truth] There is no local echo. Every keystroke goes to
//   tmux via `bridge.sendKeys`; what the user sees is the pane's `%output`
//   fanned back — so the screen can never disagree with the authoritative pane,
//   no matter how many browsers type at once.

import { useEffect, useRef } from "react";
import { observer } from "mobx-react-lite";
import { XtermSink } from "@promptctl/pane-terminal/xterm-sink";
import type { CollabBridge } from "../collab-bridge.ts";

const FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace';

export const CollabScreen = observer(function CollabScreen({
  bridge,
  fontSize = 13,
}: {
  readonly bridge: CollabBridge;
  readonly fontSize?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sinkRef = useRef<XtermSink | null>(null);
  const initialFontSize = useRef(fontSize);

  // Own the sink for this bridge's lifetime: wire bytes in + keystrokes out,
  // THEN connect.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;
    const sink = new XtermSink({
      container,
      fontFamily: FONT_FAMILY,
      fontSize: initialFontSize.current,
    });
    // Writable: stdin stays enabled (the XtermSink default). Unlike the mirror,
    // this terminal accepts keystrokes — they ride out via the bridge, never
    // into a local buffer.
    sinkRef.current = sink;

    if (bridge.cols > 0 && bridge.rows > 0) {
      sink.resize(bridge.cols, bridge.rows);
    }

    const detachBytes = bridge.onBytes((data) => sink.write(data));
    // [LAW:effects-at-boundaries] The view's only outbound effect: forward raw
    // terminal input to the bridge. No interpretation, no echo.
    const detachInput = sink.onData((data) => bridge.sendKeys(data));
    bridge.connect();
    sink.focus();

    return () => {
      detachInput();
      detachBytes();
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
      onClick={() => sinkRef.current?.focus()}
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
