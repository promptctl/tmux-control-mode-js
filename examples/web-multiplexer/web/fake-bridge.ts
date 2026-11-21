// examples/web-multiplexer/web/fake-bridge.ts
//
// Test double for `TmuxBridge`: every command succeeds with empty output,
// every subscription is inert, and the sizing calls reject as unmodeled. A
// test overrides only the methods its case drives.
//
// [LAW:one-source-of-truth] The one inert bridge every store test builds on,
//   so a new bridge method is one edit here, not one per test file.

import type { CommandResponse } from "@promptctl/tmux-control-mode-js/protocol";
import type { TmuxBridge } from "./bridge.ts";

export const OK: CommandResponse = {
  commandNumber: 0,
  timestamp: 0,
  output: [],
  success: true,
};

export function fakeBridge(overrides: Partial<TmuxBridge> = {}): TmuxBridge {
  const noop = (): void => undefined;
  const noopUnsub = (): (() => void) => noop;
  const unmodeled = (name: string) => () =>
    Promise.reject(new Error(`${name}: not modeled`));
  return {
    execute: () => Promise.resolve(OK),
    sendKeys: () => Promise.resolve(OK),
    connect: noop,
    disconnect: noop,
    onEvent: noopUnsub,
    onPaneOutput: noopUnsub,
    onError: noopUnsub,
    onState: noopUnsub,
    onWire: noopUnsub,
    startFirehose: noop,
    stopFirehose: noop,
    onFirehose: noopUnsub,
    setSize: unmodeled("setSize"),
    setWindowSize: unmodeled("setWindowSize"),
    clearWindowSize: unmodeled("clearWindowSize"),
    ...overrides,
  };
}
