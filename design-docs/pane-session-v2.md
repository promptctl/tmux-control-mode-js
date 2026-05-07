
  Design Proposal — @tmux-control-mode-js/pane-terminal

  TL;DR

  Standalone package: PaneStream (per-pane data carrier — cheap, 24 of these) + PaneTerminal React component
  (xterm-backed view — heavy, 1-4 of these). Component is pure: takes a stream as a prop, no global store
  dependency. State machine, seeding, and activity tracking live in the stream and survive view churn. Optimization
  is foundational: every decision below is shaped by the requirements that 24 streams must idle in <2MB, attach must
   paint in <100ms including round-trip, and a live byte must hit the screen within one frame.

  Hard requirements (foundational, non-negotiable)

  ┌───────────────────────────────────┬─────────────────────────────────────────────────────────┬───────────────┐
  │            Requirement            │                          Bound                          │  Enforcement  │
  ├───────────────────────────────────┼─────────────────────────────────────────────────────────┼───────────────┤
  │ Visibility toggle → first paint   │ <100ms p99 on M-series Mac, including tmux round-trip   │ Bench gates   │
  │                                   │                                                         │ CI            │
  ├───────────────────────────────────┼─────────────────────────────────────────────────────────┼───────────────┤
  │ Live byte → cell on screen        │ <16ms p99 (one frame at 60fps)                          │ Bench gates   │
  │                                   │                                                         │ CI            │
  ├───────────────────────────────────┼─────────────────────────────────────────────────────────┼───────────────┤
  │ 24 detached streams, 100KB/s      │ Heap delta over 60s <2MB; zero allocation in hot path   │ Bench gates   │
  │ aggregate output                  │                                                         │ CI            │
  ├───────────────────────────────────┼─────────────────────────────────────────────────────────┼───────────────┤
  │ Re-mount the view ×100 on the     │ First mount: 1 capture-pane. Mounts 2-100: 0.           │ Test gates CI │
  │ same stream                       │                                                         │               │
  ├───────────────────────────────────┼─────────────────────────────────────────────────────────┼───────────────┤
  │ Non-UTF8 bytes round-trip         │ Mouse reports, raw 8-bit, CSI binary params arrive      │ Test gates CI │
  │                                   │ byte-identical                                          │               │
  ├───────────────────────────────────┼─────────────────────────────────────────────────────────┼───────────────┤
  │ dispose() reclaim                 │ Heap returns to within 1MB of pre-construction          │ Bench gates   │
  │                                   │                                                         │ CI            │
  ├───────────────────────────────────┼─────────────────────────────────────────────────────────┼───────────────┤
  │ Reconnect with N attached streams │ First visible stream paints in <100ms; total burst      │ Bench gates   │
  │                                   │ <50ms tmux serialization                                │ CI            │
  └───────────────────────────────────┴─────────────────────────────────────────────────────────┴───────────────┘

  These benchmarks land in step 1 of the migration and run in CI. Regressing any bound fails the build.

  ---
  Foundational optimizations (built in, not deferred)

  O1 — Visible-only seed by default; deep history is opt-in

  capture-pane -e -p (visible screen only) is ~5ms; capture-pane -e -p -S - (full scrollback) on a 100k-line pane is
   ~50-200ms. Default attach uses visible-only. Consumers that need history opt in via historyLines: number at
  stream construction. Single capture call per attach in either case — no two-phase.

  This makes the 24/4 case attach-instant by construction. The debug surface (which wants history) opts in
  explicitly.

  O2 — Stream subscribes on construction, not on attach

  client.onEvent('output', …) is registered in the PaneStream constructor. Tracked-but-detached panes are already
  counting bytes; attach just flips the listener's mode from "update activity counter" to "buffer (during seeding) /
   forward (when live)". No subscription churn at the tmux protocol layer on visibility toggles.

  O3 — Bytes are bytes everywhere; zero decoding in pipeline

  Uint8Array from client.onEvent → stream (filter by paneId, no copy) → sink.write(Uint8Array) →
  xterm.write(Uint8Array). xterm.js accepts Uint8Array natively. No TextDecoder in any hot path. IPC carries
  Uint8Array directly via Electron structured clone (one memcpy at the process boundary, unavoidable; one zero
  allocations beyond that).

  This single decision makes the hot path allocation-free per byte and eliminates the U+FFFD corruption that
  TextDecoder('utf-8') introduces on mouse reports and 8-bit control codes.

  O4 — IPC binary path uses MessageChannelMain

  The chunk-forwarding channel from main → renderer uses MessageChannelMain (Electron's port-based binary IPC), not
  webContents.send. Lower per-message overhead than the framework path; binary Uint8Array payloads transfer with one
   memcpy. Setup cost is one-time per renderer.

  O5 — React renders zero times on the byte path

  <PaneTerminal> renders once on mount, wires xterm in useEffect with stable deps, and re-renders only on prop
  changes (font, theme, etc.). xterm draws itself; React is fully on the cold path. No re-render on byte arrival, no
   re-render on activity event, no re-render on resize.

  O6 — Reconnect re-seeds are staggered by visibility priority

  On client.state === 'ready' after disconnect, the library queues re-seeds in this order: (1) attached streams
  whose sink is currently visible (document.visibilityState === 'visible' AND container has non-zero box), (2) other
   attached streams, (3) detached streams (which need nothing). Tmux is single-threaded; concurrency >1 doesn't help
   — sequential dispatch in priority order is optimal. First visible stream paints in <100ms regardless of fleet
  size.

  O7 — Activity events are coalesced

  Detached-stream byte arrivals update internal counters synchronously (a single integer increment + timestamp write
   — no allocation). The 'activity-changed' event fires at most every 100ms via a single shared setTimeout per
  stream, dispatched to listeners with a frozen snapshot.

  O8 — Font measurement is module-scoped and font-load-aware

  Char-cell dimensions measured once per (fontFamily, fontWeight) pair via a hidden probe; cached at module scope.
  document.fonts.load() triggers a single re-measure when the custom font finishes loading. XtermSink.fitFont() is
  pure arithmetic against the cache — no DOM measurement on the hot path.

  O9 — Container resize → font fit, throttled to rAF

  ResizeObserver callback writes (w, h) to a ref; an outstanding requestAnimationFrame dispatches at most one
  fitFont() + setFontSize() per frame. No xterm resize storm during window drag.

  O10 — Sink-to-stream wiring is stable across re-renders

  PaneTerminal's xterm lifecycle uses useEffect(…, [stream]) with the stream as the only dep. Style/theme changes
  update the live terminal in place via xterm's options setter — no teardown/rebuild. Stream identity changes mean a
   different pane and DO rebuild; that's the only path that does.

  ---
  Six load-bearing design decisions

  1. Detached streams hold no bytes; tmux owns scrollback

  Storing a 10k-line headless VT parser per stream is ~12MB × 24 = ~280MB. Storing raw bytes corrupts replay (escape
   sequences are stateful). Delegating scrollback to tmux and re-fetching via capture-pane is the only design that
  meets the 2MB memory bound for 24 streams. O1 makes the round-trip cost negligible for the default case.

  2. Seed-then-live state machine in the stream

  States: idle → seeding → live, plus detached and disposed. During seeding, live output events buffer into
  Uint8Array[]. When capture-pane and cursor query both resolve, the sink receives seed(captured, cursor) in one
  synchronous step that drains the buffer and flips state to live. No await between the seed write and the state
  flip — no live byte interleaves the seed.

  3. tmux is the size authority; library is single-mode

  The library renders at whatever cols × rows tmux reports for the pane. No FitAddon. Font fits the container; tmux
  geometry is independent. Single-pane fullscreen apps call client.setSize() themselves at the app level when their
  layout changes; the stream observes the resulting layout-change and resizes.

  Encoding "xterm drives tmux size" as a library mode creates a foot-gun (tmux has one client size; multiple sinks
  issuing refresh-client -C is an inherent conflict). Single-mode keeps the library correct.

  4. Activity counter for invisible panes; no second event channel

  Detached streams listen on the same output events as live streams. They update lastByteAt and bytesSinceLastAttach
   synchronously and emit 'activity-changed' per O7. UI badges, sort-by-recent, idle detection — all drive off this
  without paying any per-byte React cost.

  5. Component is pure; reactivity adapters live in the consumer

  <PaneTerminal stream={…} /> takes a stream prop. No mobx, no zustand, no global. Consumer's reactive layer wraps
  the stream's events/getters in their idiom. This is the precondition for the same component dropping into both
  promptctl (zustand) and the demo (mobx) without forking.

  6. Cursor restore via display-message, in parallel with capture

  Promise.all([client.execute('capture-pane …'), client.execute('display-message -p \'#{cursor_x};#{cursor_y}\'')])
  — one round-trip's wall time, two answers. Sink writes captured text, then ANSI CUP \x1b[<row>;<col>H to land the
  cursor on the live shell prompt rather than the bottom of the captured buffer.

  ---
  Architecture

                  ┌────────────────────────────────────┐
                  │  TmuxClient  (main library)        │
                  │   .onEvent('output', {paneId, …})  │
                  └──────────┬─────────────────────────┘
                             │  Uint8Array, no decode
                ┌────────────┴───────────────────┐
                │  PaneStream  ×N tracked         │   no DOM, no xterm
                │   subscribes on construction    │   ~500 bytes each
                │   state machine + activity      │   owned by app
                │   single capture per attach     │
                └───┬─────────────────────────────┘
                    │  (only for visible panes)
                    ▼
                ┌──────────────────────┐
                │  TerminalSink  iface │
                └──────┬───────────────┘
          ┌────────────┴────────────┐
          ▼                         ▼
    ┌──────────────┐          ┌──────────────────┐
    │ XtermSink    │          │ BufferingSink    │
    │  + xterm.js  │          │  (test helper)   │
    │  + DOM       │          └──────────────────┘
    └──────┬───────┘
           ▲
           │ used by
           │
    ┌────────────────────────────────┐
    │ <PaneTerminal stream={…} />    │   React adapter
    │ mountPaneTerminal(stream, …)   │   vanilla adapter
    └────────────────────────────────┘

  ---
  API surface (final)

  // pane-terminal/stream ───────────────────────────────────────────────
  export type PaneStreamState =
    | 'idle' | 'seeding' | 'live' | 'detached' | 'disposed'

  export interface PaneActivity {
    readonly lastByteAt: number
    readonly bytesSinceLastAttach: number
  }

  export class PaneStream {
    readonly paneId: number
    get state(): PaneStreamState
    get activity(): PaneActivity

    constructor(opts: {
      client: TmuxClient
      paneId: number
      /** Lines of scrollback to include in the seed. Default 0 (visible only).
       *  Higher values trade attach latency for history depth. */
      historyLines?: number
      /** Coalescing window for 'activity-changed'. Default 100ms. */
      activityThrottleMs?: number
    })

    attach(sink: TerminalSink): void
    detach(): void
    sendKeys(data: string): Promise<void>

    on(ev: 'state-changed',    h: (s: PaneStreamState) => void): () => void
    on(ev: 'activity-changed', h: (a: PaneActivity)    => void): () => void
    on(ev: 'reconnected',      h: ()                   => void): () => void

    dispose(): void
  }

  // pane-terminal/sink ─────────────────────────────────────────────────
  export interface TerminalSink {
    seed(captured: Uint8Array, cursor: { col: number; row: number } | null): void
    write(data: Uint8Array): void
    resize(cols: number, rows: number): void
    clear(): void
  }
  export class BufferingSink implements TerminalSink { /* records calls */ }

  // pane-terminal/xterm-sink ───────────────────────────────────────────
  export class XtermSink implements TerminalSink {
    constructor(opts: {
      container: HTMLElement
      fontFamily?: string
      fontSize?: number
      fontMin?: number
      fontMax?: number
      scrollback?: number
      theme?: { background?: string; foreground?: string }
    })
    onData(h: (data: string) => void): () => void
    fitFont(): number
    setFontSize(px: number): void
    focus(): void
    readonly terminal: import('@xterm/xterm').Terminal
    dispose(): void
  }

  // pane-terminal/react ────────────────────────────────────────────────
  export function PaneTerminal(props: {
    stream: PaneStream
    fontFamily?: string
    fontSize?: number
    scrollback?: number
    theme?: { background?: string; foreground?: string }
    autoFocus?: boolean
    className?: string
  }): JSX.Element

  // pane-terminal/vanilla ──────────────────────────────────────────────
  export function mountPaneTerminal(
    stream: PaneStream,
    container: HTMLElement,
    opts?: Omit<XtermSinkOptions, 'container'>,
  ): { sink: XtermSink; dispose(): void }

  Subpath imports keep xterm.js out of consumers that only want headless tracking:

  import { PaneStream } from '@tmux-control-mode-js/pane-terminal/stream'        // no xterm
  import { PaneTerminal } from '@tmux-control-mode-js/pane-terminal/react'       // brings xterm
  import { BufferingSink } from '@tmux-control-mode-js/pane-terminal/sink'       // for tests

  ---
  What promptctl looks like after adoption

  Renderer: src/renderer/tmux/PaneTerminal.tsx and its tests delete. A thin zustand bridge constructs a PaneStream
  per tracked pane, exposes activity for UI, and renders <PaneTerminal stream={…} /> for visible ones.

  Main: src/main/tmux/output-router.ts collapses from ~190 LOC to a MessageChannelMain byte-forwarder per renderer.
  No subscribe registry, no capture, no TextDecoder. The capture moves into the stream (renderer-side), where O6
  staggering lives.

  ---
  Migration plan

  1. Build the package in tmux-control-mode-js/packages/pane-terminal/. Subpath exports as above.
  2. Land the benchmarks first. All seven hard requirements pinned as tests that gate CI. The benchmarks are written
   before the implementation — they're the spec.
  3. Implement against the benchmarks. Each foundational optimization (O1-O10) lands with a regression test. No
  optimization is "deferred" — they're co-equal with feature code.
  4. Rewire the demo. Delete examples/web-multiplexer/web/pane-terminal.ts. PaneCell constructs a PaneStream and
  renders <PaneTerminal>. MobX bridges activity / state events. Demo passes the same benchmarks.
  5. Cut a version of the package.
  6. Adopt in promptctl. Renderer: delete the local PaneTerminal and tests, add a thin store bridge. Main: replace
  output-router capture+decode with MessageChannelMain byte-forward. Promptctl's existing test gate runs the same
  benchmarks against the integrated path.

  Step 2 is the most important step. The benchmarks are the contract.

  ---
  Decisions I'm making (not asking)

  - historyLines default = 0. Visible-only seed is the common case. Debug surface and any "review the scrollback" UI
   opt in explicitly.
  - Reconnect = auto re-seed, staggered by visibility (O6). Consumer doesn't drive this; the library guarantees the
  latency bound.
  - Activity event = { lastByteAt, bytesSinceLastAttach }. v1 minimum. Line counts, regex matches, idle-detection
  are higher-level concerns the consumer composes from this.
  - Cursor shape and visible/invisible state included in the cursor restore (cheap to add via display-message
  #{cursor_flag}).
  - Bracketed-paste / mouse reporting / focus events verified by explicit demo tests in step 4.

  No open questions. Ready to start step 1 on your sign-off.

✻ Sautéed for 2m 39s

※ recap: Goal: design a portable PaneTerminal package for tmux-control-mode-js to replace promptctl's xterm code and
   avoid re-fixing the same bugs. Current task: design proposal is finalized with foundational optimizations baked
  in. Next action: your sign-off to start step 1 (build the package skeleton and benchmarks).
