# Showcase / Demo Strategy

The `examples/` directory is not a toy. It serves three jobs at once:

1. **Edge-case validation** — every demo stresses parts of the API the unit tests can't reach (timing, backpressure, multi-pane coordination, real terminal output).
2. **Limitation discovery** — when a demo is awkward to write, that awkwardness *is* the feedback. It tells us where the library's shape is wrong, where a missing primitive lives, or where an invariant should be hoisted into the core.
3. **Canonical reference** — these are the examples users will copy from. Treat every line as the public face of the project. No shortcuts, no "good enough for a demo," no `any`, no swallowed errors.

A good demo is one that **could not reasonably exist without tmux control mode** — i.e. would be absurd or impossible with one PTY per pane. Lean into that asymmetry. If the same thing is easy with `node-pty`, it's a weak demo.

---

## Axes of coverage

When picking demos, try to span these axes so the showcase doubles as informal conformance:

| Axis | What it stresses |
|---|---|
| **Throughput** | High-rate output, backpressure, parser perf, frame coalescing |
| **Multiplex breadth** | Many panes, many windows, many sessions at once |
| **Control-mode commands** | `%output`, `%layout-change`, `%window-add`, `%session-changed`, `%exit`, etc. |
| **History / scrollback** | `capture-pane -p -S -` ranges, history search, incremental indexing |
| **Input fidelity** | Keystrokes, paste, mouse, bracketed paste, modifier-encoded keys |
| **State reconciliation** | Reconnect / catchup / out-of-order events |
| **Parsing depth** | ANSI/CSI/OSC/DCS/SGR, Sixel, iTerm/Kitty image protocols, hyperlinks |
| **Recording / replay** | Deterministic byte-stream capture, time-travel debugging |

A demo that hits 3+ axes is gold. A demo that hits 1 is fine if that axis is otherwise uncovered.

---

## Demo ideas

### Already on the table
- **Full-text search across all pane scrollback** — *ships today* as the "Scrollback Search" mode of `examples/web-multiplexer/`. A trigram inverted index (`web/trigram-index.ts`) is seeded from `capture-pane -p -S - -E -` across every pane in every session and kept live by decoding `%output` into plain text (`web/ansi-text.ts`) and appending incrementally. Stresses: history, throughput, multiplex breadth.
  - *Limitation discovered:* deriving searchable text from the live `%output` byte stream needs ANSI-stripping, but neither `@promptctl/pane-terminal` nor the protocol package exposes a plain-text/line extraction primitive (only byte sinks, the xterm renderer, and `bytesToLatin1` / `decodeOctalEscapes`). The demo ships a local stripper; a reusable "terminal bytes → plain text rows" sink is a candidate primitive for the package. The stripper is line-granular, not a screen model, so `\r`-driven in-place redraws (progress bars, shell prompts) index as their raw concatenation rather than the final rendered line.
  - *Scope discovered:* `capture-pane` backfill reaches every pane on the server, but tmux streams live `%output` only for the **attached** session — so history is global while live updates follow the focused session. The UI states this honestly rather than implying global live indexing.
