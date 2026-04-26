// src/connectors/electron/types.ts
// Shared types + constants for the Electron IPC bridge.
// Imported by both main.ts (Node-side) and renderer.ts (browser-side).
// MUST remain free of Node-only imports.

// [LAW:one-source-of-truth] IPC channel names, request shape, AND request
// validation all live here. Both ends of the bridge import from this module;
// no duplicate string literals, no second validation site.

import type { SplitOptions } from "../../protocol/encoder.js";
import { PaneAction } from "../../protocol/types.js";

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
  /**
   * renderer → main: "I processed N output bytes for pane P". Drives the
   * credit-based backpressure loop in main.ts — when outstanding bytes for
   * a pane stay above the high-watermark, main pauses the pane via
   * setPaneAction(Pause); acks pulling outstanding back below the
   * low-watermark trigger a resume. See AckMessage.
   */
  ack: "tmux:ack",
} as const;

// ---------------------------------------------------------------------------
// Renderer → main: output-byte ack frame.
// ---------------------------------------------------------------------------

export interface AckMessage {
  readonly paneId: number;
  readonly bytes: number;
}

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

// ---------------------------------------------------------------------------
// Main-bridge tunables.
//
// [LAW:no-mode-explosion] Two knobs only — both governing the same credit
// loop. Defaults are sized for a typical xterm renderer; tests use very low
// values to make pause-trigger behavior observable.
// ---------------------------------------------------------------------------

export interface MainBridgeOptions {
  /**
   * Per-pane outstanding-byte threshold (summed across all subscribed
   * renderers) at which main pauses the pane. Default: 1 MiB.
   */
  readonly outputHighWatermark?: number;
  /**
   * Per-pane outstanding-byte threshold at which a paused pane is resumed.
   * Must be < outputHighWatermark. Default: 256 KiB.
   */
  readonly outputLowWatermark?: number;
}

export const DEFAULT_OUTPUT_HIGH_WATERMARK = 1 << 20;
export const DEFAULT_OUTPUT_LOW_WATERMARK = 1 << 18;

// ---------------------------------------------------------------------------
// Renderer-bridge tunables.
// ---------------------------------------------------------------------------

export interface RendererBridgeOptions {
  /**
   * Bytes-since-last-ack threshold per pane. Renderer batches `tmux:ack`
   * messages to amortize IPC chatter; lower values give tighter feedback to
   * the main-side watermark loop at the cost of more ack traffic.
   * Default: 64 KiB.
   */
  readonly ackBatchBytes?: number;
}

export const DEFAULT_ACK_BATCH_BYTES = 1 << 16;

// ---------------------------------------------------------------------------
// Bridge errors.
//
// [LAW:single-enforcer] Every renderer → main request crosses one validator;
// validation either yields a typed InvokeRequest or throws a BridgeError.
// Downstream code (DISPATCH lookup) operates on validated input only.
// ---------------------------------------------------------------------------

export type BridgeErrorCode =
  /** Request envelope was missing/non-object/lacking method. */
  | "INVALID_REQUEST"
  /** Method name not present in the dispatch table allowlist. */
  | "UNKNOWN_METHOD"
  /** Args array did not match the expected shape for the method. */
  | "INVALID_ARG"
  /** createMainBridge called twice on the same ipcMain. */
  | "ALREADY_REGISTERED";

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  constructor(code: BridgeErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "BridgeError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Request validation.
//
// Renderer is treated as untrusted (a compromised renderer must NOT be able
// to invoke arbitrary tmux commands or trigger prototype-chain lookups). This
// validator is the single trust boundary between renderer and tmux.
// ---------------------------------------------------------------------------

export type RpcMethod = InvokeRequest["method"];

// [LAW:one-source-of-truth] Method allowlist derived from the InvokeRequest
// union via a Set keyed by the method tag. Adding a union variant + a
// validator entry is the entire surface of "expose a new TmuxClient method".
const METHOD_NAMES: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  "execute",
  "listWindows",
  "listPanes",
  "sendKeys",
  "splitWindow",
  "setSize",
  "setPaneAction",
  "subscribe",
  "unsubscribe",
  "setFlags",
  "clearFlags",
  "requestReport",
  "queryClipboard",
  "detach",
]);

type ArgValidator<R extends InvokeRequest> = (
  args: readonly unknown[],
) => R["args"];

type Validators = {
  readonly [R in InvokeRequest as R["method"]]: ArgValidator<R>;
};

// [LAW:dataflow-not-control-flow] One indexed lookup; no per-method branching
// at the call site. The map is built with a null prototype so that a
// compromised renderer sending `method: "constructor"` resolves to
// `undefined`, not Object.prototype.constructor.
// [LAW:no-defensive-null-guards] Validator entries are not null — TypeScript
// guarantees full coverage via the mapped-type constraint above.
const VALIDATORS: Validators = Object.assign(
  Object.create(null) as Validators,
  {
    execute: (args) => [requireString(args, 0, "command")] as const,
    listWindows: (args) => requireArity(args, 0),
    listPanes: (args) => requireArity(args, 0),
    sendKeys: (args) =>
      [
        requireString(args, 0, "target"),
        requireString(args, 1, "keys"),
      ] as const,
    splitWindow: (args) => {
      requireArityAtMost(args, 1);
      const opts = args[0];
      if (opts === undefined) return [undefined] as const;
      if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
        throw new BridgeError(
          "INVALID_ARG",
          "splitWindow: options must be an object",
        );
      }
      // The encoder is the actual SplitOptions parser; here we just shape-check.
      return [opts as SplitOptions] as const;
    },
    setSize: (args) =>
      [
        requireFiniteNumber(args, 0, "width"),
        requireFiniteNumber(args, 1, "height"),
      ] as const,
    setPaneAction: (args) =>
      [
        requireFiniteNumber(args, 0, "paneId"),
        requirePaneAction(args, 1),
      ] as const,
    subscribe: (args) =>
      [
        requireString(args, 0, "name"),
        requireString(args, 1, "what"),
        requireString(args, 2, "format"),
      ] as const,
    unsubscribe: (args) => [requireString(args, 0, "name")] as const,
    setFlags: (args) => [requireStringArray(args, 0, "flags")] as const,
    clearFlags: (args) => [requireStringArray(args, 0, "flags")] as const,
    requestReport: (args) =>
      [
        requireFiniteNumber(args, 0, "paneId"),
        requireString(args, 1, "report"),
      ] as const,
    queryClipboard: (args) => requireArity(args, 0),
    detach: (args) => requireArity(args, 0),
  } satisfies Validators,
);

