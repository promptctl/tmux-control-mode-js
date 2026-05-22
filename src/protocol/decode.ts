// src/protocol/decode.ts
// Decodes octal-escaped pane output from tmux control mode.
// Pure TypeScript — no Node.js dependencies. Works in browser, Deno, Bun.

// [LAW:one-source-of-truth] Encoding rules per SPEC.md Section 10 and the
//   canonical iTerm2 client (TmuxGateway -decodeEscapedOutput):
//   0x00-0x1F  → emitted by tmux ONLY as \NNN (3-digit octal)
//   0x5C (\)   → \134
//   0x20-0x5B, 0x5D-0xFF → sent as-is
//
//   Because tmux escapes every real control byte as octal, ANY literal byte
//   < 0x20 that appears in the payload is line-driver / transport noise (the
//   "\r's the line driver sprinkles in at its pleasure") and is dropped.
//   Inside an octal escape, stray \r between the digits is likewise skipped.

const BACKSLASH = 0x5c;
const SPACE = 0x20;
const CR = 0x0d;
const QUESTION = 0x3f; // '?'

/**
 * Decode tmux octal-escaped output into raw bytes, mirroring the canonical
 * client's decoder exactly:
 *
 *  - literal (unescaped) bytes < 0x20 are dropped (transport noise; real
 *    control output always arrives octal-escaped),
 *  - `\NNN` (three octal digits, with any interleaved `\r` skipped) → one byte,
 *  - a malformed escape (`\` not followed by three octal digits) → `?`,
 *  - every other byte 0x20-0xFF passes through unchanged.
 *
 * Operates on a Latin-1 string (one code unit per byte — see the transport's
 * `setEncoding("latin1")`). Returns Uint8Array because pane output may be
 * incomplete UTF-8, binary data, or raw terminal escape sequences; the
 * consumer (the terminal emulator) decides how to interpret the bytes.
 */
export function decodeOctalEscapes(encoded: string): Uint8Array {
  const len = encoded.length;
  // Upper bound: output is never longer than input (drops + escapes shrink).
  const result = new Uint8Array(len);
  let writePos = 0;
  let i = 0;

  while (i < len) {
    let c = encoded.charCodeAt(i);

    // [LAW:single-enforcer] Literal control bytes are dropped here, once.
    // tmux escapes all real control output as octal, so these are noise.
    if (c < SPACE) {
      i++;
      continue;
    }

    if (c === BACKSLASH) {
      c = 0;
      for (let j = 0; j < 3; j++) {
        i++;
        // Skip stray \r the line driver may have inserted between digits.
        while (i < len && encoded.charCodeAt(i) === CR) i++;
        const d = i < len ? encoded.charCodeAt(i) - 48 : -1; // '0' = 48
        if (d < 0 || d > 7) {
          // Malformed escape → '?'; back up so the non-digit byte is
          // reconsidered as ordinary input on the next pass (matches the
          // reference decoder's recovery).
          c = QUESTION;
          i--;
          break;
        }
        c = c * 8 + d;
      }
      // A legitimately escaped byte (incl. control bytes like \015) is kept;
      // only LITERAL control bytes are dropped by the guard above.
    }

    result[writePos++] = c;
    i++;
  }

  return result.subarray(0, writePos);
}

const utf8Decoder = new TextDecoder("utf-8");

/**
 * Re-interpret a Latin-1 string (one code unit per raw byte, as produced by
 * the byte-preserving transport) as UTF-8 text. Used for human-readable
 * notification fields (window/session names, messages, subscription values)
 * which tmux emits as UTF-8 byte sequences. Pane *output* is NOT routed
 * through here — it stays raw bytes via `decodeOctalEscapes`.
 */
export function latin1ToUtf8(s: string): string {
  // Fast path: pure ASCII needs no reinterpretation.
  let hasHighByte = false;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) {
      hasHighByte = true;
      break;
    }
  }
  if (!hasHighByte) return s;

  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return utf8Decoder.decode(bytes);
}
