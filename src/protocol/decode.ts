// src/protocol/decode.ts
// Decodes octal-escaped pane output from tmux control mode.
// Pure TypeScript — no Node.js dependencies. Works in browser, Deno, Bun.

// [LAW:one-source-of-truth] Encoding rules per SPEC.md Section 10:
//   0x00-0x1F  → \NNN (3-digit octal)
//   0x5C (\)   → \134
//   0x20-0x5B, 0x5D-0xFF → sent as-is

const BACKSLASH = 0x5c;

/**
 * Decode tmux octal-escaped output into raw bytes.
 *
 * tmux encodes bytes <0x20 and backslash as \NNN (3-digit octal).
 * All other bytes 0x20-0xFF pass through unchanged.
 *
 * Returns Uint8Array because pane output may contain incomplete UTF-8,
 * binary data, or raw terminal escape sequences. The consumer decides
 * how to interpret the bytes.
 */
export function decodeOctalEscapes(encoded: string): Uint8Array {
  // Fast path: no backslash means no escapes to decode.
  // [LAW:dataflow-not-control-flow] This is a value-level optimization,
  // not a control-flow branch — both paths produce the same type.
  const firstBackslash = encoded.indexOf("\\");
  if (firstBackslash === -1) {
    return stringToBytes(encoded);
  }

  // Upper bound: output is at most as long as input (escapes shrink).
  const result = new Uint8Array(encoded.length);
  let writePos = 0;

  // Copy everything before the first backslash in bulk.
  for (let i = 0; i < firstBackslash; i++) {
    result[writePos++] = encoded.charCodeAt(i);
  }

  let readPos = firstBackslash;
  const len = encoded.length;

  while (readPos < len) {
    const ch = encoded.charCodeAt(readPos);

    if (ch === BACKSLASH && readPos + 3 < len) {
      const d0 = encoded.charCodeAt(readPos + 1) - 48; // '0' = 48
      const d1 = encoded.charCodeAt(readPos + 2) - 48;
      const d2 = encoded.charCodeAt(readPos + 3) - 48;

      if (d0 >= 0 && d0 <= 7 && d1 >= 0 && d1 <= 7 && d2 >= 0 && d2 <= 7) {
        result[writePos++] = (d0 << 6) | (d1 << 3) | d2;
        readPos += 4;
        continue;
      }
    }

    // Not an escape sequence — pass through as raw byte.
    result[writePos++] = ch;
    readPos++;
  }

  return result.subarray(0, writePos);
}

/** Encode each code unit of a Latin-1 string as a byte. */
function stringToBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    bytes[i] = s.charCodeAt(i);
  }
  return bytes;
}
