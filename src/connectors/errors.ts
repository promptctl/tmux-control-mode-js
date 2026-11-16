// src/connectors/errors.ts
// The bridge-error taxonomy every connector throws, plus the wire-parser
// failure type. Renderer-safe: zero Node-only imports.
//
// [LAW:one-source-of-truth] `BridgeErrorCode` and `BridgeError` are declared
//   once, in `src/bridge-error.ts` (beside the core error taxonomy, so
//   `isConnectionGone` can tell a closed bridge from a live tmux's refusal);
//   this module re-exports them for every connector and consumer.

import { BridgeError } from "../bridge-error.js";

export {
  BridgeError,
  isBridgeErrorCode,
  type BridgeErrorCode,
  type BridgeErrorPayload,
} from "../bridge-error.js";

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

// ---------------------------------------------------------------------------
// toBridgeProtocolError — the single home for "an unknown value was thrown by
// a wire decode/parse; give me the canonical typed error".
//
// [LAW:single-enforcer] Every catch around a wire parser (client onMessage,
// server onFrame) routes through here instead of re-deriving the
// `err instanceof BridgeError ? … : new BridgeError(…)` narrowing inline.
// [LAW:no-defensive-null-guards] The wire decoders (`decodePaneOutput`,
// `parseServerFrame`/`parseClientFrame`) only ever throw `BridgeProtocolError`,
// so the wrap branch is unreachable in practice — it exists solely because
// `catch` widens the thrown value to `unknown`. Concentrating it here keeps
// that one narrowing in a single place rather than scattered at each seam.
// An existing BridgeError (including the BridgeProtocolError the decoders
// throw) passes through untouched so its specific code and message survive.
// ---------------------------------------------------------------------------

// What a consumer's hook threw, as text for the error the bridge reports in
// its place: a BridgeError's message without its `[CODE] ` prefix, since the
// report carries a code of its own.
// [LAW:single-enforcer] Every catch around a consumer's hook (authenticate,
//   createClient) words the thrown value here.
export function thrownMessage(err: unknown): string {
  return err instanceof BridgeError
    ? err.toPayload().message
    : err instanceof Error
      ? err.message
      : String(err);
}

export function toBridgeProtocolError(err: unknown): BridgeError {
  return err instanceof BridgeError
    ? err
    : new BridgeError(
        "BRIDGE_PROTOCOL_ERROR",
        err instanceof Error ? err.message : String(err),
      );
}
