// examples/web-multiplexer/web/hyperlink-engine.test.ts
//
// Unit tests for the pure OSC 8 hyperlink engine. The engine is a pure function
// of (byte chunks) → (link registry), so every behaviour is pinned here in
// isolation — no firehose, no MobX, no DOM. [LAW:behavior-not-structure] the
// assertions are over the framed links and the aggregated registry (the
// contract), never over the private scanner carry-over (the mechanism).

import { describe, it, expect } from "vitest";
import {
  HyperlinkEngine,
  parseOsc8Uri,
  type LinkEntry,
} from "./hyperlink-engine.ts";

const PANE = 7;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** ESC `]` … ST — build an OSC string with the ESC `\` terminator. */
const osc = (body: string): string => `\x1b]${body}\x1b\\`;
/** An OSC 8 opener for `uri` with optional `params`. */
const open = (uri: string, params = ""): string => osc(`8;${params};${uri}`);
/** The OSC 8 closer (empty URI). */
const CLOSE = osc("8;;");
/** A complete `OSC 8 opener · text · closer` hyperlink. */
const link = (uri: string, text: string, params = ""): string =>
  `${open(uri, params)}${text}${CLOSE}`;

/** Feed chunks into a fresh engine and return its aggregated links. */
function collect(...chunks: string[]): readonly LinkEntry[] {
  const engine = new HyperlinkEngine(1000);
  for (const c of chunks) engine.pushBytes(PANE, enc(c));
  return engine.links;
}

describe("parseOsc8Uri", () => {
  const b = (s: string): number[] => [...enc(s)];

  it("extracts the URI of an opener (after the second semicolon)", () => {
    expect(parseOsc8Uri(b("8;;https://example.com"))).toBe(
      "https://example.com",
    );
  });

  it("returns empty string for a closer", () => {
    expect(parseOsc8Uri(b("8;;"))).toBe("");
  });

  it("ignores the params field and reads only the URI", () => {
    expect(parseOsc8Uri(b("8;id=42;https://example.com/x"))).toBe(
      "https://example.com/x",
    );
  });

  it("preserves semicolons inside the URI (only the first two split)", () => {
    expect(parseOsc8Uri(b("8;;https://h/a;b;c"))).toBe("https://h/a;b;c");
  });

  it("trims surrounding whitespace from the URI", () => {
    expect(parseOsc8Uri(b("8;;  https://x  "))).toBe("https://x");
  });

  it("returns null for a non-8 OSC (a window title)", () => {
    expect(parseOsc8Uri(b("0;my title"))).toBeNull();
  });

  it("returns null for OSC 133 (shell prompt mark)", () => {
    expect(parseOsc8Uri(b("133;A"))).toBeNull();
  });

  it("treats a bare `8` and `8;params` (no URI field) as a closer", () => {
    expect(parseOsc8Uri(b("8"))).toBe("");
    expect(parseOsc8Uri(b("8;id=x"))).toBe("");
  });
});

describe("HyperlinkEngine — framing one link", () => {
  it("collects a complete opener·text·closer hyperlink", () => {
    const links = collect(link("https://example.com", "Example"));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      uri: "https://example.com",
      text: "Example",
      count: 1,
      paneId: PANE,
    });
  });

  it("accepts a BEL-terminated OSC (not just ESC backslash)", () => {
    const bel = `\x1b]8;;https://b.example\x07link\x1b]8;;\x07`;
    expect(collect(bel)[0]).toMatchObject({ uri: "https://b.example" });
  });

  it("captures an empty label when the link has no display text", () => {
    const links = collect(`${open("https://x")}${CLOSE}`);
    expect(links[0]).toMatchObject({ uri: "https://x", text: "" });
  });

  it("does not emit anything for a closer with no open link", () => {
    expect(collect(CLOSE)).toHaveLength(0);
  });

  it("does not emit a non-8 OSC (window title) as a link", () => {
    expect(collect(osc("0;some title"))).toHaveLength(0);
  });

  it("keeps the id= params out of the URI and still collects the link", () => {
    expect(collect(link("file:///tmp/a", "a.txt", "id=99"))[0]).toMatchObject({
      uri: "file:///tmp/a",
      text: "a.txt",
    });
  });

  it("preserves a URI containing semicolons", () => {
    expect(collect(link("https://h/p?a=1;b=2", "q"))[0].uri).toBe(
      "https://h/p?a=1;b=2",
    );
  });
});

describe("HyperlinkEngine — clean labels", () => {
  it("strips SGR color sequences embedded in the display text", () => {
    const styled = `${open("https://c")}\x1b[31mred\x1b[0m link${CLOSE}`;
    expect(collect(styled)[0].text).toBe("red link");
  });

  it("collapses multi-line label whitespace to single spaces", () => {
    const multi = `${open("https://m")}line one\nline two${CLOSE}`;
    expect(collect(multi)[0].text).toBe("line one line two");
  });

  it("ignores an unrelated OSC (title) inside the link's text", () => {
    const withTitle = `${open("https://t")}before${osc("2;new title")}after${CLOSE}`;
    expect(collect(withTitle)[0].text).toBe("beforeafter");
  });
});

