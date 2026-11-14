// src/connectors/rpc.ts
// Shared RPC types + validation for every TmuxClient bridge connector.
//
// This module is renderer-safe: it has zero Node-only imports and no
// reference to `TmuxClient` (even as a type), so the electron renderer can
// transitively reach `RpcRequest` for type-checking without dragging the
// Node-side TmuxClient into its bundle. The dispatcher that actually invokes
// TmuxClient methods lives in `./rpc-dispatch.ts`.
//
// Adding a TmuxClient method to the bridge requires a coordinated edit in
// THIS file (one variant on RpcRequest + one validator entry) AND in
// `./rpc-dispatch.ts` (one dispatcher entry). Both are mapped-type-keyed by
// `RpcMethod`, so missing entries fail at compile time.
//
// `RpcProxyApi` (below) closes the loop on the renderer side: any consumer
// that exposes the bridged surface must structurally implement it. Forgetting
// to add a proxy method when adding a new RpcRequest variant becomes a
// compile error rather than a silently-missing method at runtime.
//
// [LAW:one-source-of-truth] Method names, arg shapes, and validators all
// live here. The dispatcher uses the same RpcMethod tag set, and the
// proxy API contract derives from the same union.
// [LAW:single-enforcer] parseRpcRequest is the only validation site for
// renderer/peer-supplied method calls. Downstream operates on RpcRequest.
// [LAW:dataflow-not-control-flow] One indexed lookup for parsing; control
// flow is a straight pipe per request, the variance rides in the union.

import type { SplitOptions } from "../protocol/encoder.js";
import {
  PaneAction,
  type CommandResponse,
  type PaneRecord,
  type SessionRecord,
  type WindowRecord,
} from "../protocol/types.js";
import { CROSS_SESSION_LAYOUT_SUBSCRIPTION_NAME } from "../cross-session-layout-messages.js";
import type { BridgeErrorCode } from "./errors.js";

// ---------------------------------------------------------------------------
// RpcSpec — one declaration site per bridged TmuxClient method, carrying
// both its args tuple and its response shape together. RpcRequest and
// RpcResponseMap are both *derived* from this table rather than hand-written
// separately, so a method's args and response can't drift apart the way a
// hand-maintained `RpcResponseMap` conditional chain could: forgetting to
// add a non-CommandResponse method there was not a compile error, it was a
// silent wrong default. Here, `response` is a mandatory field per method, so
// a missing one fails to compile instead.
//
// `detach` is intentionally NOT bridged: it tears down the tmux client for
// every renderer that shares the main-process bridge. It is an admin-only
// operation owned by the host application; renderers must not be able to
// invoke it. Removing it from the dispatch table makes a renderer attempt
// fail with `UNKNOWN_METHOD` at the trust boundary.
//
// [LAW:types-are-the-program] A method's response type states what is
// actually true for it rather than the uniform shape that was only true by
// coincidence.
// [LAW:one-source-of-truth] Args and response live once, at the method's own
// declaration, instead of args in one union and response in a separate
// conditional chain that must be kept in sync by hand.
// ---------------------------------------------------------------------------

interface RpcSpec {
  readonly execute: {
    readonly args: readonly [command: string];
    readonly response: CommandResponse;
  };
  readonly listWindows: {
    readonly args: readonly [];
    readonly response: readonly WindowRecord[];
  };
  readonly listPanes: {
    readonly args: readonly [];
    readonly response: readonly PaneRecord[];
  };
  readonly listSessions: {
    readonly args: readonly [];
    readonly response: readonly SessionRecord[];
  };
  readonly sendKeys: {
    readonly args: readonly [target: string, keys: string];
    readonly response: CommandResponse;
  };
  readonly splitWindow: {
    readonly args: readonly [options?: SplitOptions];
    readonly response: CommandResponse;
  };
  readonly setSize: {
    readonly args: readonly [width: number, height: number];
    readonly response: CommandResponse;
  };
  readonly setPaneAction: {
    readonly args: readonly [paneId: number, action: PaneAction];
    readonly response: CommandResponse;
  };
  readonly subscribeRaw: {
    readonly args: readonly [name: string, what: string, format: string];
    readonly response: CommandResponse;
  };
  readonly unsubscribe: {
    readonly args: readonly [name: string];
    readonly response: CommandResponse;
  };
  readonly setFlags: {
    readonly args: readonly [flags: readonly string[]];
    readonly response: CommandResponse;
  };
  readonly clearFlags: {
    readonly args: readonly [flags: readonly string[]];
    readonly response: CommandResponse;
  };
  readonly requestReport: {
    readonly args: readonly [paneId: number, report: string];
    readonly response: CommandResponse;
  };
  readonly queryClipboard: {
    readonly args: readonly [];
    readonly response: CommandResponse;
  };
  // Bridge-stateful: answered by the bridge's per-peer ledger, not by one tmux
  // command, so there is no CommandResponse to return — `null` says so.
  readonly enableCrossSessionLayoutChange: {
    readonly args: readonly [];
    readonly response: null;
  };
  readonly disableCrossSessionLayoutChange: {
    readonly args: readonly [];
    readonly response: null;
  };
}

