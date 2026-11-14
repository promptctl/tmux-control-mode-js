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
  PaneRecord,
  ProtocolErrorMessage,
  SessionRecord,
  TmuxMessage,
  WindowLayoutFields,
  WindowRecord,
} from "../../protocol/types.js";
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
  isBridgeErrorCode,
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

/**
 * A result as `parseServerFrame` reads it: the id of the call it answers, the
 * rest unread. Which method it answers is not on the frame, so the holder of
 * the call parses `raw` with `parseResultFrame`, and a malformed result still
 * settles the call it answers.
 */
export interface ReceivedResultFrame {
  readonly k: "result";
  readonly id: string;
  readonly raw: unknown;
}

export type ReceivedServerFrame =
  | Exclude<ServerFrame, ResultFrame>
  | ReceivedResultFrame;

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
// type forces one entry per union variant, so drift between the union and
// the parser table is a compile-time error.
// [LAW:single-enforcer] parseClientFrame / parseServerFrame are the only
// validation sites for inbound frames, and `wireObject` is the one way any of
// them reads a field. Downstream operates on typed unions.
// ---------------------------------------------------------------------------

type FrameParserTable<F extends { readonly k: string }> = {
  readonly [K in F["k"]]: (raw: unknown) => Extract<F, { k: K }>;
};

const CLIENT_FRAME_PARSERS: FrameParserTable<ClientFrame> = {
  hello: () => ({ k: "hello" }),
  call: parseCall,
  ping: parsePing,
  bye: () => ({ k: "bye" }),
};

const SERVER_FRAME_PARSERS: FrameParserTable<ReceivedServerFrame> = {
  welcome: parseWelcome,
  event: parseEvent,
  result: parseReceivedResult,
  pong: parsePong,
  draining: parseDraining,
  error: parseFatal,
};

export function parseClientFrame(raw: string): ClientFrame {
  return parseFrame(raw, CLIENT_FRAME_PARSERS, "client");
}

export function parseServerFrame(raw: string): ReceivedServerFrame {
  return parseFrame(raw, SERVER_FRAME_PARSERS, "server");
}

