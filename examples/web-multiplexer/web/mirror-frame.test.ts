// Unit tests for the pure pane-mirror wire contract (../shared/mirror-frame.ts).
// Imports only pure code (TextDecoder/URLSearchParams), so it runs under the
// root node vitest suite alongside the other demo-logic tests.

import { describe, it, expect } from "vitest";
import {
  parseMirrorPane,
  mirrorViewerUrl,
  mirrorSocketUrl,
  buildMirrorSeed,
} from "../shared/mirror-frame.ts";

describe("parseMirrorPane", () => {
  it("parses the tmux-native %N form", () => {
    expect(parseMirrorPane("?pane=%3")).toBe(3);
  });

  it("parses a bare numeric pane id", () => {
    expect(parseMirrorPane("?pane=7")).toBe(7);
  });

  it("tolerates a missing leading question mark", () => {
    expect(parseMirrorPane("pane=%12")).toBe(12);
  });

  it("ignores other query parameters", () => {
    expect(parseMirrorPane("?foo=bar&pane=%4&baz=1")).toBe(4);
  });

  it("returns null when the pane param is absent", () => {
    expect(parseMirrorPane("?other=1")).toBeNull();
    expect(parseMirrorPane("")).toBeNull();
  });

  it("returns null for a non-numeric pane value rather than coercing to 0", () => {
    // [LAW:no-silent-failure] a garbage param must not become a phantom pane 0.
    expect(parseMirrorPane("?pane=abc")).toBeNull();
    expect(parseMirrorPane("?pane=%")).toBeNull();
    expect(parseMirrorPane("?pane=%-2")).toBeNull();
    expect(parseMirrorPane("?pane=")).toBeNull();
  });
});

describe("mirrorViewerUrl / mirrorSocketUrl", () => {
  it("builds a shareable viewer URL with a BARE pane id (no raw %, which breaks decodeURI)", () => {
    const url = mirrorViewerUrl("http://localhost:44173", 5);
    expect(url).toBe("http://localhost:44173/mirror.html?pane=5");
    expect(url).not.toContain("%");
    const search = url.slice(url.indexOf("?"));
    expect(parseMirrorPane(search)).toBe(5);
  });

  it("builds the mirror socket URL on a path distinct from the page, bare pane id", () => {
    expect(mirrorSocketUrl("ws://localhost:44173", 5)).toBe(
      "ws://localhost:44173/mirror-ws?pane=5",
    );
  });
});

describe("buildMirrorSeed", () => {
  const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

  it("leads with a clear so a fresh terminal paints a clean screen", () => {
    const out = decode(buildMirrorSeed(["hello"]));
    expect(out.startsWith("\x1b[H\x1b[2J\x1b[3J")).toBe(true);
  });

  it("joins captured rows with CRLF and preserves escape sequences", () => {
    const rows = ["\x1b[31mred\x1b[0m", "plain"];
    const out = decode(buildMirrorSeed(rows));
    expect(out).toBe("\x1b[H\x1b[2J\x1b[3J\x1b[31mred\x1b[0m\r\nplain");
  });

  it("emits only the clear for an empty capture (no spurious newline)", () => {
    expect(decode(buildMirrorSeed([]))).toBe("\x1b[H\x1b[2J\x1b[3J");
  });
});
