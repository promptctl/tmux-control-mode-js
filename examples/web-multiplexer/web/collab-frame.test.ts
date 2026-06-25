// Unit tests for the pure collaborative-pane wire contract
// (../shared/collab-frame.ts). Imports only pure code, so it runs under the
// root node vitest suite alongside the other demo-logic tests.

import { describe, it, expect } from "vitest";
import {
  parseCollabKeys,
  collabViewerUrl,
  collabSocketUrl,
} from "../shared/collab-frame.ts";
import { parseMirrorPane } from "../shared/mirror-frame.ts";

describe("parseCollabKeys", () => {
  it("extracts the keystrokes from a well-formed keys frame", () => {
    expect(parseCollabKeys(JSON.stringify({ kind: "keys", keys: "ls\r" }))).toBe(
      "ls\r",
    );
  });

  it("preserves control sequences byte-for-byte (escape, CR)", () => {
    const keys = "\x1b[Aecho\r";
    expect(parseCollabKeys(JSON.stringify({ kind: "keys", keys }))).toBe(keys);
  });

  it("accepts an empty-string keystroke (a no-op the encoder collapses later)", () => {
    // [LAW:no-silent-failure] empty STRING is a valid frame (distinct from a
    // malformed one); the send path turns it into a synthetic success.
    expect(parseCollabKeys(JSON.stringify({ kind: "keys", keys: "" }))).toBe("");
  });

  it("returns null for malformed JSON rather than coercing", () => {
    expect(parseCollabKeys("{not json")).toBeNull();
  });

  it("returns null for the wrong frame kind", () => {
    expect(parseCollabKeys(JSON.stringify({ kind: "execute", keys: "x" }))).toBeNull();
  });

  it("returns null when keys is missing or not a string", () => {
    expect(parseCollabKeys(JSON.stringify({ kind: "keys" }))).toBeNull();
    expect(parseCollabKeys(JSON.stringify({ kind: "keys", keys: 7 }))).toBeNull();
  });

  it("returns null for a non-object frame", () => {
    expect(parseCollabKeys(JSON.stringify("keys"))).toBeNull();
    expect(parseCollabKeys(JSON.stringify(null))).toBeNull();
  });
});

describe("collabViewerUrl / collabSocketUrl", () => {
  it("builds a shareable page URL with a BARE pane id (no raw %, which breaks decodeURI)", () => {
    const url = collabViewerUrl("http://localhost:44173", 5);
    expect(url).toBe("http://localhost:44173/collab.html?pane=5");
    expect(url).not.toContain("%");
    // The standalone page reads the pane back with the mirror's own parser.
    expect(parseMirrorPane(url.slice(url.indexOf("?")))).toBe(5);
  });

  it("builds the collab socket URL on a path distinct from the page, bare pane id", () => {
    expect(collabSocketUrl("ws://localhost:44173", 5)).toBe(
      "ws://localhost:44173/collab-ws?pane=5",
    );
  });
});
