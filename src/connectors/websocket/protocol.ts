// src/connectors/websocket/protocol.ts
// Wire protocol for the tmux-control-mode-js WebSocket bridge.
//
// One WebSocket carries two channels:
//   - Control plane: JSON text frames (versioned, discriminated).
//   - Data plane:    Binary frames for pane output (no base64 bloat).
//
// Pane output dominates bandwidth on any live tmux session, so the data plane
// is kept cheap: a tiny fixed-size header + the raw pane bytes. Every other
// message is low-rate and rides JSON.
//
// [LAW:one-source-of-truth] Every frame shape, RPC method name, and error
// code lives here. Both sides of the bridge import from this file.
// [LAW:one-type-per-behavior] ClientFrame and ServerFrame are discriminated
// unions — a single `k` field dispatches every receiver.

import type { DeliveredRoute } from "../bridge-connection.js";
import type {
  CommandResponse,
  PaneOutputMessage,
  TmuxMessage,
  WindowLayoutFields,
} from "../../protocol/types.js";
import { SERIALIZED_EVENT_TYPES } from "../../protocol/types.js";
import { windowLayoutFields } from "../../protocol/layout.js";
import type { ChunkPayload } from "../../pane-output.js";

// [LAW:one-source-of-truth] Re-export the canonical PaneOutputMessage from
// the protocol types module. The websocket layer USES the type but does not
// own it — moving the definition home means the four connector consumers all
// reach the same name through a single declaration.
export type { PaneOutputMessage } from "../../protocol/types.js";

// ---------------------------------------------------------------------------
// Error taxonomy
//
// [LAW:one-source-of-truth] BridgeErrorCode + BridgeErrorPayload + BridgeError
// + BridgeProtocolError live in `../errors.ts` and are shared with the
// Electron connector. This module re-exports them so wire-protocol consumers
// keep one import site and `instanceof BridgeError` works irrespective of
// which transport produced the error. No parallel declarations exist here.
// ---------------------------------------------------------------------------

export {
  BridgeError,
  BridgeProtocolError,
  toBridgeProtocolError,
  type BridgeErrorCode,
  type BridgeErrorPayload,
} from "../errors.js";
import {
  BridgeProtocolError,
  type BridgeErrorCode,
  type BridgeErrorPayload,
} from "../errors.js";

// [LAW:one-source-of-truth] Every `WelcomeLimits` field is stamped by
// limits.ts; the types and their parsers are re-exported here because this is
// the public home of the frame they appear on. [LAW:composability] A consumer
// building a welcome (a custom server, a test's fake) needs the parser to
// produce the branded value; without it the only out is a cast.
import {
  durationMsParser,
  heartbeatIntervalParser,
  positiveIntParser,
  parseDurationMs,
  parseHeartbeatInterval,
  parsePositiveInt,
  type DurationMs,
  type HeartbeatInterval,
  type PositiveInt,
} from "./limits.js";
export {
  parseDurationMs,
  parseHeartbeatInterval,
  parsePositiveInt,
  type DurationMs,
  type HeartbeatInterval,
  type PositiveInt,
};

// [LAW:single-enforcer] The wire border runs the same parsers as the consumer
// border; only the error differs. A server that advertises a limit no timer or
// limiter honors is a non-conforming peer, reported as one — not a silently
// disabled heartbeat, a ping storm from the timer clamp, or a call deadline
// that fires before any reply.
const protocolError = (message: string): Error =>
  new BridgeProtocolError(message);
const wireDurationMs = durationMsParser(protocolError);
const wireHeartbeatInterval = heartbeatIntervalParser(protocolError);
const wirePositiveInt = positiveIntParser(protocolError);

// ---------------------------------------------------------------------------
// RPC methods
// ---------------------------------------------------------------------------

/**
 * Every TmuxClient method the bridge can proxy.
 *
 * [LAW:one-source-of-truth] Re-exported from `../rpc.ts` (the connector-
 * agnostic RPC layer). Adding a method = one variant on `RpcRequest` in
 * `rpc.ts` + one dispatcher arm in `rpc-dispatch.ts`. Both connectors pick
 * up the change automatically.
 */
export type { RpcMethod } from "../rpc.js";

