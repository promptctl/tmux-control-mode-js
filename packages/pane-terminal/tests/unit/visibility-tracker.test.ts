// packages/pane-terminal/tests/unit/visibility-tracker.test.ts
//
// Isolation tests for VisibilityTracker — the IntersectionObserver + document-
// visibility collaborator extracted from XtermSink (GM5 / tmux-complexity-lkg.7).
// Constructed standalone against a container element; assertions target only
// isVisible() and clean teardown.
//
// happy-dom provides `document` but no IntersectionObserver, so we install a
// controllable stub to drive the intersection signal deterministically.
//
// [LAW:behavior-not-structure] Assertions target isVisible() and observed
//   teardown effects — never the tracker's private fields.

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { VisibilityTracker } from "../../src/xterm-sink/visibility-tracker.js";

// Controllable IntersectionObserver stub. The most-recently-constructed
// instance is captured so a test can fire its callback with a chosen
// isIntersecting value.
interface StubIO {
  fire(isIntersecting: boolean): void;
  disconnect: ReturnType<typeof vi.fn>;
}
let lastIO: StubIO | null = null;
const realIO = globalThis.IntersectionObserver;

function installIOStub(): void {
  lastIO = null;
  globalThis.IntersectionObserver = class {
    private readonly cb: IntersectionObserverCallback;
    disconnect = vi.fn();
    constructor(cb: IntersectionObserverCallback) {
      this.cb = cb;
      lastIO = {
        fire: (isIntersecting: boolean) =>
          this.cb(
            [{ isIntersecting } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          ),
        disconnect: this.disconnect,
      };
    }
    observe = vi.fn();
    unobserve = vi.fn();
    takeRecords = vi.fn(() => []);
    root = null;
    rootMargin = "";
    thresholds = [];
  } as unknown as typeof IntersectionObserver;
}

function makeContainer(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  installIOStub();
  // Default the tab to visible for each test.
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

afterEach(() => {
  globalThis.IntersectionObserver = realIO;
  document.body.innerHTML = "";
});

describe("VisibilityTracker", () => {
  it("reports visible by default before any observer fires", () => {
    const tracker = new VisibilityTracker(makeContainer());
    expect(tracker.isVisible()).toBe(true);
    tracker.dispose();
  });

  it("reflects the intersection signal", () => {
    const tracker = new VisibilityTracker(makeContainer());
    lastIO?.fire(false);
    expect(tracker.isVisible()).toBe(false);
    lastIO?.fire(true);
    expect(tracker.isVisible()).toBe(true);
    tracker.dispose();
  });

  it("is not visible when the tab is hidden even if intersecting", () => {
    const tracker = new VisibilityTracker(makeContainer());
    lastIO?.fire(true);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(tracker.isVisible()).toBe(false);
    tracker.dispose();
  });

  it("dispose() disconnects the observer and stops reacting to visibilitychange", () => {
    const tracker = new VisibilityTracker(makeContainer());
    tracker.dispose();
    expect(lastIO?.disconnect).toHaveBeenCalledTimes(1);
    // After dispose, a visibilitychange must not flip the last-known state.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(tracker.isVisible()).toBe(true);
  });

  it("constructs without IntersectionObserver support (defaults visible)", () => {
    globalThis.IntersectionObserver =
      undefined as unknown as typeof IntersectionObserver;
    const tracker = new VisibilityTracker(makeContainer());
    expect(tracker.isVisible()).toBe(true);
    tracker.dispose();
  });
});
