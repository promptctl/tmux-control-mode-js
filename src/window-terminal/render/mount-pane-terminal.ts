// src/window-terminal/render/mount-pane-terminal.ts
//
// `mountPaneTerminal` — vanilla-DOM adapter, no framework: construct an
// `XtermSink` against a container, attach it to a `PaneStream`, and return a
// disposer that tears down both.
//
// [LAW:one-source-of-truth] The wire between PaneStream and XtermSink is the
//   TerminalSink seam (../engine/terminal-sink.ts); this layer adds no policy.
// [LAW:single-enforcer] One mount path, one dispose path. The `disposed`
//   flag below is the only thing that makes `dispose()` idempotent — there
//   is no separate "already torn down" state.
// [LAW:no-mode-explosion] No flags. The function constructs, attaches, and
//   returns; the only variability is the options forwarded to XtermSink.

import type { PaneStream } from "../engine/pane-stream.js";
import { XtermSink, type XtermSinkOptions } from "./xterm-sink.js";

/**
 * Live handle returned by `mountPaneTerminal`. The `sink` is exposed for
 * advanced consumers that want to call `setFontSize`/`setTheme`/`focus`
 * after mount; `dispose()` tears the whole wiring down idempotently.
 */
export interface PaneTerminalMount {
  readonly sink: XtermSink;
  /** Idempotent: detaches the stream, disposes the sink, releases keystrokes. */
  dispose(): void;
}

/**
 * Mount a pane terminal into `container`. Constructs an `XtermSink` with
 * `opts`, wires xterm keystrokes back to the stream via `sendKeys`, and
 * attaches the sink to the stream. The returned `dispose()` reverses
 * everything in safe order: stop forwarding keystrokes, detach the stream
 * (no more bytes flow through the sink), then dispose the sink.
 */
export function mountPaneTerminal(
  stream: PaneStream,
  container: HTMLElement,
  opts: Omit<XtermSinkOptions, "container"> = {},
): PaneTerminalMount {
  const sink = new XtermSink({ ...opts, container });
  const offKeys = sink.onData((data) => {
    // Fire-and-forget. Transport-level failures (closed connection,
    // dropped pane) surface through the client's `connectionState`, not
    // per-keystroke — so swallow rejections here to avoid noisy
    // unhandled-rejection warnings in apps that treat them as fatal.
    stream.sendKeys(data).catch(() => undefined);
  });
  stream.attach(sink);

  let disposed = false;
  return {
    sink,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      offKeys();
      stream.detach();
      sink.dispose();
    },
  };
}
