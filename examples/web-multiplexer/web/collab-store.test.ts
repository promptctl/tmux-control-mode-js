// Unit tests for CollabStore (./collab-store.ts). DOM-free: the store touches
// only `window.location.origin`, which we stub, so it runs under the root node
// vitest suite alongside the other demo-logic tests.

import { describe, it, expect, beforeAll } from "vitest";
import { CollabStore } from "./collab-store.ts";

beforeAll(() => {
  // The store derives its share link from window.location.origin. Provide a
  // minimal stub so the pure selection logic is testable without a DOM.
  (globalThis as { window?: { location: { origin: string } } }).window = {
    location: { origin: "http://localhost:44173" },
  };
});

describe("CollabStore", () => {
  it("starts with no pane selected and no share link", () => {
    const store = new CollabStore();
    expect(store.selectedPaneId).toBeNull();
    expect(store.viewerUrl).toBeNull();
  });

  it("derives a collab.html share link from the selected pane", () => {
    const store = new CollabStore();
    store.select(4);
    expect(store.selectedPaneId).toBe(4);
    expect(store.viewerUrl).toBe("http://localhost:44173/collab.html?pane=4");
  });

  it("clear() returns to the no-selection state", () => {
    const store = new CollabStore();
    store.select(9);
    store.clear();
    expect(store.selectedPaneId).toBeNull();
    expect(store.viewerUrl).toBeNull();
  });
});
