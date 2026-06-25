// examples/web-multiplexer/web/mirror-store.ts
// Operator-side state for the pane-mirror tab: which pane is being mirrored,
// and the shareable viewer URL derived from it. Pure UI selection — the live
// mirror connection (the IO) is owned by the `MirrorScreen` the view renders,
// not by this store. [LAW:decomposition] selection is state; projection is IO;
// they are different parts.

import { makeAutoObservable } from "mobx";
import { mirrorViewerUrl } from "../shared/mirror-frame.ts";

export class MirrorStore {
  /** The pane the operator chose to mirror, or null before any choice. */
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
   * The link to hand a second browser. `null` until a pane is chosen. Derived
   * from `window.location.origin` so it is correct whether the demo is served
   * from the Vite dev server or the bridge host. [LAW:one-source-of-truth]
   */
  get viewerUrl(): string | null {
    return this.selectedPaneId === null
      ? null
      : mirrorViewerUrl(window.location.origin, this.selectedPaneId);
  }
}
