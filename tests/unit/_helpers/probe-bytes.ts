// tests/unit/_helpers/probe-bytes.ts
// Canonical byte-faithfulness probe payload.
//
// [LAW:one-source-of-truth] Defined once here; imported by both the Node and
//   browser contract tests to ensure they probe identical byte sequences.

// Windows-1252 landmine bytes (0x80-0x9F): TextDecoder('latin1') remaps these
// in browsers. bytesToLatin1 must preserve them 1:1.
// Multi-byte UTF-8 sequences (emoji, CJK): appear in real tmux pane output and
// must not be collapsed into code points by any transport decode path.
export const PROBE_BYTES = new Uint8Array([
  // Windows-1252 landmine bytes
  0x80, 0x81, 0x8d, 0x8f, 0x9d, 0x9f,
  // emoji U+1F600: F0 9F 98 80
  0xf0, 0x9f, 0x98, 0x80,
  // CJK U+4E2D: E4 B8 AD
  0xe4, 0xb8, 0xad,
  // ASCII baseline — must not be disturbed
  0x25, 0x62, 0x65, 0x67, 0x69, 0x6e, // "%begin"
]);
