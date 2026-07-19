// examples/web-multiplexer/web/format-bytes.ts
// One byte-formatting routine, used by the debug panel, inspector, and any
// other place that needs to render Uint8Array bytes as printable ASCII with
// control-character escapes.
//
// [LAW:one-source-of-truth] One byte formatter, used everywhere. Pane bytes
// reach the renderer as Uint8Array — the library decodes the transport's
// binary pane-output frames at the bridge boundary — so the formatter takes
// bytes directly and lives in exactly one place.

/**
 * The single escape rule for one byte/code-unit: ESC/CR/LF/TAB get named
 * escapes, 0x20–0x7e pass through, everything else becomes `\xHH`.
 *
 * [LAW:single-enforcer] This is the one place the control-character escape
 * table lives. `prettyBytes` (bytes) and the inspector's key-escaper
 * (string code units) both route through it so the two can never drift.
 */
export function escapeByte(code: number): string {
  if (code === 0x1b) return "\\x1b";
  if (code === 0x0a) return "\\n";
  if (code === 0x0d) return "\\r";
  if (code === 0x09) return "\\t";
  if (code >= 0x20 && code <= 0x7e) return String.fromCharCode(code);
  return `\\x${code.toString(16).padStart(2, "0")}`;
}

/**
 * Render up to `max` printable characters from a byte array. Control bytes
 * are rendered with escape notation (\x1b, \r, \n, \t); 0x20–0x7e pass
 * through; high/non-printable bytes appear as \xHH. When the input exceeds
 * `max`, a truncation suffix `… (N bytes)` is appended.
 */
export function prettyBytes(bytes: Uint8Array, max: number = 48): string {
  let out = "";
  for (let i = 0; i < bytes.length && out.length < max; i++) {
    const c = bytes[i];
    if (c === undefined) break;
    out += escapeByte(c);
  }
  if (bytes.length > max) out += `… (${bytes.length} bytes)`;
  return out;
}
