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
// [LAW:one-source-of-truth] Method names, arg shapes, and validators all
// live here. The dispatcher uses the same RpcMethod tag set.
// [LAW:single-enforcer] parseRpcRequest is the only validation site for
// renderer/peer-supplied method calls. Downstream operates on RpcRequest.
// [LAW:dataflow-not-control-flow] One indexed lookup for parsing; control
// flow is a straight pipe per request, the variance rides in the union.

import type { SplitOptions } from "../protocol/encoder.js";
import {
  PaneAction,
  type CommandResponse,
} from "../protocol/types.js";

// ---------------------------------------------------------------------------
// RpcRequest discriminated union — one variant per bridged TmuxClient method.
// ---------------------------------------------------------------------------

export type RpcRequest =
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

export type RpcMethod = RpcRequest["method"];

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
  constructor(code: RpcErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "RpcError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Method allowlist — derived from RpcRequest so the union is the single
// source of truth. Any new variant must also be listed here, and TypeScript
// catches drift via the `Set<RpcMethod>` constraint.
// ---------------------------------------------------------------------------

export const RPC_METHOD_NAMES: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
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

type ArgValidator<R extends RpcRequest> = (
  args: readonly unknown[],
) => R["args"];

type Validators = {
  readonly [R in RpcRequest as R["method"]]: ArgValidator<R>;
};

const VALIDATORS: Validators = Object.assign(
  Object.create(null) as Validators,
  {
    execute: (args) => [requireString(args, 0, "command")] as const,
    listWindows: (args) => requireNoArgs(args),
    listPanes: (args) => requireNoArgs(args),
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
    queryClipboard: (args) => requireNoArgs(args),
    detach: (args) => requireNoArgs(args),
  } satisfies Validators,
);

/**
 * Parse an untrusted payload into a typed RpcRequest. Throws RpcError on any
 * malformed input. This is the only validation site — downstream operates on
 * RpcRequest values and never re-checks shape.
 */
export function parseRpcRequest(raw: unknown): RpcRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RpcError(
      "INVALID_REQUEST",
      "request must be a non-array object",
    );
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
  const validator = VALIDATORS[method] as (
    args: readonly unknown[],
  ) => RpcRequest["args"];
  const args = validator(obj.args);
  return { method, args } as RpcRequest;
}

// ---------------------------------------------------------------------------
// Synthesized fire-method response.
//
// Some TmuxClient methods produce no tmux %begin/%end pair (currently only
// `detach`). The dispatcher (in ./rpc-dispatch.ts) calls this to give every
// dispatch a uniform Promise<CommandResponse> result, so callers never have
// to special-case fire methods.
// ---------------------------------------------------------------------------

export function synthesizeFireResponse(): CommandResponse {
  return {
    commandNumber: -1,
    timestamp: Date.now(),
    success: true,
    output: [],
  };
}

// ---------------------------------------------------------------------------
// Validator helpers
// ---------------------------------------------------------------------------

function requireNoArgs(args: readonly unknown[]): readonly [] {
  if (args.length !== 0) {
    throw new RpcError(
      "INVALID_ARG",
      `expected 0 arg(s), got ${args.length}`,
    );
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
