// packages/pane-terminal/src/xterm-sink/visibility-tracker.ts
//
// VisibilityTracker — "is this terminal's container actually on-screen right
// now?", extracted from XtermSink as an independent collaborator.
//
// Two orthogonal signals combine to one answer:
//   - IntersectionObserver: is the container within the viewport?
//   - document.visibilityState: is the tab/window foregrounded?
// A terminal is visible only when BOTH hold. XtermStream uses this to skip
// paint work (e.g. font fitting, scroll) for panes the user cannot see.
//
// [LAW:decomposition] Visibility has nothing to do with seeding, resize, or
//   font fitting — it is one coherent concern with its own observer lifecycle,
//   so it is its own part with its own dispose().
// [LAW:single-enforcer] One IntersectionObserver, one visibilitychange
//   listener; both torn down in dispose().

/**
 * Tracks on-screen visibility of a container element. Constructible in
 * environments without `IntersectionObserver` / `document` (e.g. tests, SSR):
 * the missing signal defaults to visible, so a bare-DOM single-pane host still
 * reports the terminal as visible.
 */
export class VisibilityTracker {
  private io: IntersectionObserver | null = null;
  // Default true until the observers report otherwise — keeps hosts without
  // IntersectionObserver support (happy-dom) treating the container as visible.
  private intersecting = true;
  private docVisible = true;

  private readonly onDocumentVisibility = (): void => {
    this.docVisible = isDocumentVisible();
  };

  constructor(container: HTMLElement) {
    // [LAW:dataflow-not-control-flow] The observer callbacks always run and
    //   write plain values; isVisible() reads them. There is no branch on
    //   "large enough" or "was visible before".
    if (typeof IntersectionObserver !== "undefined") {
      this.io = new IntersectionObserver((entries) => {
        const e = entries[0];
        if (e === undefined) return;
        this.intersecting = e.isIntersecting;
      });
      this.io.observe(container);
    }
    if (typeof document !== "undefined") {
      this.docVisible = isDocumentVisible();
      document.addEventListener("visibilitychange", this.onDocumentVisibility);
    }
  }

  /** Container within the viewport AND the tab foregrounded. */
  isVisible(): boolean {
    return this.intersecting && this.docVisible;
  }

  dispose(): void {
    if (this.io !== null) {
      this.io.disconnect();
      this.io = null;
    }
    if (typeof document !== "undefined") {
      document.removeEventListener(
        "visibilitychange",
        this.onDocumentVisibility,
      );
    }
  }
}

function isDocumentVisible(): boolean {
  if (typeof document === "undefined") return true;
  // `visibilityState` may be undefined in tests with bare DOMs; treat
  // anything-other-than-"hidden" as visible.
  return document.visibilityState !== "hidden";
}