describe("HyperlinkEngine — aggregation (the sidebar)", () => {
  it("deduplicates by URI and counts repeats", () => {
    const links = collect(
      link("https://dup", "first"),
      link("https://dup", "second"),
      link("https://dup", "third"),
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ uri: "https://dup", count: 3 });
  });

  it("keeps the FIRST non-empty label across repeats", () => {
    const links = collect(
      link("https://dup", "original"),
      link("https://dup", "later"),
    );
    expect(links[0].text).toBe("original");
  });

  it("backfills a label when the first sighting had none", () => {
    const links = collect(
      `${open("https://dup")}${CLOSE}`,
      link("https://dup", "named"),
    );
    expect(links[0].text).toBe("named");
  });

  it("orders the feed by recency (oldest-seen first)", () => {
    const links = collect(
      link("https://a", "a"),
      link("https://b", "b"),
      link("https://a", "a again"), // re-touches a → a is now most recent
    );
    expect(links.map((l) => l.uri)).toEqual(["https://b", "https://a"]);
  });

  it("tracks the most-recent pane as the jump target", () => {
    const engine = new HyperlinkEngine(1000);
    engine.pushBytes(1, enc(link("https://x", "from-1")));
    engine.pushBytes(2, enc(link("https://x", "from-2")));
    const entry = engine.links[0]!;
    expect(entry).toMatchObject({ uri: "https://x", count: 2, paneId: 2 });
  });

  it("counts distinct destinations from an `ls --hyperlink` style burst", () => {
    const burst = ["a", "b", "c", "d"]
      .map((n) => link(`file:///tmp/${n}`, `${n}.txt`))
      .join("  ");
    const links = collect(burst);
    expect(links).toHaveLength(4);
    expect(links.every((l) => l.count === 1)).toBe(true);
  });
});

describe("HyperlinkEngine — streaming across chunk boundaries", () => {
  it("frames a link split between opener and text+closer", () => {
    const whole = link("https://split", "label");
    const at = whole.indexOf("label");
    expect(collect(whole.slice(0, at), whole.slice(at))[0]).toMatchObject({
      uri: "https://split",
      text: "label",
    });
  });

  it("frames a link split in the MIDDLE of the URI", () => {
    const whole = link("https://example.com/deep/path", "x");
    const at = whole.indexOf("deep");
    expect(collect(whole.slice(0, at), whole.slice(at))[0].uri).toBe(
      "https://example.com/deep/path",
    );
  });

  it("frames a link split between the ESC and the backslash of ST", () => {
    // Opener ends in ESC \ ; cut between them so ST spans two chunks.
    const opener = open("https://st");
    const at = opener.length - 1; // just before the final backslash
    const links = collect(opener.slice(0, at), `${opener.slice(at)}t${CLOSE}`);
    expect(links[0]).toMatchObject({ uri: "https://st", text: "t" });
  });
});

describe("HyperlinkEngine — supersede and flush", () => {
  it("emits the previous link when a new opener supersedes it", () => {
    // First link's closer never arrives; a second opener starts.
    const stream = `${open("https://one")}one text${open("https://two")}two${CLOSE}`;
    const links = collect(stream);
    expect(links.map((l) => l.uri)).toEqual(["https://one", "https://two"]);
    expect(links.find((l) => l.uri === "https://one")?.text).toBe("one text");
  });

  it("does not emit a dangling open link until flushPane (quiescence)", () => {
    const engine = new HyperlinkEngine(1000);
    engine.pushBytes(PANE, enc(`${open("https://dangling")}some label`));
    expect(engine.links).toHaveLength(0); // closer never came

    engine.flushPane(PANE);
    expect(engine.links[0]).toMatchObject({
      uri: "https://dangling",
      text: "some label",
    });
  });

  it("flushPane is idempotent — a flushed link is not re-emitted", () => {
    const engine = new HyperlinkEngine(1000);
    engine.pushBytes(PANE, enc(`${open("https://x")}t`));
    engine.flushPane(PANE);
    engine.flushPane(PANE);
    expect(engine.links[0]?.count).toBe(1);
  });

  it("flushPane on an unknown pane is a no-op", () => {
    const engine = new HyperlinkEngine(1000);
    engine.flushPane(999);
    expect(engine.links).toHaveLength(0);
  });
});

describe("HyperlinkEngine — scope and safety", () => {
  it("collects any non-empty URI (scheme filtering is the view's job)", () => {
    // The engine does not editorialize; an unsafe scheme is still a framed link.
    // Clickability gating lives at the boundary, not here.
    expect(collect(link("javascript:alert(1)", "x"))[0].uri).toBe(
      "javascript:alert(1)",
    );
  });

  it("does NOT auto-detect a bare URL in plain text (OSC 8 only)", () => {
    expect(collect("visit https://not-a-link.example for info")).toHaveLength(0);
  });
});

describe("HyperlinkEngine — capacity, counts, clear", () => {
  it("evicts the least-recently-seen URI past capacity", () => {
    const engine = new HyperlinkEngine(2);
    engine.pushBytes(PANE, enc(link("https://1", "1")));
    engine.pushBytes(PANE, enc(link("https://2", "2")));
    engine.pushBytes(PANE, enc(link("https://3", "3"))); // evicts #1
    expect(engine.links.map((l) => l.uri)).toEqual([
      "https://2",
      "https://3",
    ]);
    expect(engine.linkCount).toBe(2);
  });

  it("reports the number of distinct panes tapped", () => {
    const engine = new HyperlinkEngine(1000);
    engine.pushBytes(1, enc(link("https://a", "a")));
    engine.pushBytes(2, enc("plain output, no links"));
    expect(engine.tappedPaneCount).toBe(2);
  });

  it("clear() drops links and per-pane carry-over", () => {
    const engine = new HyperlinkEngine(1000);
    engine.pushBytes(PANE, enc(link("https://a", "a")));
    engine.clear();
    expect(engine.links).toHaveLength(0);
    expect(engine.linkCount).toBe(0);
    expect(engine.tappedPaneCount).toBe(0);
  });
});
