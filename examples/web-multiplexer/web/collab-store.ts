// examples/web-multiplexer/web/collab-store.ts
// Operator-side state for the collaborative-pane tab: which pane is open for
// collaboration, and the shareable link derived from it. Pure UI selection —
// the live read-write connection (the IO) is owned by the `CollabScreen` the
// view renders, not by this store. [LAW:decomposition] selection is state;
// the writable projection is IO; they are different parts.

import { makeAutoObservable } from "mobx";
import { collabViewerUrl } from "../shared/collab-frame.ts";

export class CollabStore {
  /** The pane opened for collaboration, or null before any choice. */
  selectedPaneId: number | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  select(paneId: number): void {
    this.selectedPaneId = paneId;
  }

  clear(): void {
    this.selectedPaneId = null;
  }

  /**
   * The link to hand a second browser — a page that can both watch AND type
   * into this pane. `null` until a pane is chosen. Derived from
   * `window.location.origin` so it is correct whether the demo is served from
   * the Vite dev server or the bridge host. [LAW:one-source-of-truth]
   */
  get viewerUrl(): string | null {
    return this.selectedPaneId === null
      ? null
      : collabViewerUrl(window.location.origin, this.selectedPaneId);
  }
}