import type { RpcMethod, RpcResponseMap } from "../rpc.js";

// ---------------------------------------------------------------------------
// Event messages (control plane)
//
// Pane output (`%output`, `%extended-output`) never rides a JSON event frame;
// it goes out as a binary frame. If a SerializedEventMessage with one of
// those types ever materializes, the sender has a bug.
// ---------------------------------------------------------------------------

export type SerializedEventMessage = Exclude<
  TmuxMessage,
  { type: "output" } | { type: "extended-output" }
>;

// ---------------------------------------------------------------------------
// Client → Server frames (JSON)
// ---------------------------------------------------------------------------

export interface HelloFrame {
  readonly k: "hello";
}

export interface CallFrame {
  readonly k: "call";
  readonly id: string;
  readonly method: RpcMethod;
  readonly args: readonly unknown[];
}

export interface PingFrame {
  readonly k: "ping";
  readonly id: string;
}

export interface ByeFrame {
  readonly k: "bye";
}

export type ClientFrame = HelloFrame | CallFrame | PingFrame | ByeFrame;

// ---------------------------------------------------------------------------
// Server → Client frames (JSON)
// ---------------------------------------------------------------------------

export interface WelcomeLimits {
  /** Max ms the server will wait for a tmux response per call. */
  readonly requestTimeoutMs: DurationMs;
  /** Interval at which the server will ping; `0` when its heartbeat is off. */
  readonly heartbeatIntervalMs: HeartbeatInterval;
  /** Max in-flight calls permitted per connection. */
  readonly maxInflight: PositiveInt;
}

export interface WelcomeFrame {
  readonly k: "welcome";
  readonly limits: WelcomeLimits;
}

export interface EventFrame {
  readonly k: "event";
  // [LAW:one-source-of-truth] Exactly what the bridge delivers to a WS peer:
  // tmux's messages, the reply-stream reports, and cross-session layout.
  readonly msg: DeliveredRoute<false>["msg"];
}

/** The synthetic events an event frame carries beside tmux's own messages. */
export type WireSyntheticMessage = Exclude<
  EventFrame["msg"],
  SerializedEventMessage
>;

export interface ResultOkFrame {
  readonly k: "result";
  readonly id: string;
  readonly ok: true;
  // RpcResponseMap[RpcMethod]: a CommandResponse for most methods, but the
  // structured records for listWindows/listPanes/listSessions (see rpc.ts).
  readonly response: RpcResponseMap[RpcMethod];
}

export interface ResultErrFrame {
  readonly k: "result";
  readonly id: string;
  readonly ok: false;
  readonly error: BridgeErrorPayload;
}

// A tmux `%error` reply: the call reached tmux and tmux refused it. Distinct
// from ResultErrFrame (the bridge itself failed) so the client can rethrow it
// as a TmuxCommandError, as the Electron renderer and a direct TmuxClient do.
export interface ResultTmuxErrorFrame {
  readonly k: "result";
  readonly id: string;
  readonly ok: false;
  readonly tmuxError: CommandResponse;
}

export type ResultFrame = ResultOkFrame | ResultErrFrame | ResultTmuxErrorFrame;

export interface PongFrame {
  readonly k: "pong";
  readonly id: string;
}

export interface DrainingFrame {
  readonly k: "draining";
  /** Absolute ms-since-epoch deadline for existing calls to finish. */
  readonly deadlineMs: number;
}

export interface FatalErrorFrame {
  readonly k: "error";
  readonly fatal: true;
  readonly error: BridgeErrorPayload;
}

export type ServerFrame =
  | WelcomeFrame
  | EventFrame
  | ResultFrame
  | PongFrame
  | DrainingFrame
  | FatalErrorFrame;

// ---------------------------------------------------------------------------
// Binary frame: pane output
//
// Layout (network / big-endian byte order):
//
//   byte 0:        magic (0x7F)
//   byte 1:        flags
//                    bit 0: extended   — when set, age field is present
//                    bit 1..7: reserved, must be zero
//   bytes 2-5:     paneId  (uint32 BE)
//   bytes 6-9:     age     (uint32 BE, only when extended flag set)
//   remaining:     pane bytes verbatim (no encoding, no framing)
//
// [LAW:one-source-of-truth] encodePaneOutput and decodePaneOutput are the
// only functions that know this layout. Anything that ever peeks at the first
// byte of a binary frame goes through `isPaneOutputFrame`.
// ---------------------------------------------------------------------------

