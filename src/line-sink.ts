// src/line-sink.ts
// Line-shaped consumer behavior for pane output.
//
// `attachLineSink(client, onLine, options?)` is the default text path —
// most consumers (matchers, loggers, search, AI capture, assertions) want
// lines, not bytes. Under the hood this is a `BytesSink` registered with
// `client.attachBytesSink(...)`; the scope passed by the caller is the
// same scope the byte sink uses, so admission is decided by `SinkRegistry`
// — there is no second admission table here.
//
// [LAW:types-are-the-program] The byte path and the line path are different
//   behaviors with different shapes (`BytesSink` write vs. `(event) => void`).
//   Each has one attach function; the four scope kinds are values that
//   parameterize either behavior, not new methods.
// [LAW:single-enforcer] Per-pane streaming UTF-8 decode lives in exactly one
//   place — `PerPaneLineState`. N line consumers attached for the same pane
//   share one `TextDecoder` and one partial-line buffer; the chunk is decoded
//   exactly once per arrival regardless of consumer count. Message-object
//   identity is the "already decoded this chunk" token, so no auxiliary
//   sequence counter is required.
// [LAW:dataflow-not-control-flow] Pipeline lifecycle is data-driven: the per-
//   pane state is created lazily on the first chunk for that pane, and the
//   admitting-consumer set grows by membership-on-arrival. When the last
//   admitting consumer for a pane detaches, the buffer is flushed through
//   that consumer and the per-pane state is dropped.
// [LAW:make-it-impossible] Line consumers receive `{ line: string; paneId }`
//   only. The shared `TextDecoder` instance is unreachable from the value the
//   consumer holds, so a downstream cannot misdecode by reaching through.

import {
  serverScope,
  type AttachOptions,
  type BytesSink,
} from "./pane-output.js";
import type { PaneOutputMessage } from "./protocol/types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One decoded UTF-8 line from a tmux pane.
 *
 * - `line` does NOT include the trailing newline. A trailing `\r` (from CRLF
 *   sequences common in TTY output) is stripped — `attachLineSink` consumers
 *   receive bare text, never line terminators.
 * - `paneId` is the pane the line originated from. With broader scopes
 *   (server / session / window) consumers must carry this to disambiguate.
 */
export interface LineEvent {
  readonly line: string;
  readonly paneId: number;
}

/** Callback signature for `attachLineSink`. */
export type LineHandler = (event: LineEvent) => void;

// ---------------------------------------------------------------------------
// TmuxConnection slice — the only client capability this module needs
// ---------------------------------------------------------------------------

interface AttachBytes {
  attachBytesSink(sink: BytesSink, options?: AttachOptions): () => void;
}

// ---------------------------------------------------------------------------
// Per-client line registry
// ---------------------------------------------------------------------------

interface PerPaneLineState {
  // [LAW:single-enforcer] One streaming decoder per pane, shared across every
  //   line consumer admitting that pane.
  readonly decoder: TextDecoder;
  // Partial trailing line carried between chunks.
  buffer: string;
  // Identity check: the `PaneOutputMessage` object dispatched by `SinkRegistry`
  // is the same reference for every byte sink that admits the chunk. When two
  // byte sinks fire for the same chunk, the second sees `lastMsg === msg` and
  // re-uses `lines` without invoking the decoder a second time.
  lastMsg: PaneOutputMessage | null;
  // Complete lines produced from the most recent chunk. Snapshot per chunk so
  // the second consumer iterates the same array the first produced.
  lines: readonly string[];
  // Consumers whose scope admits this pane. Membership is recorded
  // on-arrival: when a byte sink fires for `paneId`, the consumer owning
  // that byte sink is added to the set.
  readonly admittingConsumers: Set<LineConsumerRecord>;
}

interface LineConsumerRecord {
  readonly handler: LineHandler;
}

function newPerPaneLineState(): PerPaneLineState {
  return {
    decoder: new TextDecoder("utf-8", { fatal: false }),
    buffer: "",
    lastMsg: null,
    lines: [],
    admittingConsumers: new Set(),
  };
}

class LineRegistry {
  // [LAW:one-source-of-truth] Per-pane state lives only here for the client.
  //   Each `attachLineSink` call references this same registry via the module-
  //   level WeakMap; no per-call copy of decoder or buffer exists.
  readonly perPane = new Map<number, PerPaneLineState>();
}

