// examples/web-multiplexer/web/hyperlink-engine.ts
//
// HyperlinkEngine — the pure core of the OSC 8 hyperlink sidebar aggregator: a
// streaming sniffer that frames `OSC 8` hyperlink escape sequences out of the
// raw byte stream of EVERY pane and folds them into a deduplicated, global
// registry of clickable destinations. This is the "parsing depth" showcase in
// its purest form: a terminal renders an OSC 8 link as styled text and throws
// the URI away after one paint; the bridge firehose hands us the raw pty bytes
// of every pane with the sequence intact, so the URI any pane has *ever* emitted
// is collectible. Trivial with the parser, impossible without it.
//
// [LAW:effects-at-boundaries] Zero IO, zero MobX, no DOM. Bytes in, a registry
//   of LinkEntry out — a pure function of the byte stream, exhaustively
//   unit-tested. The firehose subscription, the <a> rendering and the pane jump
//   all live at the boundary (HyperlinkStore / HyperlinkSidebarView).
// [LAW:no-ambient-temporal-coupling] An OSC 8 sequence may be split across
//   arbitrary firehose chunk boundaries — even between the ESC and the `\` of a
//   String Terminator, or between the opener and its display text. The per-pane
//   OscLinkScanner carries all parser state across pushBytes calls; correctness
//   never depends on a sequence arriving whole.
// [LAW:types-are-the-program] A `Hyperlink` ALWAYS carries a non-empty URI. An
//   OSC 8 opener with an empty URI IS the closer, not a link — "a link with no
//   target" is not a representable state. Detection IS a successful parse: a
//   registry entry exists only once a non-empty URI has been framed, so the view
//   never branches on "is this a real link yet". Unlike the data sniffer's grid
//   (unknown until rows accumulate), the URI is atomic at the opener — fully
//   known before any display text — so finalizing a dangling open link on
//   quiescence can never emit a half-parsed payload.
// [LAW:dataflow-not-control-flow] Every chunk runs the same scan → upsert
//   pipeline. A pane that emits no links is the empty-registry case (the ground
//   state consumes and discards its bytes), not a skipped branch.
// [LAW:one-source-of-truth] The registry IS the link list. Per-pane scanner
//   carry-over (the in-flight open link + its accumulated text) is derived state
//   that holds no entries; nothing else holds links.
//
// SCOPE (precision over recall, stated honestly — [LAW:no-silent-failure] we do
// not pretend to catch everything): we collect ONLY explicit `OSC 8` hyperlinks.
// We deliberately do NOT heuristically auto-detect bare URLs in plain text —
// that is recall the parser does not need, and it is exactly the false-positive
// swamp this demo avoids. OSC 8 is an unambiguous marker emitted on purpose by
// the producing program (`ls --hyperlink`, compiler diagnostics, many CLIs), so
// every entry here is a link the program declared, with zero guessing.

/** One framed OSC 8 hyperlink, before aggregation. `uri` is always non-empty. */
export interface Hyperlink {
  readonly paneId: number;
  /** The link target. Non-empty by construction (an empty URI is the closer). */
  readonly uri: string;
  /** The display text between opener and closer (UTF-8, whitespace-collapsed). */
  readonly text: string;
}

/**
 * One aggregated destination in the global sidebar. Distinct URIs are the unit:
 * the same link emitted by `ls` ten times is ONE entry with `count: 10`. Display
 * label, scheme and host are derived by the view from `uri`/`text`, so they live
 * there, not here — this carries only what is authoritative.
 */
export interface LinkEntry {
  /** The dedup key. Non-empty. */
  readonly uri: string;
  /** First non-empty display text seen for this URI, or "" if none ever was. */
  readonly text: string;
  /** Total times this URI has been emitted across all panes. */
  readonly count: number;
  /** The most-recent pane to emit it — the unambiguous jump target. */
  readonly paneId: number;
  /** Monotonic recency stamp; the feed sorts by this. */
  readonly lastSeq: number;
}

