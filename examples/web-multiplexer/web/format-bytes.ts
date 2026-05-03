// examples/web-multiplexer/web/format-bytes.ts
// One byte-formatting routine, used by the debug panel, inspector, and any
// other place that needs to render Uint8Array bytes as printable ASCII with
// control-character escapes.
//
// [LAW:one-source-of-truth] Two near-identical prettyBase64 helpers used to
// live inline in DebugPanel.tsx and InspectorView.tsx. Both decoded base64
// then escaped — but base64 is a transport detail. Now that hz1.2 normalizes
// event payloads to Uint8Array at the bridge boundary, the formatter takes
// bytes directly and lives in exactly one place.

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
    if (c === 0x1b) out += "\\x1b";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c >= 0x20 && c <= 0x7e) out += String.fromCharCode(c);
    else out += `\\x${c.toString(16).padStart(2, "0")}`;
  }
  if (bytes.length > max) out += `… (${bytes.length} bytes)`;
  return out;
}
