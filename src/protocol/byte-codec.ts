// src/protocol/byte-codec.ts
// Portable byte-faithful codec: Uint8Array ↔ latin1-container string.
//
// [LAW:single-enforcer] All bytes<->string conversion in this library flows
//   through these two functions. No other site may use TextDecoder, TextEncoder,
//   Buffer.from(…, 'latin1'), or setEncoding('latin1') for this conversion.
// [LAW:one-source-of-truth] The canonical definition of the byte<->code-unit
//   bijection lives here. Other types may declare that a value uses this
//   encoding; the definition itself is not duplicated.
//
// Why not TextDecoder('latin1')?
//   TextDecoder('latin1') is the windows-1252 decoder in browsers: bytes
//   0x80-0x9F are remapped to non-latin1 code points. The manual charCodeAt/
//   fromCharCode path below is the only portable route that is genuinely 1:1.

const CHUNK = 8192;

/**
 * Decode a Uint8Array to a latin1-container string (one code unit per byte).
 *
 * The result is not a semantic string — it is a byte-container. Consumers
 * that need text must decode it further (e.g. via a streaming TextDecoder).
 * Callers that need to recover the original bytes call `latin1ToBytes`.
 */
export function bytesToLatin1(bytes: Uint8Array): string {
  // [LAW:single-enforcer] Chunked to avoid call-stack overflow on large inputs.
  let result = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    result += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return result;
}

/**
 * Encode a latin1-container string back to a Uint8Array (one byte per code unit).
 *
 * Code units outside 0x00-0xFF are truncated to their low 8 bits. The caller
 * is responsible for ensuring the input was produced by `bytesToLatin1` or an
 * equivalent byte-faithful source.
 */
export function latin1ToBytes(str: string): Uint8Array {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff;
  }
  return bytes;
}