// Control bytes.
const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c; // ST is ESC \
const OSC_INTRO = 0x5d; // ESC ]
const CSI_INTRO = 0x5b; // ESC [
const DCS_INTRO = 0x50; // ESC P
const APC_INTRO = 0x5f; // ESC _
const PM_INTRO = 0x5e; // ESC ^
const SOS_INTRO = 0x58; // ESC X

/**
 * Cap on an in-progress OSC string body. A terminator that never arrives must
 * not grow unbounded; on overflow we abandon the sequence and resync. A URI this
 * long is not a real hyperlink anyway.
 */
const MAX_OSC_BYTES = 64 * 1024;

/**
 * Cap on accumulated display text for one open link. The URI (the payload) is
 * already captured at the opener, so a runaway label just stops growing — the
 * link is still complete and correct.
 */
const MAX_TEXT_BYTES = 8 * 1024;

type Mode = "ground" | "esc" | "osc" | "csi" | "skipString";

/** An OSC 8 link currently open (opener seen, closer not yet). */
interface OpenLink {
  readonly uri: string;
  /** Display-text bytes accumulated since the opener (printable + collapsed ws). */
  readonly text: number[];
}

/**
 * Parser for ONE pane, resumable across chunk boundaries. It walks the VT500
 * escape grammar only as deep as needed to (a) frame OSC strings (to find the
 * `OSC 8` openers/closers) and (b) skip CSI styling that appears *inside* a
 * link's display text, so the captured label stays clean. Everything else
 * (other ESC forms, DCS/APC/PM/SOS strings) is skipped wholesale; none carry
 * hyperlinks and dropping back to ground resyncs cleanly.
 */
class OscLinkScanner {
  private mode: Mode = "ground";
  private osc: number[] = [];
  /** In an OSC string, an ESC was seen and we're checking for the `\` of ST. */
  private sawEsc = false;
  /** The hyperlink currently open on this pane (between opener and closer). */
  private open: OpenLink | null = null;

  /**
   * Feed raw bytes; emit each framed hyperlink to `sink`. The display text of
   * the open link is accumulated in `ground` mode (CSI styling is consumed by
   * the `csi` mode and excluded). [LAW:dataflow-not-control-flow]
   */
  push(
    data: Uint8Array,
    paneId: number,
    sink: (link: Hyperlink) => void,
  ): void {
    for (let i = 0; i < data.length; i++) {
      const b = data[i]!;
      switch (this.mode) {
        case "ground":
          if (b === ESC) this.mode = "esc";
          else this.appendText(b);
          break;
        case "esc":
          this.afterEsc(b);
          break;
        case "csi":
          // Consume CSI params/intermediates; a final byte (0x40–0x7e) ends it.
          if (b >= 0x40 && b <= 0x7e) this.mode = "ground";
          break;
        case "skipString":
          this.skipStringByte(b);
          break;
        case "osc":
          this.consumeOscByte(b, paneId, sink);
          break;
      }
    }
  }

  /** Finalize a dangling open link (the pane fell silent). Idempotent. */
  flush(paneId: number, sink: (link: Hyperlink) => void): void {
    this.emitOpen(paneId, sink);
  }

  // -------------------------------------------------------------------------

  private afterEsc(b: number): void {
    if (b === OSC_INTRO) {
      this.mode = "osc";
      this.osc = [];
      this.sawEsc = false;
      return;
    }
    if (b === CSI_INTRO) {
      this.mode = "csi";
      return;
    }
    if (
      b === DCS_INTRO ||
      b === APC_INTRO ||
      b === PM_INTRO ||
      b === SOS_INTRO
    ) {
      this.mode = "skipString";
      this.sawEsc = false;
      return;
    }
    if (b === ESC) return; // ESC ESC: restart the introducer
    // Any other escape (charset designation, RIS, …): a short form. Return to
    // ground; the single final byte was `b` and is now consumed.
    this.mode = "ground";
  }