export type RpcMethod = keyof RpcSpec;

// RpcRequest stays a discriminated union — every downstream consumer narrows
// on `method` the same way it always did. Deriving it from RpcSpec is what
// keeps a method's args tied to its own response at one declaration site.
export type RpcRequest = {
  readonly [M in RpcMethod]: {
    readonly method: M;
    readonly args: RpcSpec[M]["args"];
  };
}[RpcMethod];

export type RpcResponseMap = {
  readonly [M in RpcMethod]: RpcSpec[M]["response"];
};

// ---------------------------------------------------------------------------
// RpcProxyApi — the bridged surface a renderer-side proxy must implement.
//
// Derived directly from RpcRequest so adding a new variant flows into a new
// required method on every proxy implementation. TmuxClientProxy (and any
// future proxy for a different transport) must structurally satisfy this
// type — TypeScript catches drift at compile time.
//
// [LAW:one-type-per-behavior] One type defines what every bridge proxy looks
// like; concrete proxies are instances, not separate types.
// ---------------------------------------------------------------------------

export type RpcProxyApi = {
  readonly [M in RpcMethod]: (
    ...args: [...RpcSpec[M]["args"]]
    // A null wire answer surfaces as `void`, matching TmuxClient's signature.
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- the proxy's return type, spelled through a conditional
  ) => Promise<RpcResponseMap[M] extends null ? void : RpcResponseMap[M]>;
};

// ---------------------------------------------------------------------------
// RpcError — single error class for every parse failure.
// ---------------------------------------------------------------------------

export type RpcErrorCode =
  /** Envelope was missing/non-object/lacking method or args. */
  | "INVALID_REQUEST"
  /** Method name not present in the dispatch table allowlist. */
  | "UNKNOWN_METHOD"
  /** Args array did not match the expected shape for the method. */
  | "INVALID_ARG";

export class RpcError extends Error {
  readonly code: RpcErrorCode;
  /**
   * The unprefixed message, before the `[CODE] ` prefix that `.message`
   * carries. [LAW:one-source-of-truth] The bare text has one authoritative home
   * here so consumers that re-wrap the error (e.g. the Electron bridge mapping
   * RpcError → BridgeError) read it structurally instead of regex-stripping the
   * prefix off `.message` and coupling to this constructor's format.
   */
  readonly original: string;
  constructor(code: RpcErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "RpcError";
    this.code = code;
    this.original = message;
  }
}

// ---------------------------------------------------------------------------
// RpcErrorCode → BridgeErrorCode taxonomy translation.
//
// RpcError is connector-internal (a validator-time parse failure); the code a
// renderer/peer sees on the wire is a BridgeErrorCode. Each parse failure has
// exactly one wire code. This translation lives here — beside the RpcErrorCode
// it consumes — so every connector maps the SAME way. The `satisfies` clause
// forces one entry per RpcErrorCode at compile time; a single home is what
// forces both transports to agree on the VALUE (a per-file table only caught
// a missing KEY, never a diverged value).
//
// [LAW:single-enforcer] One taxonomy translation for every connector; the WS
// server and the Electron main both call mapRpcCode rather than restating it.
// [LAW:one-source-of-truth] The values live once; the per-connector copies are
// gone.
// [LAW:one-way-deps] rpc.ts (specific: RPC internals) depends on errors.ts
// (general: the wire taxonomy every transport reaches); errors.ts stays
// ignorant of RPC. BridgeErrorCode is a type-only import, erased at runtime,
// so rpc.ts keeps its renderer-safe / zero-runtime-dep contract.
// ---------------------------------------------------------------------------

