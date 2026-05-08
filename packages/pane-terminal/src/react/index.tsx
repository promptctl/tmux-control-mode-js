// packages/pane-terminal/src/react/index.tsx
//
// `<PaneTerminal>` — React adapter that wires a `PaneStream` (data) to an
// `XtermSink` (renderer). The component is intentionally thin: every
// behavior the design doc cares about already lives in PaneStream and
// XtermSink (the activity coalescing, the rAF resize, the in-place option
// setters, the cached-seed re-attach). React's job is to call them in the
// right order at the right time, and to **never** torpedo their invariants
// by re-mounting xterm when only a style prop changed.
//
// [LAW:dataflow-not-control-flow] Single mount/unmount effect keyed on
//   `stream` identity. Style/theme effects only call setters; they do not
//   reconstruct the sink. The byte path therefore drives zero React
//   re-renders (O5) and re-renders driven by font/theme prop changes do not
//   tear down xterm (O10).
// [LAW:single-enforcer] One mount path. The cleanup function is the only
//   thing that ever calls `sink.dispose()` from this adapter. Style effects
//   never branch into a dispose path.
// [LAW:locality-or-seam] The component's only seam to the outside is its
//   props. No global state, no context, no module-scope singletons —
//   that's what makes the same component drop into promptctl, the demo,
//   or any other consumer's reactive layer without forking.

import { useEffect, useRef, type ReactElement } from "react";
import type { PaneStream } from "../stream/index.js";
import { XtermSink } from "../xterm-sink/index.js";

export interface PaneTerminalProps {
  /**
   * Data carrier. The component's mount lifecycle is keyed on this prop's
   * identity — passing a new `PaneStream` instance tears down the existing
   * sink and constructs a new one. Same instance across renders ⇒ no
   * remount, no capture-pane round-trip (gate #4).
   */
  readonly stream: PaneStream;
  /**
   * Construction-time only. xterm.js exposes no live setter for the font
   * family, so changing this prop after mount has no effect. To switch
   * fonts, pass a different `stream` (forces remount) or rebuild the
   * containing tree.
   */
  readonly fontFamily?: string;
  /** Live: changes update via `sink.setFontSize()` without remount. */
  readonly fontSize?: number;
  /** Construction-time only (xterm has no live `setScrollback`). */
  readonly scrollback?: number;
  /** Live: changes merge via `sink.setTheme()` without remount. */
  readonly theme?: { readonly background?: string; readonly foreground?: string };
  /** Mount-time only — `sink.focus()` runs once after attach if true. */
  readonly autoFocus?: boolean;
  /** Forwarded to the container `<div>` for layout/styling. */
  readonly className?: string;
}

export function PaneTerminal(props: PaneTerminalProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sinkRef = useRef<XtermSink | null>(null);

  // Stream-identity-keyed mount. The body of this effect is the ONLY place
  // that constructs a sink; the cleanup is the ONLY place that disposes
  // one. React StrictMode's double-invoke runs the cleanup between the two
  // mounts; PaneStream.attach() replays its cached seed on the second
  // attach so no second `capture-pane` is issued (gate #4 — verified by
  // the StrictMode test in tests/unit).
  useEffect(() => {
    // [LAW:no-defensive-null-guards] React commits the ref before running
    // effects; `containerRef.current` is the rendered div. The `=== null`
    // narrow exists for the type, not for a real runtime case.
    const container = containerRef.current;
    if (container === null) return undefined;

    const sink = new XtermSink({
      container,
      fontFamily: props.fontFamily,
      fontSize: props.fontSize,
      scrollback: props.scrollback,
      theme: props.theme,
    });
    sinkRef.current = sink;

    const offKeys = sink.onData((data) => {
      void props.stream.sendKeys(data);
    });
    props.stream.attach(sink);

    if (props.autoFocus === true) {
      sink.focus();
    }

    return () => {
      offKeys();
      props.stream.detach();
      sink.dispose();
      sinkRef.current = null;
    };
    // The mount effect re-runs ONLY on stream identity. Style/theme/autoFocus
    // changes are handled by the dedicated effects below; including them in
    // this dep list would force a remount and undo O10.
  }, [props.stream]);

  // Live font-size updates. In-place setter; never reconstructs the sink.
  useEffect(() => {
    const sink = sinkRef.current;
    if (sink === null) return;
    if (props.fontSize === undefined) return;
    sink.setFontSize(props.fontSize);
  }, [props.fontSize]);

  // Live theme updates. In-place setter; never reconstructs the sink.
  useEffect(() => {
    const sink = sinkRef.current;
    if (sink === null) return;
    if (props.theme === undefined) return;
    sink.setTheme(props.theme);
  }, [props.theme]);

  return <div ref={containerRef} className={props.className} />;
}