  /** Skip a DCS/APC/PM/SOS string body up to its ST/BEL terminator. */
  private skipStringByte(b: number): void {
    if (this.sawEsc) {
      this.sawEsc = false;
      this.mode = b === ESC ? "esc" : "ground"; // ESC \ ends it; stray ESC resyncs
      return;
    }
    if (b === ESC) this.sawEsc = true;
    else if (b === BEL) this.mode = "ground";
  }

  /** Append one display-text byte while a link is open; bound the buffer. */
  private appendText(b: number): void {
    const open = this.open;
    if (open === null) return; // not inside a link — discard
    if (open.text.length >= MAX_TEXT_BYTES) return;
    // Collapse C0 whitespace (LF/CR/TAB) to a single space so a multi-line label
    // reads as words, not a run-on; drop other control bytes entirely.
    if (b === 0x0a || b === 0x0d || b === 0x09) {
      if (open.text[open.text.length - 1] !== 0x20) open.text.push(0x20);
      return;
    }
    if (b < 0x20 || b === 0x7f) return;
    open.text.push(b);
  }

  /** Accumulate one OSC string byte; on terminator, classify the sequence. */
  private consumeOscByte(
    b: number,
    paneId: number,
    sink: (link: Hyperlink) => void,
  ): void {
    if (this.sawEsc) {
      this.sawEsc = false;
      if (b === BACKSLASH) {
        this.finishOsc(paneId, sink); // ESC \ = ST → string complete
      } else {
        this.abandonOsc();
        if (b === ESC) this.mode = "esc"; // stray ESC: resync into a new escape
        // else: the byte is ordinary; it was consumed (rare malformed case).
      }
      return;
    }
    if (b === ESC) {
      this.sawEsc = true; // could be the start of ST
      return;
    }
    if (b === BEL) {
      this.finishOsc(paneId, sink); // OSC also terminates on BEL
      return;
    }
    this.osc.push(b);
    if (this.osc.length > MAX_OSC_BYTES) this.abandonOsc();
  }

  private abandonOsc(): void {
    this.mode = "ground";
    this.osc = [];
  }

  /**
   * A complete OSC body is in `this.osc`. If it is `OSC 8`, apply it to the open-
   * link state machine: a non-empty URI opens (superseding any open link), an
   * empty URI closes. A non-`8` OSC (title, clipboard, image, …) is ignored and
   * does NOT disturb an open link's text. [LAW:no-ambient-temporal-coupling] the
   * opener/closer owns the open-link transition.
   */
  private finishOsc(paneId: number, sink: (link: Hyperlink) => void): void {
    const body = this.osc;
    this.mode = "ground";
    this.osc = [];

    const uri = parseOsc8Uri(body);
    if (uri === null) return; // not an OSC 8 hyperlink — leave any open link be

    if (uri === "") {
      // Closer: emit the open link (if any) and clear.
      this.emitOpen(paneId, sink);
      return;
    }
    // Opener: a new link supersedes whatever was open (its closer never came).
    this.emitOpen(paneId, sink);
    this.open = { uri, text: [] };
  }

  /** Emit the open link (if any) and clear it. The URI is always valid. */
  private emitOpen(paneId: number, sink: (link: Hyperlink) => void): void {
    const open = this.open;
    if (open === null) return;
    this.open = null;
    sink({ paneId, uri: open.uri, text: decodeText(open.text) });
  }
}

/**
 * Parse an OSC body's `Ps` and, when it is `8`, return the trimmed URI (the
 * field after the SECOND semicolon — so a `;` inside the URI is preserved). The
 * params field uses `:`-separated keys, never `;`, so two splits is exact.
 * Returns `null` when the body is not an OSC 8 hyperlink, or the URI string
 * (possibly `""` for a closer) when it is.
 *
 * Exported for unit testing the framing in isolation. [LAW:behavior-not-structure]
 */
export function parseOsc8Uri(body: ArrayLike<number>): string | null {
  const text = bytesToLatin1(body);
  const firstSemi = text.indexOf(";");
  const ps = firstSemi === -1 ? text : text.slice(0, firstSemi);
  if (ps !== "8") return null;
  if (firstSemi === -1) return ""; // bare "8" — treat as a (malformed) closer
  const rest = text.slice(firstSemi + 1);
  const secondSemi = rest.indexOf(";");
  if (secondSemi === -1) return ""; // "8;params" with no URI field — closer-ish
  return rest.slice(secondSemi + 1).trim();
}

