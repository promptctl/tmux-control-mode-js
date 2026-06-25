// examples/web-multiplexer/shared/mirror-frame.ts
// Pure wire contract for the read-only pane-mirror channel (`/mirror`).
//
// A mirror connection is deliberately ASYMMETRIC: the browser sends NOTHING.
// The pane it watches is named in the connect URL (`/mirror?pane=%3`), so the
// client→server message set is EMPTY — "a viewer writes back to the pane" is
// not a frame this protocol can express. [LAW:types-are-the-program] The
// read-only-ness is the absence of an inbound vocabulary, not a runtime guard.
//
// Server→browser carries two channels, distinguished the same way the main
// bridge distinguishes them (see ws-client.ts):
//   - binary frames  → raw pane bytes to write into the terminal sink. The
//     first binary frame is the capture-pane seed (it leads with a clear);
//     every later frame is live tapped output. The viewer writes them all
//     identically — no per-frame branching. [LAW:dataflow-not-control-flow]
//   - JSON text frames → lifecycle (`size`, `viewers`, `gone`, `error`).
//
// [LAW:effects-at-boundaries] Pure: TextEncoder / string math only, zero IO,
//   zero Node deps. Imported by both the Node bridge server (build the seed,
//   parse the pane param) and the browser viewer (parse the param, type the
//   control frames).
// [LAW:one-source-of-truth] This module is the authoritative shape of the
//   mirror wire. Server and viewer both import it; neither re-declares it.

/**
 * The pane geometry, sent once before the seed so the viewer can `resize` its
 * sink (a fresh `XtermSink` buffers every write until its first resize — the
 * `.4` first-paint finding). Re-sent if the pane's size changes under it.
 */
export interface MirrorSizeFrame {
  readonly kind: "size";
  readonly cols: number;
  readonly rows: number;
}

/**
 * How many browsers are watching this pane right now (including the sender).
 * Pushed on every change to a mirror's viewer set, plus once on join. This is
 * the demo's payoff signal — one source fanning to N projections, made visible.
 */
export interface MirrorViewersFrame {
  readonly kind: "viewers";
  readonly count: number;
}

/** The mirrored pane closed (its program exited / window was killed). Terminal. */
export interface MirrorGoneFrame {
  readonly kind: "gone";
}

/** The mirror could not be established or sustained (bad pane id, capture failed). */
export interface MirrorErrorFrame {
  readonly kind: "error";
  readonly message: string;
}

/**
 * The complete server→browser JSON vocabulary. Pane BYTES are NOT here — they
 * ride binary frames. There is intentionally no client→server type: the viewer
 * is mute. [LAW:types-are-the-program]
 */
export type MirrorControlFrame =
  | MirrorSizeFrame
  | MirrorViewersFrame
  | MirrorGoneFrame
  | MirrorErrorFrame;

/** Query-parameter key naming the watched pane in the mirror connect URL. */
export const MIRROR_PANE_PARAM = "pane";

/** WebSocket path the bridge serves the read-only viewer endpoint on. */
export const MIRROR_WS_PATH = "/mirror-ws";

/**
 * Parse the pane id a mirror connection names in its query string. Accepts the
 * tmux-native `%3` form and a bare `3`; rejects everything else (including a
 * missing param, a non-numeric value, or a negative). Returns the numeric pane
 * id, or `null` when the query names no valid pane.
 *
 * [LAW:no-silent-failure] A malformed pane param returns `null` so the caller
 *   sends an explicit `error` frame — it is never coerced into a phantom pane 0.
 *
 * @param search a URL query string, with or without the leading `?`
 *   (`location.search` on the browser, the query slice of `req.url` on the
 *   server both work).
 *
 * The raw query is matched directly rather than through `URLSearchParams`: the
 * tmux-native `%3` form collides with URL percent-encoding (`%12` would decode
 * to a control byte), and pane ids never need escaping, so literal extraction
 * is the honest read.
 */
export function parseMirrorPane(search: string): number | null {
  const qs = search.startsWith("?") ? search.slice(1) : search;
  const param = new RegExp(`(?:^|&)${MIRROR_PANE_PARAM}=([^&]*)`).exec(qs);
  if (param === null) return null;
  const m = /^%?(\d+)$/.exec(param[1].trim());
  if (m === null) return null;
  return Number(m[1]);
}

/**
 * Build the shareable viewer URL for a pane — the link the operator hands to a
 * second browser. The standalone viewer page (`mirror.html`) reads the pane
 * back out with `parseMirrorPane(location.search)`.
 *
 * The pane id goes in BARE (`?pane=3`), never as tmux's `%3`: a literal `%` is
 * invalid percent-encoding, and a dev server that `decodeURI`s the request path
 * (Vite) 500s on it before the page can even load. The parser still accepts a
 * hand-typed `%3`, but the URLs this app produces never contain one.
 *
 * @param origin e.g. `location.origin` (`http://host:port`, no trailing slash)
 */
export function mirrorViewerUrl(origin: string, paneId: number): string {
  return `${origin}/mirror.html?${MIRROR_PANE_PARAM}=${paneId}`;
}

/**
 * The mirror WebSocket URL for a pane — what the viewer transport dials. A
 * distinct path from the `mirror.html` PAGE so the dev-server proxy (which
 * matches `/mirror-ws` by prefix) never shadows the static page. The bridge
 * mounts its read-only viewer endpoint at this path.
 *
 * @param wsBase e.g. `ws://host:port` or `wss://host` (no trailing slash)
 */
export function mirrorSocketUrl(wsBase: string, paneId: number): string {
  return `${wsBase}${MIRROR_WS_PATH}?${MIRROR_PANE_PARAM}=${paneId}`;
}

// Clear screen + scrollback + home the cursor. Prepended to the captured rows so
// a viewer joining a pane mid-stream paints a clean current screen rather than
// layering the seed onto whatever (blank) buffer its fresh terminal started with.
const CLEAR_SCREEN = "\x1b[H\x1b[2J\x1b[3J";

/**
 * Assemble the seed frame bytes from a `capture-pane -e -p` reply (one string
 * per visible row, escape sequences preserved). The result is `clear ++ rows`
 * joined by CRLF — exactly the bytes that, written into a fresh terminal,
 * reproduce the pane's current screen. The live tap's bytes are written on top
 * unchanged. [LAW:one-source-of-truth] one assembly, server-side, so every
 * viewer's first paint is identical.
 */
export function buildMirrorSeed(rows: readonly string[]): Uint8Array {
  return new TextEncoder().encode(CLEAR_SCREEN + rows.join("\r\n"));
}