// [LAW:no-shared-mutable-globals] Module-scope WeakMap is a single owner with
//   an explicit API (`getOrCreateRegistry`). Entries are reachable only while
//   the client is reachable; GC collects them automatically.
const registries = new WeakMap<object, LineRegistry>();

function getOrCreateRegistry(client: object): LineRegistry {
  let r = registries.get(client);
  if (r === undefined) {
    r = new LineRegistry();
    registries.set(client, r);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Line splitting — split on LF, strip trailing CR
// ---------------------------------------------------------------------------

// Strips one trailing '\r' if present. tmux panes are TTYs, so output uses
// CRLF; consumers want bare text, not the terminal-layer carriage return.
function stripTrailingCR(s: string): string {
  return s.length > 0 && s.charCodeAt(s.length - 1) === 0x0d
    ? s.slice(0, -1)
    : s;
}

// ---------------------------------------------------------------------------
// attachLineSink — public entry
// ---------------------------------------------------------------------------

/**
 * Attach a UTF-8 line consumer to pane output matching the given scope.
 *
 * `onLine` is called once per completed line. `line` excludes the trailing
 * `\n` (and any preceding `\r`); `paneId` identifies the originating pane.
 *
 * `options.scope` defaults to `serverScope` (every pane on the server,
 * including future sessions). Pass `paneScope(id)`, `windowScope(id)`, or
 * `sessionScope(id)` to narrow the subscription. Topology is dynamic — a
 * `sessionScope` consumer sees panes added to that session after attach.
 *
 * Returns an idempotent disposer. On dispose, any partial line still in the
 * per-pane buffer is flushed through `onLine` exactly when this is the last
 * line consumer admitting that pane.
 *
 * Internally registers one `BytesSink` per call with `client.attachBytesSink`,
 * delegating per-pane streaming decode to a shared `LineRegistry`. N
 * consumers on the same pane share one decoder — one decode per chunk.
 *
 * @see BytesSink for the lower-level byte contract.
 * @see PaneScope for the scope union.
 */
export function attachLineSink(
  client: AttachBytes,
  onLine: LineHandler,
  options?: AttachOptions,
): () => void {
  const registry = getOrCreateRegistry(client);
  const consumer: LineConsumerRecord = { handler: onLine };

  const byteSink: BytesSink = {
    write(msg: PaneOutputMessage): void {
      let state = registry.perPane.get(msg.paneId);
      if (state === undefined) {
        state = newPerPaneLineState();
        registry.perPane.set(msg.paneId, state);
      }

      // [LAW:single-enforcer] Decode-and-split runs at most once per chunk.
      //   `SinkRegistry` dispatches the same `PaneOutputMessage` reference to
      //   every admitting byte sink; the identity check makes the second-and-
      //   subsequent calls no-ops for decode.
      if (state.lastMsg !== msg) {
        state.lastMsg = msg;
        const text = state.decoder.decode(msg.data, { stream: true });
        const combined = state.buffer + text;
        const parts = combined.split("\n");
        // `pop()` from a non-empty split always yields a string; the trailing
        // partial (possibly empty) becomes the new buffer.
        state.buffer = parts.pop() as string;
        state.lines = parts.map(stripTrailingCR);
      }

      // Record this consumer as admitting this pane on first sight. The set
      // grows as broader-scope consumers receive their first chunk for new
      // panes; topology changes can never shrink it implicitly — only an
      // explicit disposer removes a consumer.
      state.admittingConsumers.add(consumer);

      for (const line of state.lines) {
        onLine({ line, paneId: msg.paneId });
      }
    },

    end(): void {
      // [LAW:dataflow-not-control-flow] Lifecycle decision is data-driven:
      //   the admitting-consumer set decides whether the per-pane state stays
      //   alive (size > 0) or is flushed and dropped (size === 0).
      for (const [paneId, state] of registry.perPane) {
        const removed = state.admittingConsumers.delete(consumer);
        if (!removed) continue;
        if (state.admittingConsumers.size > 0) continue;

        // Last admitting consumer for this pane: flush decoder tail + buffer
        // through THIS consumer, then drop the state.
        const tail = state.decoder.decode();
        const final = stripTrailingCR(state.buffer + tail);
        registry.perPane.delete(paneId);
        if (final.length > 0) {
          onLine({ line: final, paneId });
        }
      }
    },
  };

  return client.attachBytesSink(byteSink, options);
}

// Re-export `serverScope` so a caller that only imports from this module has
// a default-scope value at hand without needing a second import. The default
// is applied by `attachBytesSink` when `options?.scope` is absent.
export { serverScope };
