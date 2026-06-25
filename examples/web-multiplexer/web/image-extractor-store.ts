// examples/web-multiplexer/web/image-extractor-store.ts
//
// ImageExtractorStore — the IO boundary for the inline-image extractor. It owns
// three effects and nothing else: (1) the firehose start/stop lifecycle, (2)
// accumulating raw firehose chunks per pane, (3) draining them into the pure
// ImageExtractEngine on a ticker. The decode/parse logic it drives is pure and
// unit-tested in isolation.
//
// [LAW:effects-at-boundaries] All IO (bridge.startFirehose / onFirehose /
//   onState, the ticker) lives here; the engine is a pure function of the byte
//   stream. Blob URLs and <canvas>/<img> rendering live one layer further out
//   in the view.
// [LAW:one-source-of-truth] The engine's ring IS the image feed. `version` is a
//   change-signal (the engine isn't observable), not a second copy of it.
// [LAW:dataflow-not-control-flow] Every firehose chunk is accumulated; every
//   tick drains the accumulator through the same engine.pushBytes pipeline.

import { makeAutoObservable, runInAction } from "mobx";
import type { TmuxBridge } from "./bridge.ts";
import {
  ImageExtractEngine,
  type ExtractedImage,
} from "./image-extract-engine.ts";

/** Drain the firehose byte accumulator into the engine at this cadence. */
const TICK_INTERVAL_MS = 150;
/** Max images retained in the gallery (FIFO). Bounds memory. */
const IMAGE_CAP = 400;

export type { ExtractedImage, ImagePayload } from "./image-extract-engine.ts";

export class ImageExtractorStore {
  /** True while the firehose taps are open (image mode is active). */
  active = false;
  /**
   * [LAW:one-source-of-truth] Change-signal for the non-observable engine.
   * Bumped once per drain tick so the `images` computed recomputes without
   * making the engine's internals observable.
   */
  version = 0;

  private readonly engine = new ImageExtractEngine(IMAGE_CAP);
  private readonly accum = new Map<number, Uint8Array[]>();
  private timerHandle: number | null = null;
  private readonly disposeOnFirehose: () => void;
  private readonly disposeOnState: () => void;

  constructor(private readonly bridge: TmuxBridge) {
    makeAutoObservable<this, "engine" | "accum" | "bridge" | "timerHandle">(
      this,
      { engine: false, accum: false, bridge: false, timerHandle: false },
    );

    this.disposeOnFirehose = bridge.onFirehose((paneId, data) => {
      let chunks = this.accum.get(paneId);
      if (chunks === undefined) {
        chunks = [];
        this.accum.set(paneId, chunks);
      }
      // The firehose chunk is a shared/transient buffer; copy before retaining.
      chunks.push(data.slice());
    });

    // A reconnect drops the previous server's taps; re-open the firehose if
    // image mode is still active so the feed survives a socket swap / reconnect.
    this.disposeOnState = bridge.onState((state) => {
      if (state === "ready" && this.active) this.bridge.startFirehose();
    });

    this.timerHandle = setInterval(
      () => this.tick(),
      TICK_INTERVAL_MS,
    ) as unknown as number;
  }

  dispose(): void {
    this.disposeOnFirehose();
    this.disposeOnState();
    if (this.timerHandle !== null) {
      clearInterval(
        this.timerHandle as unknown as ReturnType<typeof setInterval>,
      );
      this.timerHandle = null;
    }
    if (this.active) this.bridge.stopFirehose();
  }

  // -------------------------------------------------------------------------
  // Lifecycle (firehose taps)
  // -------------------------------------------------------------------------

  /** Open the firehose taps. Idempotent. Called on entering image mode. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.bridge.startFirehose();
  }

  /**
   * Close the firehose taps and free the feed. Called on leaving image mode —
   * idle panes shouldn't keep paying the pipe-pane cost. The decoded gallery
   * repopulates live on the next `start`.
   */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.bridge.stopFirehose();
    this.accum.clear();
    this.engine.clear();
    this.version++;
  }

  // -------------------------------------------------------------------------
  // Live ingestion
  // -------------------------------------------------------------------------

  private tick(): void {
    if (this.accum.size === 0) return;
    runInAction(() => {
      for (const [paneId, chunks] of this.accum) {
        for (const chunk of chunks) this.engine.pushBytes(paneId, chunk);
      }
      this.accum.clear();
      // Bump unconditionally: even a no-image drain can change tappedPaneCount.
      this.version++;
    });
  }

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  /** The live, bounded image feed (chronological). */
  get images(): readonly ExtractedImage[] {
    void this.version;
    return this.engine.images;
  }

  /** Number of panes that have produced bytes since the firehose opened. */
  get tappedPaneCount(): number {
    void this.version;
    return this.engine.tappedPaneCount;
  }

  /** Number of images currently in the gallery. */
  get imageCount(): number {
    void this.version;
    return this.engine.images.length;
  }
}