/** Magic byte identifying a pane-output binary frame. */
export const PANE_OUTPUT_MAGIC = 0x7f;

const FLAG_EXTENDED = 0x01;

const HEADER_BASE = 6;
const HEADER_EXTENDED = 10;

export function isPaneOutputFrame(buf: Uint8Array): boolean {
  return buf.length > 0 && buf[0] === PANE_OUTPUT_MAGIC;
}

// [LAW:types-are-the-program] ChunkPayload strips the wire discriminator
// fields (type, age) before dispatch — the wire frame always uses the base
// (non-extended) layout. The browser-side decoder still supports extended
// frames for forward compatibility; the server never emits them from sinks.
export function encodePaneOutput(msg: ChunkPayload): Uint8Array {
  const out = new Uint8Array(HEADER_BASE + msg.data.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[0] = PANE_OUTPUT_MAGIC;
  out[1] = 0;
  view.setUint32(2, msg.paneId, false);
  out.set(msg.data, HEADER_BASE);
  return out;
}

export function decodePaneOutput(buf: Uint8Array): PaneOutputMessage {
  if (buf.length < HEADER_BASE) {
    throw new BridgeProtocolError(
      `pane-output frame truncated: got ${buf.length} bytes, need >=${HEADER_BASE}`,
    );
  }
  if (buf[0] !== PANE_OUTPUT_MAGIC) {
    throw new BridgeProtocolError(
      `pane-output frame has wrong magic byte 0x${buf[0]
        .toString(16)
        .padStart(2, "0")}`,
    );
  }
  const flags = buf[1];
  if ((flags & ~FLAG_EXTENDED) !== 0) {
    throw new BridgeProtocolError(
      `pane-output frame has unknown flag bits set: 0x${flags
        .toString(16)
        .padStart(2, "0")}`,
    );
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const paneId = view.getUint32(2, false);
  const extended = (flags & FLAG_EXTENDED) !== 0;
  if (!extended) {
    return { type: "output", paneId, data: buf.slice(HEADER_BASE) };
  }
  if (buf.length < HEADER_EXTENDED) {
    throw new BridgeProtocolError(
      `extended pane-output frame truncated: got ${buf.length} bytes, need >=${HEADER_EXTENDED}`,
    );
  }
  const age = view.getUint32(6, false);
  return {
    type: "extended-output",
    paneId,
    age,
    data: buf.slice(HEADER_EXTENDED),
  };
}

// ---------------------------------------------------------------------------
// Parsing helpers
//
// Wire → typed. These functions do ALL validation for the bridge. Downstream
// code operates on parsed types and never re-checks wire shape.
//
// [LAW:dataflow-not-control-flow] The parsers are an indexed lookup over the
// frame discriminator — same shape as VALIDATORS in ../rpc.ts. The mapped
// type forces one entry per union variant; `satisfies` makes drift between
// the union and the parser table a compile-time error.
// [LAW:single-enforcer] parseClientFrame / parseServerFrame are the only
// validation sites for inbound frames. Downstream operates on typed unions.
// ---------------------------------------------------------------------------

type FrameParserTable<F extends { readonly k: string }> = {
  readonly [K in F["k"]]: (raw: object) => Extract<F, { k: K }>;
};

const CLIENT_FRAME_PARSERS: FrameParserTable<ClientFrame> = Object.assign(
  Object.create(null) as FrameParserTable<ClientFrame>,
  {
    hello: parseHello,
    call: parseCall,
    ping: parsePing,
    bye: () => ({ k: "bye" }) as const,
  } satisfies FrameParserTable<ClientFrame>,
);

const SERVER_FRAME_PARSERS: FrameParserTable<ServerFrame> = Object.assign(
  Object.create(null) as FrameParserTable<ServerFrame>,
  {
    welcome: parseWelcome,
    event: parseEvent,
    result: parseResult,
    pong: parsePong,
    draining: parseDraining,
    error: parseFatal,
  } satisfies FrameParserTable<ServerFrame>,
);

export function parseClientFrame(raw: string): ClientFrame {
  return parseFrame(raw, CLIENT_FRAME_PARSERS, "client");
}

export function parseServerFrame(raw: string): ServerFrame {
  return parseFrame(raw, SERVER_FRAME_PARSERS, "server");
}

function parseFrame<F extends { readonly k: string }>(
  raw: string,
  parsers: FrameParserTable<F>,
  side: "client" | "server",
): F {
  const parsed = safeJsonParse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BridgeProtocolError("frame must be a JSON object");
  }
  const k = (parsed as { k: unknown }).k as F["k"];
  const fn = parsers[k];
  if (fn === undefined) {
    throw new BridgeProtocolError(`unknown ${side} frame kind: ${String(k)}`);
  }
  return fn(parsed as object);
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new BridgeProtocolError(
      `invalid JSON frame: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parseHello(_x: unknown): HelloFrame {
  return { k: "hello" };
}

function parseCall(x: unknown): CallFrame {
  const o = x as {
    id?: unknown;
    method?: unknown;
    args?: unknown;
  };
  if (typeof o.id !== "string" || o.id.length === 0) {
    throw new BridgeProtocolError("call.id must be a non-empty string");
  }
  if (typeof o.method !== "string") {
    throw new BridgeProtocolError("call.method must be a string");
  }
  if (!Array.isArray(o.args)) {
    throw new BridgeProtocolError("call.args must be an array");
  }
  // The method-name allowlist is enforced by parseRpcRequest in server.ts —
  // it raises a per-call BRIDGE_UNKNOWN_METHOD reply (connection stays open).
  // Validating here would close the connection on every unknown method,
  // which over-reacts to client/server version skew.
  return {
    k: "call",
    id: o.id,
    method: o.method as RpcMethod,
    args: o.args,
  };
}

function parsePing(x: unknown): PingFrame {
  const o = x as { id?: unknown };
  if (typeof o.id !== "string" || o.id.length === 0) {
    throw new BridgeProtocolError("ping.id must be a non-empty string");
  }
  return { k: "ping", id: o.id };
}

function parseWelcome(x: unknown): WelcomeFrame {
  const o = x as { limits?: unknown };
  if (typeof o.limits !== "object" || o.limits === null) {
    throw new BridgeProtocolError("welcome.limits missing or malformed");
  }
  const l = o.limits as Record<keyof WelcomeLimits, unknown>;
  // [LAW:parse-dont-validate] The wire border stamps the limits the client
  // will run its own timers at; a value outside a field's shape (including a
  // non-number) names the field, the value, and the shape.
  return {
    k: "welcome",
    limits: {
      requestTimeoutMs: wireDurationMs(
        "welcome.limits.requestTimeoutMs",
        l.requestTimeoutMs,
      ),
      heartbeatIntervalMs: wireHeartbeatInterval(
        "welcome.limits.heartbeatIntervalMs",
        l.heartbeatIntervalMs,
      ),
      maxInflight: wirePositiveInt("welcome.limits.maxInflight", l.maxInflight),
    },
  };
}

function wireValue<T>(
  value: unknown,
  is: (v: unknown) => v is T,
  path: string,
  shape: string,
): T {
  if (!is(value)) throw new BridgeProtocolError(`${path} must be ${shape}`);
  return value;
}

const isNumber = (v: unknown): v is number => typeof v === "number";
const isString = (v: unknown): v is string => typeof v === "string";
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNumberArray = (v: unknown): v is readonly number[] =>
  Array.isArray(v) && v.every(isNumber);
const isStringArray = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every(isString);

// [LAW:types-are-the-program] Each wire object's fields and their runtime
// kinds. The mapped type makes a field added to (or removed from) a message
// interface a compile error in its table, so the wire check cannot drift from
// the type the client emits. Layout fields are excluded: every event that
// carries them goes through `withDerivedLayout` instead.
type FieldKind =
  | "number"
  | "number[]"
  | "string"
  | "string[]"
  | "boolean"
  | "CommandResponse";
// A field shape with no kind here (an optional field included) is `never`, so
// it fails to compile rather than being checked as the wrong kind.
type FieldKinds<M> = {
  readonly [F in Exclude<
    keyof M,
    "type" | keyof WindowLayoutFields
  >]: M[F] extends number
    ? "number"
    : M[F] extends readonly number[]
      ? "number[]"
      : M[F] extends readonly string[]
        ? "string[]"
        : M[F] extends string
          ? "string"
          : M[F] extends boolean
            ? "boolean"
            : M[F] extends CommandResponse
              ? "CommandResponse"
              : never;
};

const COMMAND_RESPONSE_FIELDS: FieldKinds<CommandResponse> = {
  commandNumber: "number",
  timestamp: "number",
  output: "string[]",
  success: "boolean",
};

// [LAW:single-enforcer] The one wire parser for a field table: an event's
// synthetic fields and a tmux reply, wherever a frame carries one.
function parseFields(
  x: unknown,
  kinds: Readonly<Record<string, FieldKind>>,
  path: string,
): Record<string, unknown> {
  const o = wireValue(x, isObject, path, "an object");
  const parsed: Record<string, unknown> = { ...o };
  for (const [field, kind] of Object.entries(kinds)) {
    parsed[field] = FIELD_PARSERS[kind](o[field], `${path}.${field}`);
  }
  return parsed;
}

function parseCommandResponse(x: unknown, path: string): CommandResponse {
  // [LAW:types-are-the-program] exception: the table is
  // `FieldKinds<CommandResponse>`, so every field was just parsed, but TS
  // cannot carry that through `parseFields`.
  return parseFields(
    x,
    COMMAND_RESPONSE_FIELDS,
    path,
  ) as unknown as CommandResponse;
}

// [LAW:one-source-of-truth] Keyed by exactly the synthetic events the bridge
// delivers to a WS peer, so this table is also what `parseEvent` admits.
const SYNTHETIC_WIRE_FIELDS: {
  readonly [K in WireSyntheticMessage["type"]]: FieldKinds<
    Extract<WireSyntheticMessage, { type: K }>
  >;
} = {
  "protocol-error": { commandNumber: "number", line: "string" },
  "unsolicited-response": { response: "CommandResponse" },
  "cross-session-layout-change": { sessionId: "number", windowId: "number" },
  "cross-session-layout-decode-error": { skippedBytes: "number" },
  "cross-session-layout-overrun": { lostEntries: "number" },
  "cross-session-layout-fetch-failed": { windowId: "number", reason: "string" },
  "cross-session-layout-hook-restored": {},
  "cross-session-layout-repair-failed": { reason: "string" },
  "cross-session-layout-uncovered": { windowIds: "number[]" },
};

const FIELD_PARSERS: Readonly<
  Record<FieldKind, (value: unknown, path: string) => unknown>
> = {
  number: (v, path) => wireValue(v, isNumber, path, "a number"),
  string: (v, path) => wireValue(v, isString, path, "a string"),
  "number[]": (v, path) => wireValue(v, isNumberArray, path, "a number[]"),
  "string[]": (v, path) => wireValue(v, isStringArray, path, "a string[]"),
  boolean: (v, path) => wireValue(v, isBoolean, path, "a boolean"),
  CommandResponse: parseCommandResponse,
};

function isWireSyntheticType(
  type: string,
): type is WireSyntheticMessage["type"] {
  return Object.hasOwn(SYNTHETIC_WIRE_FIELDS, type);
}

// [LAW:types-are-the-program] Keyed by every message type that carries
// WindowLayoutFields, so a new one is a compile error until it is listed.
const LAYOUT_EVENT_TYPES: ReadonlySet<string> = new Set(
  Object.keys({
    "layout-change": true,
    "cross-session-layout-change": true,
  } satisfies Record<
    Extract<EventFrame["msg"], WindowLayoutFields>["type"],
    true
  >),
);

const RAW_LAYOUT_FIELDS = [
  "windowLayout",
  "windowVisibleLayout",
  "windowFlags",
] as const satisfies readonly (keyof WindowLayoutFields)[];

// [LAW:one-source-of-truth] Geometry is never taken off the wire: the raw
// layout strings are checked and `windowLayoutFields` re-derives `layout` and
// `visibleLayout`, so a bridge on another version cannot hand the browser
// geometry that disagrees with its own strings.
function withDerivedLayout(msg: Record<string, unknown>, type: string): object {
  if (!LAYOUT_EVENT_TYPES.has(type)) return msg;
  const [layout, visibleLayout, flags] = RAW_LAYOUT_FIELDS.map((field) =>
    wireValue(msg[field], isString, `event.msg(${type}).${field}`, "a string"),
  );
  return { ...msg, ...windowLayoutFields(layout, visibleLayout, flags) };
}

function parseEvent(x: unknown): EventFrame {
  const raw = wireValue(
    (x as { msg?: unknown }).msg,
    isObject,
    "event.msg",
    "an object",
  );
  const { type } = raw;
  const unknownType = () =>
    new BridgeProtocolError(
      `event.msg.type must be a known TmuxMessage discriminator or a synthetic event type the bridge delivers, got ${JSON.stringify(type)}`,
    );
  if (typeof type !== "string") throw unknownType();
  // Classify once: admission and the field check read the same verdict.
  let msg = raw;
  if (isWireSyntheticType(type)) {
    // Several synthetic types share field names, so the path names the type.
    msg = parseFields(raw, SYNTHETIC_WIRE_FIELDS[type], `event.msg(${type})`);
  } else if (!SERIALIZED_EVENT_TYPES.has(type)) {
    throw unknownType();
  }
  return {
    k: "event",
    msg: withDerivedLayout(msg, type) as EventFrame["msg"],
  };
}

function parseResult(x: unknown): ResultFrame {
  const o = x as {
    id?: unknown;
    ok?: unknown;
    response?: unknown;
    error?: unknown;
    tmuxError?: unknown;
  };
  if (typeof o.id !== "string" || o.id.length === 0) {
    throw new BridgeProtocolError("result.id must be a non-empty string");
  }
  if (o.ok === true) {
    // `null` is legal only for the methods whose RpcSpec response is null;
    // the outbox, which knows each call's method, enforces that pairing.
    if (typeof o.response !== "object") {
      throw new BridgeProtocolError(
        "result.response must be an object or null",
      );
    }
    return {
      k: "result",
      id: o.id,
      ok: true,
      response: o.response as RpcResponseMap[RpcMethod],
    };
  }
  if (o.ok === false && "tmuxError" in o) {
    return {
      k: "result",
      id: o.id,
      ok: false,
      tmuxError: parseCommandResponse(o.tmuxError, "result.tmuxError"),
    };
  }
  if (o.ok === false) {
    return {
      k: "result",
      id: o.id,
      ok: false,
      error: parseErrorPayload(o.error),
    };
  }
  throw new BridgeProtocolError("result.ok must be a boolean");
}

function parsePong(x: unknown): PongFrame {
  const o = x as { id?: unknown };
  if (typeof o.id !== "string" || o.id.length === 0) {
    throw new BridgeProtocolError("pong.id must be a non-empty string");
  }
  return { k: "pong", id: o.id };
}

function parseDraining(x: unknown): DrainingFrame {
  const o = x as { deadlineMs?: unknown };
  if (typeof o.deadlineMs !== "number") {
    throw new BridgeProtocolError("draining.deadlineMs must be a number");
  }
  return { k: "draining", deadlineMs: o.deadlineMs };
}

function parseFatal(x: unknown): FatalErrorFrame {
  const o = x as { fatal?: unknown; error?: unknown };
  if (o.fatal !== true) {
    throw new BridgeProtocolError("error.fatal must be true");
  }
  return { k: "error", fatal: true, error: parseErrorPayload(o.error) };
}

function parseErrorPayload(x: unknown): BridgeErrorPayload {
  if (typeof x !== "object" || x === null) {
    throw new BridgeProtocolError("error payload must be an object");
  }
  const o = x as { code?: unknown; message?: unknown };
  if (typeof o.code !== "string") {
    throw new BridgeProtocolError("error.code must be a string");
  }
  if (typeof o.message !== "string") {
    throw new BridgeProtocolError("error.message must be a string");
  }
  return { code: o.code as BridgeErrorCode, message: o.message };
}

// ---------------------------------------------------------------------------
// Encoding helpers (typed → wire)
// ---------------------------------------------------------------------------

export function encodeServerFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}

export function encodeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}