- **Cross-terminal regex matcher** — *ships today* as the "Regex Matcher" mode of `examples/web-multiplexer/`. A live `tail -f | grep` across every pane in every session at once: a compiled `RegExp` applied per completed line at ingestion (`web/regex-match-engine.ts`, pure + unit-tested), matches streaming into a bounded chronological feed grouped session › window › pane, click-to-jump. Stresses: throughput, multiplex breadth, parsing.
  - *Primitive discovered:* no part of the demo previously streamed more than ONE session's live output — tmux streams live `%output` only for the **attached** session, and the browser can't open tmux connections. "All sessions live" therefore required a NEW bridge-process **firehose**: `PaneFirehose` (`server/pane-firehose.ts`) taps every pane via `pipe-pane` to per-pane FIFOs (verified: reaches panes with zero clients attached), forwarded on a **dedicated channel** separate from attached `%output` (binary frame magic `0xF1` on WebSocket vs the library's `0x7F`; a `demo:firehose-bytes` IPC channel on Electron) so the regex feed is single-source and attached bytes never double-count. Implemented once on the shared `TmuxBridge` contract for BOTH transports.
  - *Axis separation from scrollback search:* search is substring-over-an-indexed-corpus (passive, query-time, trigram-narrowed); this is pattern-first LIVE streaming (a regex can't be trigram-prefiltered in general). Different operation, different axis.
- **Inline image extraction** — *ships today* as the "Image Extractor" mode of `examples/web-multiplexer/`. A streaming sniffer pulls iTerm2 (OSC 1337), Kitty (APC `_G` graphics) and Sixel (DCS) image escape sequences out of the raw byte stream of every pane in every session, decodes them (`web/image-extract-engine.ts`, pure + unit-tested against ImageMagick-generated fixtures), and renders the images in a gallery grouped session › window › pane, click-to-jump. Stresses: parsing depth.
  - *Why the firehose is mandatory, not optional:* tmux's own screen emulator consumes graphics sequences it doesn't render, so the attached `%output` control-mode stream has them **stripped**. Only `pipe-pane` (the `0.2` firehose) taps the pane's pty *before* tmux's emulation, where the sequences survive byte-for-byte (verified live, tmux 3.6a). So this demo reuses `PaneFirehose` as its sole byte source — it does **not** build on `@promptctl/pane-terminal`, whose `PaneStream` sources the stripped `%output` and whose `XtermSink` renders a terminal grid, not decoded images. It is in the same "consumes raw bytes, renders a non-terminal view" family as the Inspector and the planned data sniffer.
  - *Parsing depth discovered:* a single image can be split across arbitrary firehose chunk boundaries — even between the `ESC` and the `\` of a String Terminator — and Kitty deliberately chunks large transfers (`m=1` … `m=0`). The decoder is therefore a resumable per-pane state machine that carries parser state across `pushBytes` calls and reassembles multi-chunk Kitty transfers, not a regex over a buffer. iTerm2 files and Kitty PNGs decode to encoded bytes (rendered via a blob `<img>`); Kitty raw frames and Sixel decode to an RGBA raster (painted to `<canvas>`).
- **Escape-code playground** — *ships today* as the "Escape Playground" mode of `examples/web-multiplexer/`. Type or paste ANSI/escape sequences (with `\e \x1b \033 \n \uHHHH` notation) and watch a real tmux pane render them, three columns side by side: raw bytes (hex + escaped), parsed events (a pure VT classifier — `web/escape-parse-engine.ts`, unit-tested — that labels CSI/SGR/OSC/ESC/DCS and decodes SGR colors into swatches), and the live rendered cells. Stresses: parsing depth, **input fidelity**.
  - *Axis discovered:* this is the only demo that exercises the **outbound** path. Every other demo passively observes `%output`; this one *sends*. The library's `sendKeys` encodes via `send-keys -H utf8HexBytes(s)` — every byte hex-encoded — so arbitrary control bytes (ESC, C0 controls) arrive byte-for-byte; the round-trip you watch is the proof of that fidelity. The playground is string-native by design: the bytes it displays and parses are exactly `TextEncoder.encode(interpreted)`, which is what `send-keys -H` transmits, so for the whole 7-bit ANSI repertoire what you see is what is sent.
  - *Why a scratch pane:* `send-keys` writes to a program's stdin; escape sequences only reach the screen when they appear in the pane's *output*. The playground spawns a dedicated window running `sh -c "stty raw; exec cat"` — a transparent stdin→stdout byte mirror — and sends to it, leaving the user's panes untouched. Killed on leaving the mode.
  - *Control-mode findings (verified live, tmux 3.6a — relevant to any demo that renders a dynamically-created pane):* (1) a control client with no terminal streams live `%output` only for the window it is **currently viewing**, so the playground `select-window`s its scratch window (and restores the prior view on exit) — a detached window's pane never reaches the renderer. (2) `@promptctl/pane-terminal`'s `XtermSink` buffers all bytes until its first `resize(cols,rows)`, which is driven by a per-pane size *subscription* that emits only on a size **change** — a freshly created window never changes size, so the demo queries the pane geometry and calls `sink.resize()` directly to paint the first byte. (3) xterm suspends rendering in a zero-height container, so the column layout must give the terminal a real (floored) height.
- **Record / replay of terminal sessions** — capture the byte stream + timing, scrub through it like a video. Stresses: recording, parsing, state reconciliation.

### New ideas

#### Observability / introspection

> The protocol inspector ("Wireshark for tmux control mode") and the pane activity heatmap are no longer ideas — both ship today as modes of `examples/web-multiplexer/` (see `CHANGELOG.md` and `README.md`). The remaining idea in this category:

- **"Who wrote this byte?" attribution** — hover any cell in the rendered terminal and see the exact `%output` chunk + timestamp + offset that produced it. Forces tight integration between the parser, the grid, and the raw stream.

#### Time travel / history
- **Scrollback time machine** — combine `capture-pane -e -p -S - -E -` snapshots with a recorded forward stream so you can scrub a pane backward *and* forward in time, including ANSI state. Most terminal recorders only do forward replay.
- **"Diff two moments"** — pick two points in a pane's history and show what changed (cells, cursor, modes). Useful for debugging TUIs.
- **Bisect a TUI bug** — given a recorded session where something broke, binary-search the byte stream to find the offending escape sequence. Pure showcase of the recording infrastructure.

#### Multiplexing power moves
- **Broadcast input with per-pane transforms** — type once, send to N panes, but transform per target (e.g. substitute `$HOST`). `tmux` has dumb broadcast; this would have smart broadcast.
- **Pane-graph dashboard** — render every pane in every session as a tile in a CSS grid, all live, all interactive. With 50+ panes this is a real stress test of the event pipeline.
- **Synchronized scrollback** — scroll one pane and N other "linked" panes scroll to the same timestamp. Requires per-pane time indexing.
- **Pane mirror to remote viewer** — read-only WebSocket bridge so a second browser can watch a pane live. Forces a clean separation between *source of truth* (server-side tmux client) and *projection* (browser).

#### Parsing / data extraction
- **Structured data sniffer** — watch the byte stream for things that look like JSON / CSV / tables and offer a "parse and render as a table" button next to them. Demonstrates that you can sit *between* the user and the terminal without disturbing it.
- **Hyperlink (OSC 8) sidebar** — collect every clickable link any pane has ever emitted into a global sidebar. Trivial with the parser, impossible without it.
- **Prompt detector** — heuristically (or via OSC 133) detect shell prompt boundaries and chunk pane history into discrete *commands* with their output. Now the demo can show "command palette: re-run any past command in any pane."

#### Testing / mocking
- **Mock tmux server** — a fake control-mode endpoint that replays a scripted scenario. Used for the library's own integration tests and as a tutorial harness ("learn the protocol without installing tmux").
- **Chaos mode** — inject latency, drops, partial frames, malformed escape sequences into the stream and watch the library cope. Doubles as a fuzzing harness.
- **Conformance dashboard** — a page that runs through every documented `%notification` and `command` and shows green/red against a live tmux. The demo *is* the conformance suite.

#### Slightly wild
- **Collaborative pane** — two browsers, one pane, both can type. CRDT-free because tmux is the source of truth — you just need to fan input in and output out. Demonstrates the library's claim that the server is authoritative.
- **AI co-pilot pane** — pipe a pane's recent output to an LLM and let it suggest the next command, with one-click insert. Shows off prompt detection + structured history extraction.
- **Terminal "reader mode"** — strip ANSI styling, reflow to page width, render as readable prose. Useful for log review. Trivial once parsing is solid.
- **WebGL terminal grid** — render thousands of cells across many panes at 60fps using a shared atlas. Stress test the throughput axis until it breaks, then fix what broke.

---

## Selection criteria

When picking the next demo to build, prefer ones that:
1. Cover an axis no existing demo covers.
2. Can only exist because of control mode (not just "a terminal in a browser").
3. Would force a real edge case in the library API to surface.
4. Are visually obvious in 5 seconds — a screenshot should sell it.

A demo that scores 4/4 is the next thing to build. 3/4 is a strong candidate. 2/4 is filler.
