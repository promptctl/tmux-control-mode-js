// src/window-terminal/react/index.tsx
//
// `@promptctl/tmux-control-mode-js/window-terminal/react` — `<WindowTerminal>`,
// a thin React shell over `mountWindowTerminal`.
//
// [LAW:one-source-of-truth] The terminal owns every behaviour; this only maps
//   React's lifecycle onto it. Identity (connection, window, history) mounts a
//   new terminal; settings (sizing, appearance) go through `update`; the
//   callbacks and the forwarded ref are read through refs, so a new function
//   each render neither remounts nor resubscribes.

import { forwardRef, useEffect, useRef, type ForwardedRef } from "react";
import {
  mountWindowTerminal,
  type Appearance,
  type Sizing,
  type WindowId,
  type WindowTerminal as Terminal,
  type WindowTerminalError,
  type WindowTerminalOptions,
  type WindowTerminalState,
} from "../index.js";

export interface WindowTerminalProps {
  readonly connection: WindowTerminalOptions["connection"];
  readonly window: WindowId;
  readonly history?: number;
  readonly sizing?: Sizing;
  readonly appearance?: Appearance;
  readonly onState?: (state: WindowTerminalState) => void;
  readonly onError?: (error: WindowTerminalError) => void;
  readonly className?: string;
}

function assign<T>(ref: ForwardedRef<T>, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref !== null) ref.current = value;
}

export const WindowTerminal = forwardRef<Terminal, WindowTerminalProps>(
  function WindowTerminal(props, ref) {
    const host = useRef<HTMLDivElement>(null);
    const terminal = useRef<Terminal | null>(null);
    const latest = useRef(props);
    latest.current = props;
    const { connection, window, history, sizing, appearance } = props;

    useEffect(() => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const element = host.current!;
      const t = mountWindowTerminal(element, {
        connection,
        window,
        history,
        sizing: latest.current.sizing,
        appearance: latest.current.appearance,
      });
      terminal.current = t;
      const offState = t.onState((s) => latest.current.onState?.(s));
      const offError = t.onError((e) => latest.current.onError?.(e));
      return () => {
        offState();
        offError();
        t.dispose();
        terminal.current = null;
      };
    }, [connection, window, history]);

    // The ref has its own lifetime: a new ref gets the terminal and the old
    // one is cleared, as React does for a DOM ref, without remounting. React
    // runs every cleanup before any setup, so a remount clears, then assigns.
    useEffect(() => {
      assign(ref, terminal.current);
      return () => assign(ref, null);
    }, [ref, connection, window, history]);

    useEffect(() => {
      terminal.current?.update({ sizing, appearance });
    }, [sizing, appearance]);

    return <div ref={host} className={props.className} />;
  },
);
