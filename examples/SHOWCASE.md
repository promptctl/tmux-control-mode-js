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
- **Full-text search across all pane scrollback** — incremental index built from `capture-pane`, live updates as panes produce output. Stresses: history, throughput, multiplex breadth.
- **Cross-terminal regex matcher** — like `tail -f | grep` but across every pane in every session simultaneously, with grouped/highlighted hits. Stresses: throughput, multiplex breadth, parsing.
- **Inline image extraction** — sniff iTerm2 / Kitty / Sixel image escape sequences out of the byte stream, decode, render in the browser next to the terminal. Stresses: parsing depth.
- **Escape-code playground** — a UI to type/paste ANSI sequences and watch a live pane render them. Side-by-side raw bytes, parsed events, rendered cells. Stresses: parsing depth, input fidelity.
- **Record / replay of terminal sessions** — capture the byte stream + timing, scrub through it like a video. Stresses: recording, parsing, state reconciliation.

### New ideas

#### Observability / introspection
- **Live "tmux protocol inspector"** — a devtools-style panel showing every `%notification` flowing across the control-mode wire, with filters, timing, and a request/response correlation view for `command` calls. This is the *Wireshark for tmux control mode* — invaluable for debugging the library itself, and a perfect tutorial surface.
- **Pane activity heatmap** — grid view of all panes in all sessions, each cell pulsing with output rate. Click to focus. Demonstrates that the library can sustain many concurrent subscriptions cheaply.
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
