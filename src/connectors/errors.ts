// src/connectors/errors.ts
// Shared bridge-error taxonomy for every TmuxClient connector.
//
// This module is renderer-safe: it has zero Node-only imports. The Electron
// renderer-side proxy and the browser-side WebSocket client both reach this
// file directly, so the same `BridgeError` instance crosses every transport
// boundary the library defines.
//
// [LAW:one-source-of-truth] The unified `BridgeErrorCode` union lives here
// and ONLY here. Both `connectors/electron/types.ts` and
// `connectors/websocket/protocol.ts` re-export the symbols below — neither
// declares its own parallel taxonomy. A consumer doing
// `if (e instanceof BridgeError && e.code === "BRIDGE_TIMEOUT")` is
// transport-agnostic.
//
// [LAW:one-type-per-behavior] One BridgeError class for every bridge failure;
// `BridgeProtocolError` is a tagged subclass for parser-time wire failures so
// `instanceof BridgeProtocolError` tests stay meaningful, but it is the SAME
// `BridgeError` shape — no parallel hierarchy.
//
// [LAW:single-enforcer] Wire serialization rides through `toPayload` /
// `fromPayload`. Real Electron's `ipcMain.handle` rejection serializer drops
// custom Error properties (including `.code`); the WS wire frame is JSON.
// The payload pair survives both serializers identically, so the renderer-
// side proxy and the browser-side WebSocket client reconstruct typed errors
// the same way.

// ---------------------------------------------------------------------------
// BridgeErrorCode — the unified wire-level taxonomy.
//
// Naming convention: every code uses the `BRIDGE_*` prefix EXCEPT
// `TMUX_ERROR`, which identifies the source rather than the bridge layer
// (tmux replied with `%error`). The prefix makes BridgeError codes visually
// distinct from `RpcErrorCode` (validator-internal) and from tmux's own
// error vocabulary.
// ---------------------------------------------------------------------------

export type BridgeErrorCode =
  /** tmux replied with %error (a tmux-level command failure). */
  | "TMUX_ERROR"
  /** Malformed wire frame, unknown discriminator. */
  | "BRIDGE_PROTOCOL_ERROR"
  /** RPC envelope was missing/non-object/lacking method or args. */
  | "BRIDGE_INVALID_REQUEST"
  /** Method args did not match the expected shape for the method. */
  | "BRIDGE_INVALID_ARG"
  /** Method name not present in the RPC dispatch allowlist. */
  | "BRIDGE_UNKNOWN_METHOD"
  /** Per-call deadline reached before the response arrived. */
  | "BRIDGE_TIMEOUT"
  /** Connection / dispatch closed while the call was in flight. */
  | "BRIDGE_CLOSED"
  /** Dispatch was abandoned because its sender was destroyed mid-flight. */
  | "BRIDGE_ABORTED"
  /** Unexpected bridge-internal error (a bug in the bridge or its hosts). */
  | "BRIDGE_INTERNAL"
  /** `authenticate()` hook rejected the connection at upgrade time. */
  | "BRIDGE_AUTH_DENIED"
  /** `authorize()` hook rejected a specific call. */
  | "BRIDGE_COMMAND_DENIED"
  /** Per-connection rate limit exceeded. */
  | "BRIDGE_RATE_LIMITED"
  /** createMainBridge called twice on the same ipcMain. */
  | "BRIDGE_ALREADY_REGISTERED"
  /**
   * A second `createPaneBytesReceiver` (Electron renderer side) was
   * constructed for an `(ipcRenderer, paneId)` pair that already has an
   * active receiver. `paneEnd` carries only `paneId`, so a second receiver
   * would race the auto-detach — whichever handles `paneEnd` first tears
   * every receiver for that pair down — or split the byte stream across two
   * sinks with no way to tell them apart. The factory refuses the second
   * registration loudly instead of silently corrupting byte flow; drop the
   * prior attachment (call its disposer) before constructing a new one.
   *
   * The server-side sinks (`attachWebContentsSink`, `attachWebSocketSink`)
   * keep no exclusivity registry and never raise this — multiple scoped
   * attachments on one target are valid.
   */
  | "BRIDGE_PANE_SINK_ALREADY_ATTACHED"
  /** Renderer attempted to unsubscribe a name it does not own. */
  | "BRIDGE_UNKNOWN_SUBSCRIPTION"
  /**
   * A peer attempted to subscribe a name already held under a different
   * (what, format) pair. The bridge refuses to silently overwrite tmux's
   * binding because that would change the wire format the prior subscriber
   * is observing — see `bridge-connection.ts` for the rationale.
   */
  | "BRIDGE_SUBSCRIPTION_FORMAT_CONFLICT";

