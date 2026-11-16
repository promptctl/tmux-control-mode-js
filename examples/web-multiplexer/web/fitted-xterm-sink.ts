// examples/web-multiplexer/web/fitted-xterm-sink.ts
//
// An `XtermSink` whose font shrinks until the pane's grid fits its container,
// for the demo's single-pane screens (mirror, collab, recorder, time machine,
// sync scroll, escape playground). `setFont(px)` sets the largest font; the
// solver the window terminal uses picks the font, re-run whenever the
// container, the grid or that largest font changes.
//
// [LAW:one-source-of-truth] The fit is the library's `solve` with tmux owning
//   the size, not a second font-fitting rule.

import {
  XtermSink,
  cellFontOf,
  createCellMeasure,
  parseSizing,
  solve,
  type XtermSinkOptions,
} from "./window-terminal-internals.ts";

const FONT_MIN = 6;
const DEFAULT_FONT_MAX = 14;
// Scrollback for the screens that write their own bytes (mirror, collab,
// recorder, time machine, sync scroll).
export const SCROLLBACK = 10000;

export class FittedXtermSink extends XtermSink {
  private readonly box: HTMLElement;
  private readonly measure: ReturnType<typeof createCellMeasure>;
  private readonly observer: ResizeObserver;
  private readonly offMetrics: () => void;
  private maxFont: number;

  constructor(opts: XtermSinkOptions) {
    super(opts);
    this.box = opts.container;
    this.maxFont = opts.fontSize ?? DEFAULT_FONT_MAX;
    const win = opts.container.ownerDocument.defaultView;
    if (win === null) throw new RangeError("container must be in a window");
    this.measure = createCellMeasure(win);
    this.offMetrics = this.measure.onChange(() => this.refit());
    this.onRendererChange(() => this.refit());
    // The grid is xterm's own: `resize()` reaches it behind the bytes
    // written before it, so the font follows when xterm actually resizes.
    this.terminal.onResize(() => this.refit());
    this.observer = new ResizeObserver(() => this.refit());
    this.observer.observe(opts.container);
  }

  override setFont(px: number): void {
    this.maxFont = px;
    this.refit();
  }

  override dispose(): void {
    this.observer.disconnect();
    this.offMetrics();
    this.measure.dispose();
    super.dispose();
  }

  private refit(): void {
    const solution = solve(
      parseSizing({
        window: "tmux",
        font: { min: Math.min(FONT_MIN, this.maxFont), max: this.maxFont },
        fit: "both",
      }),
      { width: this.box.clientWidth, height: this.box.clientHeight },
      this.measure.cellAt(cellFontOf(this.terminal.options), this.renderer),
      { cols: this.terminal.cols, rows: this.terminal.rows },
    );
    super.setFont(solution.font);
  }
}