/**
 * Validate an untrusted renderer payload and return a typed InvokeRequest.
 * Throws BridgeError on any malformed input — caller forwards as a rejection
 * to ipcRenderer.invoke without ever touching TmuxClient.
 *
 * [LAW:single-enforcer] This is the only place that validates IPC requests.
 */
export function parseInvokeRequest(raw: unknown): InvokeRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BridgeError(
      "INVALID_REQUEST",
      "request must be a non-array object",
    );
  }
  const obj = raw as { method?: unknown; args?: unknown };
  if (typeof obj.method !== "string") {
    throw new BridgeError("INVALID_REQUEST", "request.method must be a string");
  }
  if (!METHOD_NAMES.has(obj.method as RpcMethod)) {
    throw new BridgeError(
      "UNKNOWN_METHOD",
      `unknown method: ${JSON.stringify(obj.method)}`,
    );
  }
  if (!Array.isArray(obj.args)) {
    throw new BridgeError("INVALID_REQUEST", "request.args must be an array");
  }
  const method = obj.method as RpcMethod;
  // Indexed via the null-prototype validator table — see VALIDATORS above.
  const validator = VALIDATORS[method] as (
    args: readonly unknown[],
  ) => InvokeRequest["args"];
  const args = validator(obj.args);
  return { method, args } as InvokeRequest;
}

/**
 * Validate an untrusted renderer ack payload. Returns a typed AckMessage or
 * throws BridgeError. The main-side handler simply discards bad acks (logging
 * is a host concern) since acks are not awaited.
 */
export function parseAckMessage(raw: unknown): AckMessage {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BridgeError("INVALID_REQUEST", "ack must be a non-array object");
  }
  const obj = raw as { paneId?: unknown; bytes?: unknown };
  if (typeof obj.paneId !== "number" || !Number.isFinite(obj.paneId)) {
    throw new BridgeError("INVALID_ARG", "ack.paneId must be a finite number");
  }
  if (
    typeof obj.bytes !== "number" ||
    !Number.isFinite(obj.bytes) ||
    obj.bytes < 0
  ) {
    throw new BridgeError(
      "INVALID_ARG",
      "ack.bytes must be a non-negative finite number",
    );
  }
  return { paneId: obj.paneId, bytes: obj.bytes };
}

// ---------------------------------------------------------------------------
// Validator helpers — deliberately verbose so error messages localize the
// bad arg without callsites needing custom messages.
// ---------------------------------------------------------------------------

function requireArity(
  args: readonly unknown[],
  expected: 0,
): readonly [];
function requireArity(args: readonly unknown[], expected: number): readonly [] {
  if (args.length !== expected) {
    throw new BridgeError(
      "INVALID_ARG",
      `expected ${expected} arg(s), got ${args.length}`,
    );
  }
  return [] as const;
}

function requireArityAtMost(
  args: readonly unknown[],
  max: number,
): void {
  if (args.length > max) {
    throw new BridgeError(
      "INVALID_ARG",
      `expected at most ${max} arg(s), got ${args.length}`,
    );
  }
}

function requireString(
  args: readonly unknown[],
  index: number,
  name: string,
): string {
  const v = args[index];
  if (typeof v !== "string") {
    throw new BridgeError(
      "INVALID_ARG",
      `arg ${index} (${name}) must be a string`,
    );
  }
  return v;
}

function requireFiniteNumber(
  args: readonly unknown[],
  index: number,
  name: string,
): number {
  const v = args[index];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new BridgeError(
      "INVALID_ARG",
      `arg ${index} (${name}) must be a finite number`,
    );
  }
  return v;
}

function requireStringArray(
  args: readonly unknown[],
  index: number,
  name: string,
): readonly string[] {
  const v = args[index];
  if (!Array.isArray(v)) {
    throw new BridgeError(
      "INVALID_ARG",
      `arg ${index} (${name}) must be an array`,
    );
  }
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== "string") {
      throw new BridgeError(
        "INVALID_ARG",
        `arg ${index} (${name})[${i}] must be a string`,
      );
    }
  }
  return v as readonly string[];
}

const PANE_ACTIONS: ReadonlySet<string> = new Set<string>(
  Object.values(PaneAction),
);

function requirePaneAction(
  args: readonly unknown[],
  index: number,
): PaneAction {
  const v = args[index];
  if (typeof v !== "string" || !PANE_ACTIONS.has(v)) {
    throw new BridgeError(
      "INVALID_ARG",
      `arg ${index} (action) must be one of ${[...PANE_ACTIONS].join(", ")}`,
    );
  }
  return v as PaneAction;
}