const RPC_ERROR_TO_BRIDGE: Readonly<Record<RpcErrorCode, BridgeErrorCode>> = {
  UNKNOWN_METHOD: "BRIDGE_UNKNOWN_METHOD",
  INVALID_REQUEST: "BRIDGE_INVALID_REQUEST",
  INVALID_ARG: "BRIDGE_INVALID_ARG",
};

export function mapRpcCode(code: RpcErrorCode): BridgeErrorCode {
  return RPC_ERROR_TO_BRIDGE[code];
}

// ---------------------------------------------------------------------------
// Per-method arg validators.
//
// Each validator takes `unknown[]` and returns the typed args tuple for its
// variant or throws RpcError. The Validators mapped type forces an entry per
// variant; the `satisfies` clause is what makes that exhaustiveness load-
// bearing at compile time.
//
// VALIDATORS is backed by Object.create(null) so a compromised peer sending
// `method: "constructor"` resolves to `undefined`, not a built-in. The
// allowlist check above is the primary gate; this is defense in depth.
// ---------------------------------------------------------------------------

type ArgValidator<M extends RpcMethod> = (
  args: readonly unknown[],
) => RpcSpec[M]["args"];

type Validators = {
  readonly [M in RpcMethod]: ArgValidator<M>;
};

// Module-scoped allowlist for splitWindow options. Hoisted from the
// per-call validator body so the Set is allocated once at module load.
const KNOWN_SPLIT_OPTIONS: ReadonlySet<string> = new Set([
  "vertical",
  "target",
]);

const VALIDATORS: Validators = Object.assign(
  Object.create(null) as Validators,
  {
    execute: (args) => [requireString(args, 0, "command")] as const,
    listWindows: (args) => requireNoArgs(args),
    listPanes: (args) => requireNoArgs(args),
    listSessions: (args) => requireNoArgs(args),
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
        throw new RpcError(
          "INVALID_ARG",
          "splitWindow: options must be an object",
        );
      }
      const obj = opts as Record<string, unknown>;
      // [LAW:single-enforcer] Full field validation — the encoder consumes
      // validated data, it is not a second validator.
      if ("vertical" in obj && typeof obj.vertical !== "boolean") {
        throw new RpcError(
          "INVALID_ARG",
          "splitWindow: options.vertical must be a boolean",
        );
      }
      if ("target" in obj && typeof obj.target !== "string") {
        throw new RpcError(
          "INVALID_ARG",
          "splitWindow: options.target must be a string",
        );
      }
      for (const key of Object.keys(obj)) {
        if (!KNOWN_SPLIT_OPTIONS.has(key)) {
          throw new RpcError(
            "INVALID_ARG",
            `splitWindow: unknown option "${key}"`,
          );
        }
      }
      return [opts as SplitOptions] as const;
    },
    setSize: (args) =>
      [
        requireNonNegativeInteger(args, 0, "width"),
        requireNonNegativeInteger(args, 1, "height"),
      ] as const,
    setPaneAction: (args) =>
      [
        requireNonNegativeInteger(args, 0, "paneId"),
        requirePaneAction(args, 1),
      ] as const,
    subscribeRaw: (args) =>
      [
        requireSubscriptionName(args, 0),
        requireString(args, 1, "what"),
        requireString(args, 2, "format"),
      ] as const,
    unsubscribe: (args) => [requireSubscriptionName(args, 0)] as const,
    setFlags: (args) => [requireStringArray(args, 0, "flags")] as const,
    clearFlags: (args) => [requireStringArray(args, 0, "flags")] as const,
    requestReport: (args) =>
      [
        requireNonNegativeInteger(args, 0, "paneId"),
        requireString(args, 1, "report"),
      ] as const,
    queryClipboard: (args) => requireNoArgs(args),
    enableCrossSessionLayoutChange: (args) => requireNoArgs(args),
    disableCrossSessionLayoutChange: (args) => requireNoArgs(args),
  } satisfies Validators,
);

// ---------------------------------------------------------------------------
// Method allowlist — projected from VALIDATORS so the validator map is the
// single runtime source of truth for the bridged method set. `satisfies
// Validators` already forces one entry per RpcRequest variant at compile time,
// so a new method flows into the allowlist with no extra edit site.
//
// [LAW:one-source-of-truth] VALIDATORS enumerates the methods; the allowlist
// derives from it rather than restating the list.
// ---------------------------------------------------------------------------

export const RPC_METHOD_NAMES: ReadonlySet<RpcMethod> = new Set(
  Object.keys(VALIDATORS) as readonly RpcMethod[],
);

