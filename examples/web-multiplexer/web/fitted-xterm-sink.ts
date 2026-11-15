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
  createCellMeasure,
  parseSizing,
  solve,
  type XtermSinkOptions,
} from "./window-terminal-internals.ts";

const FONT_MIN = 6;
const DEFAULT_FONT_MAX = 14;

export class FittedXtermSink extends XtermSink {
  private readonly box: HTMLElement;
  private readonly measure: ReturnType<typeof createCellMeasure>;
  private readonly observer: ResizeObserver;
  private readonly offMetrics: () => void;
  private maxFont: number;
  private grid: { cols: number; rows: number } | null = null;

  constructor(opts: XtermSinkOptions) {
    super(opts);
    this.box = opts.container;
    this.maxFont = opts.fontSize ?? DEFAULT_FONT_MAX;
    const win = opts.container.ownerDocument.defaultView;
    if (win === null) throw new RangeError("container must be in a window");
    this.measure = createCellMeasure(win);
    this.offMetrics = this.measure.onChange(() => this.refit());
    this.observer = new ResizeObserver(() => this.refit());
    this.observer.observe(opts.container);
  }

  override resize(cols: number, rows: number): void {
    super.resize(cols, rows);
    this.grid = { cols, rows };
    this.refit();
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
    if (this.grid === null) return;
    const o = this.terminal.options;
    const solution = solve(
      parseSizing({
        window: "tmux",
        font: { min: Math.min(FONT_MIN, this.maxFont), max: this.maxFont },
        fit: "both",
      }),
      { width: this.box.clientWidth, height: this.box.clientHeight },
      this.measure.cellAt(o.fontFamily ?? "monospace", o.lineHeight ?? 1),
      this.grid,
    );
    super.setFont(solution.font);
  }
}
