// Unit tests for the pure collaborative-pane wire contract
// (../shared/collab-frame.ts). Imports only pure code, so it runs under the
// root node vitest suite alongside the other demo-logic tests.

import { describe, it, expect } from "vitest";
import { collabViewerUrl, collabSocketUrl } from "../shared/collab-frame.ts";
import { parseMirrorPane } from "../shared/mirror-frame.ts";

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