/**
 * Parse an untrusted payload into a typed RpcRequest. Throws RpcError on any
 * malformed input. This is the only validation site — downstream operates on
 * RpcRequest values and never re-checks shape.
 */
export function parseRpcRequest(raw: unknown): RpcRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RpcError("INVALID_REQUEST", "request must be a non-array object");
  }
  const obj = raw as { method?: unknown; args?: unknown };
  if (typeof obj.method !== "string") {
    throw new RpcError("INVALID_REQUEST", "request.method must be a string");
  }
  if (!RPC_METHOD_NAMES.has(obj.method as RpcMethod)) {
    throw new RpcError(
      "UNKNOWN_METHOD",
      `unknown method: ${JSON.stringify(obj.method)}`,
    );
  }
  if (!Array.isArray(obj.args)) {
    throw new RpcError("INVALID_REQUEST", "request.args must be an array");
  }
  const method = obj.method as RpcMethod;
  // This cast has the same shape as the one `dispatchRpcRequest` used to
  // need (indexing a mapped type by a widened key loses TS's per-method
  // correlation) and is NOT converted to a switch for the same reason that
  // fix doesn't apply here: RPC_METHOD_NAMES above derives its allowlist
  // from `Object.keys(VALIDATORS)`, so VALIDATORS has to stay an
  // introspectable runtime value. `dispatchRpcRequest` had nothing else
  // deriving from its table, so trading dataflow for a sound switch cost
  // nothing; doing the same here would cost one-source-of-truth on the
  // allowlist instead.
  const validator = VALIDATORS[method] as (
    args: readonly unknown[],
  ) => RpcRequest["args"];
  const args = validator(obj.args);
  return { method, args } as RpcRequest;
}

// ---------------------------------------------------------------------------
// Validator helpers
// ---------------------------------------------------------------------------

function requireNoArgs(args: readonly unknown[]): readonly [] {
  if (args.length !== 0) {
    throw new RpcError("INVALID_ARG", `expected 0 arg(s), got ${args.length}`);
  }
  return [] as const;
}

function requireArityAtMost(args: readonly unknown[], max: number): void {
  if (args.length > max) {
    throw new RpcError(
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
    throw new RpcError(
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
    throw new RpcError(
      "INVALID_ARG",
      `arg ${index} (${name}) must be a finite number`,
    );
  }
  return v;
}

// [LAW:single-enforcer] Non-negative integer check for pane IDs and dimensions.
// Reusable across all methods that accept tmux entity IDs or sizes — same rule
// enforced once, consumed everywhere.
function requireNonNegativeInteger(
  args: readonly unknown[],
  index: number,
  name: string,
): number {
  const v = requireFiniteNumber(args, index, name);
  if (v < 0 || !Number.isInteger(v)) {
    throw new RpcError(
      "INVALID_ARG",
      `arg ${index} (${name}) must be a non-negative integer`,
    );
  }
  return v;
}

// Rejects empty subscription names at the RPC argument boundary — an empty
// name is meaningless to tmux. This is ordinary input validation for this
// argument, alongside the sibling `require*` guards above.
function requireNonEmptyString(
  args: readonly unknown[],
  index: number,
  name: string,
): string {
  const v = requireString(args, index, name);
  if (v.length === 0) {
    throw new RpcError(
      "INVALID_ARG",
      `arg ${index} (${name}) must be a non-empty string`,
    );
  }
  return v;
}

// The cross-session layout relay's subscription shares the bridge's one tmux
// client; a peer binding the same name would replace the relay's binding and
// silence coverage for every peer, so the name is not a peer's to take.
function requireSubscriptionName(
  args: readonly unknown[],
  index: number,
): string {
  const v = requireNonEmptyString(args, index, "name");
  if (v === CROSS_SESSION_LAYOUT_SUBSCRIPTION_NAME) {
    throw new RpcError(
      "INVALID_ARG",
      `arg ${index} (name) "${v}" is reserved for cross-session layout coverage`,
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
    throw new RpcError(
      "INVALID_ARG",
      `arg ${index} (${name}) must be an array`,
    );
  }
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== "string") {
      throw new RpcError(
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
    throw new RpcError(
      "INVALID_ARG",
      `arg ${index} (action) must be one of ${[...PANE_ACTIONS].join(", ")}`,
    );
  }
  return v as PaneAction;
}