// ---------------------------------------------------------------------------
// BridgeErrorPayload — the wire shape used by BOTH transports to carry a
// typed error across a serialization boundary that drops Error subclasses.
// ---------------------------------------------------------------------------

export interface BridgeErrorPayload {
  readonly code: BridgeErrorCode;
  readonly message: string;
  /**
   * Optional `Error.stack` from the producing side. Carried so a renderer-
   * side consumer that logs the reconstructed `BridgeError` sees the same
   * trace context an unwrapped Electron rejection would have shown in dev
   * mode (where Electron normally serializes `.stack` along with `.message`).
   *
   * Used today by `BRIDGE_INTERNAL` envelopes built at the IPC boundary —
   * those wrap an unexpected dispatch failure and carry the cause's stack
   * appended via `\nCaused by: ...` so renderer logs localize without a
   * round-trip to the main process. Other code paths typically omit this
   * field; it is debug-aid, not load-bearing.
   */
  readonly stack?: string;
}

// ---------------------------------------------------------------------------
// BridgeError — the typed error every connector throws.
//
// Message format: `[CODE] message`. The prefix mirrors `Error.toString()` for
// ad-hoc logging (where `.code` is not inspected) without forcing every
// consumer to re-stringify. Since `Error.message` is the only field that
// survives serialization in the unwrapped path, embedding the code there
// makes legacy logs still useful when a payload envelope is unavailable.
// `.code` remains the canonical machine-readable discriminator.
// ---------------------------------------------------------------------------

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;

  constructor(code: BridgeErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "BridgeError";
    this.code = code;
  }

  toPayload(): BridgeErrorPayload {
    const base: BridgeErrorPayload = {
      code: this.code,
      message: this.bareMessage(),
    };
    // [LAW:dataflow-not-control-flow] Stack is data on the payload — a
    // renderer that reconstructs via fromPayload sees the same trace
    // context every time. The `?? undefined` keeps the payload object
    // shape consistent across V8 versions where `.stack` is sometimes
    // absent on freshly-thrown errors (very old runtimes).
    return this.stack === undefined ? base : { ...base, stack: this.stack };
  }

  static fromPayload(p: BridgeErrorPayload): BridgeError {
    const e = new BridgeError(p.code, p.message);
    if (p.stack !== undefined) e.stack = p.stack;
    return e;
  }

  /**
   * Strip the `[CODE] ` prefix from `Error.message` for serialization. The
   * payload carries `code` separately, so duplicating it inside `message`
   * would round-trip as `[CODE] [CODE] ...` after `fromPayload` re-prepends.
   */
  private bareMessage(): string {
    const expected = `[${this.code}] `;
    return this.message.startsWith(expected)
      ? this.message.slice(expected.length)
      : this.message;
  }
}

// ---------------------------------------------------------------------------
// BridgeProtocolError — tagged subclass for wire-frame parser failures.
//
// Carries `BRIDGE_PROTOCOL_ERROR` so consumers that already test
// `err.code === "BRIDGE_PROTOCOL_ERROR"` keep working, while
// `err instanceof BridgeProtocolError` lets the WS protocol parser
// distinguish "this came from frame parsing" from a generic bridge error.
// ---------------------------------------------------------------------------

export class BridgeProtocolError extends BridgeError {
  constructor(message: string) {
    super("BRIDGE_PROTOCOL_ERROR", message);
    this.name = "BridgeProtocolError";
  }
}
