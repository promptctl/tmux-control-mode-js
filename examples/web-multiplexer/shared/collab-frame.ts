// examples/web-multiplexer/shared/collab-frame.ts
// Pure wire contract for the COLLABORATIVE pane channel (`/collab-ws`).
//
// A collaborative connection is the WRITABLE sibling of the read-only mirror
// (shared/mirror-frame.ts). It shares the mirror's server→browser direction
// VERBATIM — `MirrorControlFrame` (size / viewers / gone / error) plus binary
// pane bytes (seed then live). What it ADDS, and the read-only mirror forbids,
// is a browser→server vocabulary: a binary frame carrying the pane's input
// bytes. [LAW:one-source-of-truth] the OUTPUT shape is not re-declared here;
// only the new INPUT shape lives in this module.
//
// The asymmetry between the two channels is the whole point of .14 vs .21:
//   - mirror : client→server vocabulary is EMPTY (a viewer is mute by type).
//   - collab : client→server vocabulary is exactly input bytes, and tmux — not any
//     CRDT — serialises every browser's keystrokes into one authoritative pane.
//
// [LAW:effects-at-boundaries] Pure: string math only, zero IO, zero Node deps.
//   Imported by both the Node bridge and the browser transport.
// [LAW:no-mode-explosion] Collaboration is NOT a flag on the mirror. It is its
//   own endpoint with its own (larger) vocabulary, so the read-only guarantee
//   stays a type the mirror cannot violate.

import { MIRROR_PANE_PARAM } from "./mirror-frame.js";

/**
 * WebSocket path the bridge serves the collaborative (read-write) endpoint on.
 *
 * Its browser→server vocabulary: every binary frame is input bytes for the
 * pane — what xterm produced from typing, pastes, and mouse reports — which the
 * server forwards byte-for-byte through `send-keys -H`. A text frame is misuse:
 * a collaborator can type and nothing else. Binary, not JSON, because a legacy
 * mouse report carries coordinate bytes ≥ 0x80 that a JSON string cannot hold
 * as bytes. [LAW:types-are-the-program]
 */
export const COLLAB_WS_PATH = "/collab-ws";

/**
 * Build the shareable collaborator URL for a pane — the link the operator hands
 * to a second browser. The standalone page (`collab.html`) reads the pane back
 * out with `parseMirrorPane(location.search)`.
 *
 * The pane id goes in BARE (`?pane=3`), never as tmux's `%3`: a literal `%` is
 * invalid percent-encoding and a `decodeURI`ing dev server (Vite) 500s on it.
 * Same rule the mirror URLs follow. [LAW:one-source-of-truth] the param key is
 * imported from the mirror contract, not re-spelled.
 *
 * @param origin e.g. `location.origin` (`http://host:port`, no trailing slash)
 */
export function collabViewerUrl(origin: string, paneId: number): string {
  return `${origin}/collab.html?${MIRROR_PANE_PARAM}=${paneId}`;
}

/**
 * The collaborative WebSocket URL for a pane — what the transport dials. A path
 * distinct from the `collab.html` PAGE so the dev-server proxy (which matches
 * `/collab-ws` by prefix) never shadows the static page.
 *
 * @param wsBase e.g. `ws://host:port` or `wss://host` (no trailing slash)
 */
export function collabSocketUrl(wsBase: string, paneId: number): string {
  return `${wsBase}${COLLAB_WS_PATH}?${MIRROR_PANE_PARAM}=${paneId}`;
}