export class HyperlinkEngine {
  private readonly scanners = new Map<number, OscLinkScanner>();
  private readonly registry = new Map<string, LinkEntry>();
  private nextSeq = 1;

  /** @param capacity max distinct URIs retained (least-recently-seen eviction). */
  constructor(private readonly capacity: number) {}

  /**
   * Feed one raw pane byte chunk. Frames any OSC 8 hyperlinks it completes and
   * folds them into the registry. A single sequence may span many chunks; the
   * per-pane scanner carries the parser state until its terminator arrives.
   */
  pushBytes(paneId: number, data: Uint8Array): void {
    this.scannerFor(paneId).push(data, paneId, (link) => this.upsert(link));
    this.evict();
  }

  /**
   * Finalize one pane's dangling open link (the store calls this when a pane
   * falls silent for a tick: an opener whose closer never arrived is still a
   * complete link, because the URI was known at the opener). [LAW:no-silent-
   * failure] a real, clickable link is not dropped just because its producer
   * forgot the closer.
   */
  flushPane(paneId: number): void {
    const scanner = this.scanners.get(paneId);
    if (scanner === undefined) return;
    scanner.flush(paneId, (link) => this.upsert(link));
    this.evict();
  }

  /** The aggregated link list, oldest-seen first (the view reverses for recency). */
  get links(): readonly LinkEntry[] {
    return [...this.registry.values()].sort((a, b) => a.lastSeq - b.lastSeq);
  }

  /** Number of distinct destinations collected. */
  get linkCount(): number {
    return this.registry.size;
  }

  /** Number of distinct panes that have fed the engine bytes this session. */
  get tappedPaneCount(): number {
    return this.scanners.size;
  }

  /** Drop all links and per-pane carry-over (e.g. on disconnect). */
  clear(): void {
    this.registry.clear();
    this.scanners.clear();
  }

  // -------------------------------------------------------------------------

  private scannerFor(paneId: number): OscLinkScanner {
    let scanner = this.scanners.get(paneId);
    if (scanner === undefined) {
      scanner = new OscLinkScanner();
      this.scanners.set(paneId, scanner);
    }
    return scanner;
  }

  /** Fold one framed hyperlink into the registry, deduplicating by URI. */
  private upsert(link: Hyperlink): void {
    const seq = this.nextSeq++;
    const prev = this.registry.get(link.uri);
    if (prev === undefined) {
      this.registry.set(link.uri, {
        uri: link.uri,
        text: link.text,
        count: 1,
        paneId: link.paneId,
        lastSeq: seq,
      });
      return;
    }
    this.registry.set(link.uri, {
      uri: prev.uri,
      // Keep the first non-empty label we ever saw for this destination.
      text: prev.text === "" ? link.text : prev.text,
      count: prev.count + 1,
      paneId: link.paneId,
      lastSeq: seq,
    });
  }

  /** Evict the least-recently-seen distinct URIs when over capacity. */
  private evict(): void {
    if (this.registry.size <= this.capacity) return;
    const ordered = [...this.registry.values()].sort(
      (a, b) => a.lastSeq - b.lastSeq,
    );
    const drop = this.registry.size - this.capacity;
    for (let i = 0; i < drop; i++) this.registry.delete(ordered[i]!.uri);
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** UTF-8 decode the accumulated display-text bytes, trimmed + ws-collapsed. */
function decodeText(bytes: number[]): string {
  const decoded = new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
  return decoded.replace(/\s+/g, " ").trim();
}

/** Latin-1 decode: bytes 0–255 map 1:1 to char codes; lossless for ASCII URIs. */
function bytesToLatin1(bytes: ArrayLike<number>): string {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, bytes.length);
    out += String.fromCharCode(...Array.prototype.slice.call(bytes, i, end));
  }
  return out;
}
