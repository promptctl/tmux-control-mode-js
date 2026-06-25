// examples/web-multiplexer/shared/firehose-frame.ts
// Binary wire frame for the demo's cross-terminal firehose channel.
//
// The firehose carries raw pane bytes tapped via `pipe-pane` from EVERY pane
// in EVERY session (see server/pane-firehose.ts) — a channel entirely separate
// from the attached session's `%output`. On WebSocket those attached bytes
// already ride the library's binary pane-output frame (magic 0x7F, decoded by
// `decodePaneOutput`). The firehose needs its own frame so the browser can
// route the two channels to different consumers without conflating them.
//
// [LAW:one-source-of-truth] One leading magic byte discriminates the channel.
//   Attached bytes (0x7F) reach the terminal renderer; firehose bytes (0xF1)
//   reach the regex match engine. Neither path ever sees the other's frames,
//   so a matched line can never double-count.
// [LAW:effects-at-boundaries] Pure (Uint8Array / DataView only) — zero IO, no
//   Node deps. Imported by both the Node bridge server (encode) and the
//   browser (decode).

/** Leading byte that marks a binary frame as firehose pane bytes. */
export const FIREHOSE_MAGIC = 0xf1;

/** magic(1) + paneId(uint32 LE, 4). Payload follows. */
const HEADER_LEN = 5;

/**
 * Encode one chunk of firehose pane bytes into a binary frame:
 * `[0xF1][paneId u32 LE][...payload]`. The payload is the raw pty bytes tmux
 * piped from the pane — no octal/`%output` framing, since the regex feed
 * strips ANSI to text downstream regardless.
 */
export function encodeFirehoseFrame(
  paneId: number,
  payload: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + payload.length);
  out[0] = FIREHOSE_MAGIC;
  new DataView(out.buffer).setUint32(1, paneId, true);
  out.set(payload, HEADER_LEN);
  return out;
}

/** True when `buf` is a firehose frame (leading magic byte). */
export function isFirehoseFrame(buf: Uint8Array): boolean {
  return buf.length >= HEADER_LEN && buf[0] === FIREHOSE_MAGIC;
}

/** One decoded firehose chunk: which pane the bytes came from, and the bytes. */
export interface FirehoseChunk {
  readonly paneId: number;
  readonly data: Uint8Array;
}

/**
 * Decode a firehose frame produced by `encodeFirehoseFrame`.
 *
 * [LAW:no-silent-failure] A frame too short to hold the header is a protocol
 *   violation, surfaced by throwing — never decoded into a phantom pane 0 with
 *   empty bytes.
 */
export function decodeFirehoseFrame(buf: Uint8Array): FirehoseChunk {
  if (!isFirehoseFrame(buf)) {
    throw new Error(
      `firehose frame has wrong magic byte 0x${(buf[0] ?? 0).toString(16)} or is too short`,
    );
  }
  const paneId = new DataView(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength,
  ).getUint32(1, true);
  // Copy the payload off the framing buffer so callers own a standalone array.
  const data = buf.slice(HEADER_LEN);
  return { paneId, data };
}