function parseFrame<F extends { readonly k: string }>(
  raw: string,
  parsers: FrameParserTable<F>,
  side: "client" | "server",
): F {
  const frame = safeJsonParse(raw);
  const k = wireObject<F>(frame, "frame").value("k");
  if (!isKeyOf(parsers, k)) {
    throw new BridgeProtocolError(`unknown ${side} frame kind: ${String(k)}`);
  }
  return parsers[k](frame);
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

// An own key only, so a peer's `k: "constructor"` names no parser.
function isKeyOf<T extends object>(table: T, key: unknown): key is keyof T {
  return typeof key === "string" && Object.hasOwn(table, key);
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
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A runtime check and the words its failure names the shape with. */
interface WireKind<T> {
  readonly is: (v: unknown) => v is T;
  readonly shape: string;
}

const NUMBER: WireKind<number> = { is: isNumber, shape: "a number" };
const STRING: WireKind<string> = { is: isString, shape: "a string" };
const NON_EMPTY_STRING: WireKind<string> = {
  is: (v): v is string => isString(v) && v.length > 0,
  shape: "a non-empty string",
};
const BOOLEAN: WireKind<boolean> = {
  is: (v): v is boolean => typeof v === "boolean",
  shape: "a boolean",
};
const TRUE: WireKind<true> = {
  is: (v): v is true => v === true,
  shape: "true",
};
const NUMBERS: WireKind<readonly number[]> = {
  is: (v): v is readonly number[] => Array.isArray(v) && v.every(isNumber),
  shape: "a number[]",
};
const STRINGS: WireKind<readonly string[]> = {
  is: (v): v is readonly string[] => Array.isArray(v) && v.every(isString),
  shape: "a string[]",
};
const ARRAY: WireKind<readonly unknown[]> = {
  is: (v): v is readonly unknown[] => Array.isArray(v),
  shape: "an array",
};
const NULL: WireKind<null> = {
  is: (v): v is null => v === null,
  shape: "null",
};
// [LAW:one-source-of-truth] `satisfies Record` makes a kind added to (or
// removed from) `ProtocolErrorMessage` a compile error until it is listed here.
const PROTOCOL_ERROR_KINDS = {
  terminator: true,
  begin: true,
  line: true,
} as const satisfies Record<ProtocolErrorMessage["kind"], true>;
const PROTOCOL_ERROR_KIND: WireKind<ProtocolErrorMessage["kind"]> = {
  is: (v): v is ProtocolErrorMessage["kind"] =>
    isString(v) && Object.hasOwn(PROTOCOL_ERROR_KINDS, v),
  shape: `one of ${Object.keys(PROTOCOL_ERROR_KINDS).join(", ")}`,
};
const BRIDGE_ERROR_CODE: WireKind<BridgeErrorCode> = {
  is: isBridgeErrorCode,
  shape: "a BridgeErrorCode",
};

/**
 * A wire object that is known to be an object, read field by field as the
 * type `M` it is parsed into. `read` is keyed by `M`, so a builder names only
 * fields `M` has and checks each against the kind `M` declares for it; a
 * failure names the field's path.
 */
interface WireObject<M> {
  read<F extends keyof M & string>(field: F, kind: WireKind<M[F]>): M[F];
  optional<F extends keyof M & string>(
    field: F,
    kind: WireKind<Exclude<M[F], undefined>>,
  ): M[F] | undefined;
  object<F extends keyof M & string>(field: F): WireObject<M[F]>;
  /** The field unread, for a parser that reads it as another shape. */
  value(field: keyof M & string): unknown;
  /**
   * The same object read as `V`, the member of the union `M` that a
   * discriminant already read from it chose, so the fields only `V` has can
   * be read. Every field is still checked as it is read.
   */
  variant<V extends M>(): WireObject<V>;
}

function wireObject<M>(x: unknown, path: string): WireObject<M> {
  return wireFields(wireValue(x, isObject, path, "an object"), path);
}

function wireFields<M>(
  o: Record<string, unknown>,
  path: string,
): WireObject<M> {
  const at = (field: string): string => `${path}.${field}`;
  return {
    read: (field, kind) => wireValue(o[field], kind.is, at(field), kind.shape),
    optional: (field, kind) =>
      o[field] === undefined
        ? undefined
        : wireValue(o[field], kind.is, at(field), kind.shape),
    object: (field) => wireObject(o[field], at(field)),
    value: (field) => o[field],
    variant: () => wireFields(o, path),
  };
}

// [LAW:types-are-the-program] A builder's return is checked against this, so
// an optional field it leaves out is a compile error, not a field dropped at
// the wire.
type Complete<T> = { [K in keyof Required<T>]: T[K] };

function wireArray<T>(
  x: unknown,
  path: string,
  item: (x: unknown, path: string) => T,
): readonly T[] {
  return wireValue(x, ARRAY.is, path, ARRAY.shape).map((v, i) =>
    item(v, `${path}[${i}]`),
  );
}

// A call as the wire carries it: `method` is any string until
// parseRpcRequest checks it against the allowlist.
type WireCall = Omit<CallFrame, "method"> & { readonly method: string };

function parseCall(x: unknown): CallFrame {
  const m = wireObject<WireCall>(x, "call");
  const method = m.read("method", STRING);
  return {
    k: "call",
    id: m.read("id", NON_EMPTY_STRING),
    // [LAW:types-are-the-program] exception: parseRpcRequest in server.ts owns
    // the method allowlist and answers an unknown method per call
    // (BRIDGE_UNKNOWN_METHOD, connection stays open); refusing it here would
    // close the connection on client/server version skew.
    method: method as RpcMethod,
    args: m.read("args", ARRAY),
  };
}

function parsePing(x: unknown): PingFrame {
  return {
    k: "ping",
    id: wireObject<PingFrame>(x, "ping").read("id", NON_EMPTY_STRING),
  };
}

function parseWelcome(x: unknown): WelcomeFrame {
  const l = wireObject<WelcomeFrame>(x, "welcome").object("limits");
  // [LAW:parse-dont-validate] The wire border stamps the limits the client
  // will run its own timers at; a value outside a field's shape (including a
  // non-number) names the field, the value, and the shape.
  return {
    k: "welcome",
    limits: {
      requestTimeoutMs: wireDurationMs(
        "welcome.limits.requestTimeoutMs",
        l.value("requestTimeoutMs"),
      ),
      heartbeatIntervalMs: wireHeartbeatInterval(
        "welcome.limits.heartbeatIntervalMs",
        l.value("heartbeatIntervalMs"),
      ),
      maxInflight: wirePositiveInt(
        "welcome.limits.maxInflight",
        l.value("maxInflight"),
      ),
    },
  };
}

function parseCommandResponse(m: WireObject<CommandResponse>): CommandResponse {
  return {
    commandNumber: m.read("commandNumber", NUMBER),
    timestamp: m.read("timestamp", NUMBER),
    output: m.read("output", STRINGS),
    success: m.read("success", BOOLEAN),
  };
}

// [LAW:one-source-of-truth] Geometry is never taken off the wire: the raw
// layout strings are read and `windowLayoutFields` re-derives `layout` and
// `visibleLayout`, so a bridge on another version cannot hand the browser
// geometry that disagrees with its own strings.
function parseLayoutFields(
  m: WireObject<WindowLayoutFields>,
): WindowLayoutFields {
  return windowLayoutFields(
    m.read("windowLayout", STRING),
    m.read("windowVisibleLayout", STRING),
    m.read("windowFlags", STRING),
  );
}

type EventMessage = EventFrame["msg"];
type EventOf<K extends EventMessage["type"]> = Extract<
  EventMessage,
  { type: K }
>;

// [LAW:one-source-of-truth] Keyed by exactly the messages an event frame
// carries, so this table is also what `parseEvent` admits. Each builder
// returns a literal the compiler checks against its message type: a parsed
// message holds every declared field and nothing else.
const EVENT_MESSAGE_PARSERS: {
  readonly [K in EventMessage["type"]]: (
    m: WireObject<EventOf<K>>,
  ) => EventOf<K>;
} = {
  begin: (m) => ({
    type: "begin",
    timestamp: m.read("timestamp", NUMBER),
    commandNumber: m.read("commandNumber", NUMBER),
    flags: m.read("flags", NUMBER),
  }),
  end: (m) => ({
    type: "end",
    timestamp: m.read("timestamp", NUMBER),
    commandNumber: m.read("commandNumber", NUMBER),
    flags: m.read("flags", NUMBER),
  }),
  error: (m) => ({
    type: "error",
    timestamp: m.read("timestamp", NUMBER),
    commandNumber: m.read("commandNumber", NUMBER),
    flags: m.read("flags", NUMBER),
  }),
  pause: (m) => ({ type: "pause", paneId: m.read("paneId", NUMBER) }),
  continue: (m) => ({ type: "continue", paneId: m.read("paneId", NUMBER) }),
  "pane-mode-changed": (m) => ({
    type: "pane-mode-changed",
    paneId: m.read("paneId", NUMBER),
  }),
  "window-add": (m) => ({
    type: "window-add",
    windowId: m.read("windowId", NUMBER),
  }),
  "window-close": (m) => ({
    type: "window-close",
    windowId: m.read("windowId", NUMBER),
  }),
  "window-renamed": (m) => ({
    type: "window-renamed",
    windowId: m.read("windowId", NUMBER),
    name: m.read("name", STRING),
  }),
  "window-pane-changed": (m) => ({
    type: "window-pane-changed",
    windowId: m.read("windowId", NUMBER),
    paneId: m.read("paneId", NUMBER),
  }),
  "unlinked-window-add": (m) => ({
    type: "unlinked-window-add",
    windowId: m.read("windowId", NUMBER),
  }),
  "unlinked-window-close": (m) => ({
    type: "unlinked-window-close",
    windowId: m.read("windowId", NUMBER),
  }),
  "unlinked-window-renamed": (m) => ({
    type: "unlinked-window-renamed",
    windowId: m.read("windowId", NUMBER),
    name: m.read("name", STRING),
  }),
  "layout-change": (m) => ({
    type: "layout-change",
    windowId: m.read("windowId", NUMBER),
    ...parseLayoutFields(m),
  }),
  "session-changed": (m) => ({
    type: "session-changed",
    sessionId: m.read("sessionId", NUMBER),
    name: m.read("name", STRING),
  }),
  "session-renamed": (m) => ({
    type: "session-renamed",
    sessionId: m.read("sessionId", NUMBER),
    name: m.read("name", STRING),
  }),
  "sessions-changed": () => ({ type: "sessions-changed" }),
  "session-window-changed": (m) => ({
    type: "session-window-changed",
    sessionId: m.read("sessionId", NUMBER),
    windowId: m.read("windowId", NUMBER),
  }),
  "client-session-changed": (m) => ({
    type: "client-session-changed",
    clientName: m.read("clientName", STRING),
    sessionId: m.read("sessionId", NUMBER),
    name: m.read("name", STRING),
  }),
  "client-detached": (m) => ({
    type: "client-detached",
    clientName: m.read("clientName", STRING),
  }),
  "paste-buffer-changed": (m) => ({
    type: "paste-buffer-changed",
    name: m.read("name", STRING),
  }),
  "paste-buffer-deleted": (m) => ({
    type: "paste-buffer-deleted",
    name: m.read("name", STRING),
  }),
  "subscription-changed": (m) => ({
    type: "subscription-changed",
    name: m.read("name", STRING),
    sessionId: m.read("sessionId", NUMBER),
    windowId: m.read("windowId", NUMBER),
    windowIndex: m.read("windowIndex", NUMBER),
    paneId: m.read("paneId", NUMBER),
    value: m.read("value", STRING),
  }),
  message: (m) => ({ type: "message", message: m.read("message", STRING) }),
  "config-error": (m) => ({
    type: "config-error",
    error: m.read("error", STRING),
  }),
  exit: (m) => ({ type: "exit", reason: m.optional("reason", STRING) }),
  "protocol-error": (m) => {
    const kind = m.read("kind", PROTOCOL_ERROR_KIND);
    const line = m.read("line", STRING);
    return kind === "terminator"
      ? {
          type: "protocol-error",
          kind,
          commandNumber: m
            .variant<Extract<ProtocolErrorMessage, { kind: "terminator" }>>()
            .read("commandNumber", NUMBER),
          line,
        }
      : { type: "protocol-error", kind, line };
  },
  "unsolicited-response": (m) => ({
    type: "unsolicited-response",
    response: parseCommandResponse(m.object("response")),
  }),
  "cross-session-layout-change": (m) => ({
    type: "cross-session-layout-change",
    sessionId: m.read("sessionId", NUMBER),
    windowId: m.read("windowId", NUMBER),
    ...parseLayoutFields(m),
  }),
  "cross-session-layout-decode-error": (m) => ({
    type: "cross-session-layout-decode-error",
    skippedBytes: m.read("skippedBytes", NUMBER),
  }),
  "cross-session-layout-overrun": (m) => ({
    type: "cross-session-layout-overrun",
    lostEntries: m.read("lostEntries", NUMBER),
  }),
  "cross-session-layout-fetch-failed": (m) => ({
    type: "cross-session-layout-fetch-failed",
    windowId: m.read("windowId", NUMBER),
    reason: m.read("reason", STRING),
  }),
  "cross-session-layout-hook-restored": () => ({
    type: "cross-session-layout-hook-restored",
  }),
  "cross-session-layout-repair-failed": (m) => ({
    type: "cross-session-layout-repair-failed",
    reason: m.read("reason", STRING),
  }),
  "cross-session-layout-uncovered": (m) => ({
    type: "cross-session-layout-uncovered",
    windowIds: m.read("windowIds", NUMBERS),
  }),
} satisfies {
  readonly [K in EventMessage["type"]]: (
    m: WireObject<EventOf<K>>,
  ) => Complete<EventOf<K>>;
};

function parseEventMessage<K extends EventMessage["type"]>(
  type: K,
  m: WireObject<EventOf<K>>,
): EventOf<K> {
  return EVENT_MESSAGE_PARSERS[type](m);
}

function parseEvent(x: unknown): EventFrame {
  const msg = wireValue(
    wireObject<EventFrame>(x, "event").value("msg"),
    isObject,
    "event.msg",
    "an object",
  );
  const { type } = msg;
  if (!isKeyOf(EVENT_MESSAGE_PARSERS, type)) {
    throw new BridgeProtocolError(
      `event.msg.type must be a known TmuxMessage discriminator or a synthetic event type the bridge delivers, got ${JSON.stringify(type)}`,
    );
  }
  // Several types share field names, so the path names the type.
  return {
    k: "event",
    msg: parseEventMessage(type, wireFields(msg, `event.msg(${type})`)),
  };
}

const records =
  <T>(parse: (m: WireObject<T>) => Complete<T>) =>
  (x: unknown, path: string): readonly T[] =>
    wireArray(x, path, (item, at) => parse(wireObject<T>(item, at)));

const commandResponse = (x: unknown, path: string): CommandResponse =>
  parseCommandResponse(wireObject(x, path));
const nullResponse = (x: unknown, path: string): null =>
  wireValue(x, NULL.is, path, NULL.shape);

// [LAW:one-source-of-truth] Keyed by RpcMethod, each entry the shape RpcSpec
// declares for that method's response, null included.
const RESPONSE_PARSERS: {
  readonly [M in RpcMethod]: (x: unknown, path: string) => RpcResponseMap[M];
} = {
  execute: commandResponse,
  listWindows: records<WindowRecord>((m) => ({
    sessionId: m.read("sessionId", NUMBER),
    sessionName: m.read("sessionName", STRING),
    windowId: m.read("windowId", NUMBER),
    windowName: m.read("windowName", STRING),
    width: m.read("width", NUMBER),
    height: m.read("height", NUMBER),
  })),
  listPanes: records<PaneRecord>((m) => ({
    sessionId: m.read("sessionId", NUMBER),
    sessionName: m.read("sessionName", STRING),
    windowId: m.read("windowId", NUMBER),
    windowName: m.read("windowName", STRING),
    paneId: m.read("paneId", NUMBER),
    cwd: m.read("cwd", STRING),
    pid: m.read("pid", NUMBER),
    startCommand: m.read("startCommand", STRING),
    currentCommand: m.read("currentCommand", STRING),
    width: m.read("width", NUMBER),
    height: m.read("height", NUMBER),
  })),
  listSessions: records<SessionRecord>((m) => ({
    sessionId: m.read("sessionId", NUMBER),
    sessionName: m.read("sessionName", STRING),
    windowCount: m.read("windowCount", NUMBER),
    attached: m.read("attached", BOOLEAN),
  })),
  sendKeys: commandResponse,
  splitWindow: commandResponse,
  setSize: commandResponse,
  setPaneAction: commandResponse,
  subscribeRaw: commandResponse,
  unsubscribe: commandResponse,
  setFlags: commandResponse,
  clearFlags: commandResponse,
  requestReport: commandResponse,
  queryClipboard: commandResponse,
  enableCrossSessionLayoutChange: nullResponse,
  disableCrossSessionLayoutChange: nullResponse,
};

function parseReceivedResult(x: unknown): ReceivedResultFrame {
  return {
    k: "result",
    id: wireObject<ResultFrame>(x, "result").read("id", NON_EMPTY_STRING),
    raw: x,
  };
}

/**
 * Parse a received result as the answer to a call of `method`: an ok
 * `response` as the shape `method` answers with, or the failure the bridge or
 * tmux reported. Throws `BridgeProtocolError` naming the field.
 */
export function parseResultFrame(method: RpcMethod, x: unknown): ResultFrame {
  const path = `result(${method})`;
  const m = wireObject<WireResult>(x, path);
  const id = m.read("id", NON_EMPTY_STRING);
  if (m.read("ok", BOOLEAN)) {
    return {
      k: "result",
      id,
      ok: true,
      response: RESPONSE_PARSERS[method](
        m.value("response"),
        `${path}.response`,
      ),
    };
  }
  return m.value("tmuxError") === undefined
    ? {
        k: "result",
        id,
        ok: false,
        error: parseErrorPayload(m.object("error")),
      }
    : {
        k: "result",
        id,
        ok: false,
        tmuxError: parseCommandResponse(m.object("tmuxError")),
      };
}

// Every field a ResultFrame variant carries, so one view reads them all;
// `response` stays unread until the call's method says what it holds.
type WireResult = Pick<ResultFrame, "id"> & {
  readonly ok: boolean;
  readonly response: unknown;
} & Pick<ResultTmuxErrorFrame, "tmuxError"> &
  Pick<ResultErrFrame, "error">;

function parsePong(x: unknown): PongFrame {
  return {
    k: "pong",
    id: wireObject<PongFrame>(x, "pong").read("id", NON_EMPTY_STRING),
  };
}

function parseDraining(x: unknown): DrainingFrame {
  return {
    k: "draining",
    deadlineMs: wireObject<DrainingFrame>(x, "draining").read(
      "deadlineMs",
      NUMBER,
    ),
  };
}

function parseFatal(x: unknown): FatalErrorFrame {
  const m = wireObject<FatalErrorFrame>(x, "error");
  return {
    k: "error",
    fatal: m.read("fatal", TRUE),
    error: parseErrorPayload(m.object("error")),
  };
}

function parseErrorPayload(
  m: WireObject<BridgeErrorPayload>,
): BridgeErrorPayload {
  return {
    code: m.read("code", BRIDGE_ERROR_CODE),
    message: m.read("message", STRING),
  };
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
