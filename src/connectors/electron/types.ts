// src/connectors/electron/types.ts
// Shared types + constants for the Electron IPC bridge.
// Imported by both main.ts (Node-side) and renderer.ts (browser-side).
// MUST remain free of Node-only imports.

// [LAW:one-source-of-truth] IPC channel names + request shape live here only.
// Both ends of the bridge import from this module; no duplicate string literals.

import type { SplitOptions } from "../../protocol/encoder.js";
import type { PaneAction } from "../../protocol/types.js";

// ---------------------------------------------------------------------------
// Structural "like" interfaces for Electron.
//
// [LAW:locality-or-seam] These are the seam. Real Electron `IpcMain`,
// `IpcRenderer`, and `WebContents` are structurally assignable — callers pass
// them directly with no casts. Using structural types keeps Electron out of
// our `dependencies` and `devDependencies` entirely.
// ---------------------------------------------------------------------------

export interface WebContentsLike {
  send(channel: string, ...args: unknown[]): void;
  once(event: "destroyed", listener: () => void): void;
  isDestroyed(): boolean;
}

export interface IpcMainInvokeEventLike {
  readonly sender: WebContentsLike;
}

export interface IpcMainEventLike {
  readonly sender: WebContentsLike;
}

export interface IpcMainLike {
  handle(
    channel: string,
    listener: (
      event: IpcMainInvokeEventLike,
      ...args: unknown[]
    ) => unknown | Promise<unknown>,
  ): void;
  removeHandler(channel: string): void;
  on(
    channel: string,
    listener: (event: IpcMainEventLike, ...args: unknown[]) => void,
  ): void;
  removeListener(
    channel: string,
    listener: (...args: unknown[]) => void,
  ): void;
}

export interface IpcRendererEventLike {
  readonly sender?: unknown;
}

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(
    channel: string,
    listener: (event: IpcRendererEventLike, ...args: unknown[]) => void,
  ): void;
  removeListener(
    channel: string,
    listener: (...args: unknown[]) => void,
  ): void;
}

// ---------------------------------------------------------------------------
// IPC channel names. Defined once, imported by both sides.
// ---------------------------------------------------------------------------

export const IPC = {
  /** main → renderer: forwarded TmuxMessage (all notifications, including `exit`). */
  event: "tmux:event",
  /** renderer → main: method dispatch via ipcRenderer.invoke. */
  invoke: "tmux:invoke",
  /** renderer → main: "send me events". */
  register: "tmux:register",
  /** renderer → main: "stop sending me events". */
  unregister: "tmux:unregister",
} as const;

// ---------------------------------------------------------------------------
// Invoke request shape.
//
// [LAW:dataflow-not-control-flow] One `ipcMain.handle("tmux:invoke", ...)`
// handler on main, one `ipcRenderer.invoke("tmux:invoke", req)` call site per
// method on the renderer. The same send operation happens every time; data
// (the `method` tag + `args`) decides which TmuxClient method runs.
//
// [LAW:one-type-per-behavior] The union is a single type that captures every
// TmuxClient method. Adding a method to TmuxClient requires adding one union
// variant here — the compiler guarantees the proxy and dispatcher stay aligned.
// ---------------------------------------------------------------------------

export type InvokeRequest =
  | { readonly method: "execute"; readonly args: readonly [command: string] }
  | { readonly method: "listWindows"; readonly args: readonly [] }
  | { readonly method: "listPanes"; readonly args: readonly [] }
  | {
      readonly method: "sendKeys";
      readonly args: readonly [target: string, keys: string];
    }
  | {
      readonly method: "splitWindow";
      readonly args: readonly [options?: SplitOptions];
    }
  | {
      readonly method: "setSize";
      readonly args: readonly [width: number, height: number];
    }
  | {
      readonly method: "setPaneAction";
      readonly args: readonly [paneId: number, action: PaneAction];
    }
  | {
      readonly method: "subscribe";
      readonly args: readonly [name: string, what: string, format: string];
    }
  | {
      readonly method: "unsubscribe";
      readonly args: readonly [name: string];
    }
  | {
      readonly method: "setFlags";
      readonly args: readonly [flags: readonly string[]];
    }
  | {
      readonly method: "clearFlags";
      readonly args: readonly [flags: readonly string[]];
    }
  | {
      readonly method: "requestReport";
      readonly args: readonly [paneId: number, report: string];
    }
  | { readonly method: "queryClipboard"; readonly args: readonly [] }
  | { readonly method: "detach"; readonly args: readonly [] };

// ---------------------------------------------------------------------------
// Main-bridge lifecycle handle.
// ---------------------------------------------------------------------------

export interface MainBridgeHandle {
  /**
   * Remove all IPC handlers installed by createMainBridge and clear the
   * internal subscriber set. Does NOT close the underlying TmuxClient — the
   * host owns that lifecycle.
   */
  dispose(): void;
}
