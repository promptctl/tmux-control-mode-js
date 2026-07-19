# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); version numbers follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed — breaking

- `TmuxTransport.send()` returns `SendResult` (`{ ok: true } | { ok: false; reason: string }`)
  instead of `void`. A send failure is now a representable outcome rather than
  a silent no-op — every implementation (spawn, websocket, mock, chaos) must
  state whether the transport accepted the command. Consumers implementing
  `TmuxTransport` must update their `send()` return type; `TmuxClient.execute()`
  now rejects with the new `TransportSendError` when a send is refused.
- `TmuxClient.detach()` likewise returns `SendResult` instead of `void`, for the
  same reason — a refused detach is now observable instead of silently dropped.
- `TopologyRouter`'s constructor takes a required `reportTopologyError` reporter
  as its first argument (`new TopologyRouter(reportTopologyError, options?)`).
  The router is a pure substrate with no emitter, so a failed topology bootstrap
  is lifted to this seam and the transport adapter performs the emission. The
  reporter is mandatory by design: a router that silently drops bootstrap
  failures must not be constructible. External consumers constructing a
  `TopologyRouter` directly (an advanced path — building a custom transport
  adapter) must supply it.

### Added

- `topology-error` event on every `TmuxClient`-shaped connection, emitted when a
  topology bootstrap (`list-panes -a`) fails. Distinguishes "topology empty
  because bootstrap failed" from "topology empty because tmux has no panes" — a
  session/window-scoped consumer is no longer silently starved with no signal.
- `TransportClosedError`, thrown via Promise rejection when a command was
  queued or already inflight and the transport closed before tmux replied.
  Distinct from `TransportSendError` (the send was refused outright) and
  `TmuxCommandError` (tmux replied with `%error`).
- `pane-resume-failed` observability event on the WebSocket bridge server
  (`onEvent`) and a matching `onResumeFailure` hook on the Electron
  `MainBridgeOptions`, emitted when a live tmux refuses a pane's resume
  (`refresh-client -A %<pane>:continue`) while the watermark loop wants it
  flowing. Carries the pane id and a typed `BridgeError`. Both are opt-in: a
  host that does not observe them is making an informed choice — the bridge
  never swallows the failure internally. The `ResumeFailure` type is exported
  from the bridge-connection module and re-exported from Electron `main`.

### Fixed

- A failed topology bootstrap no longer silently starves session/window-scoped
  byte sinks. Previously the bootstrap's `list-panes -a` rejection was swallowed
  by a `catch {}`, leaving an empty topology that routed every session/window
  consumer to zero bytes with no error — indistinguishable from a quiet tmux.
  The failure now surfaces as a `topology-error` event, and the existing
  event-driven bootstrap triggers make recovery non-terminal. A superseded or
  post-close bootstrap rejection is suppressed (the newer bootstrap or the
  `connection-state: closed` event owns that outcome) so the signal stays
  truthful rather than crying wolf.
- A failed pane resume no longer strands the pane paused in tmux while the
  bridge's ledger claims it resumed. Previously `bridge-connection`'s
  `maybeResume` deleted the pane from its paused ledger _before_ the `continue`
  command settled and swallowed every rejection, so a transient failure on a
  live pane left it paused in tmux forever — no retry, no signal, the ledger
  lying that it had resumed. The ledger transition now follows the command's
  outcome: on success the pane leaves the ledger; on a connection-gone
  rejection (transport refused/closed — a moot pane on a dead connection) it is
  dropped quietly; on any live-tmux failure (`%error`, corrupted terminator) the
  pane stays paused so the next watermark crossing retries, and the failure is
  surfaced (see the `pane-resume-failed` / `onResumeFailure` additions above).
  The in-flight resume is guarded by the pane's flow-record identity, so a
  settling `continue` cannot disturb a re-paused pane from a newer episode
  (ABA-safe).
- `TmuxClient.execute()` promises no longer hang forever if the transport
  closes while the command is queued or inflight — every outstanding promise
  is now rejected with `TransportClosedError` when the transport closes.
- The `exit` event now fires exactly once per connection. Previously a
  graceful disconnect (tmux sends `%exit`, then the transport closes) fired
  it twice; a killed server that never gets to send `%exit` still fires it
  exactly once, synthesized from the transport's own close.
- `TmuxClient`'s `closed` connection state is now terminal, matching its
  documented contract: a data chunk delivered after the transport reports
  closed (a legitimate race under delayed/chaotic delivery) no longer
  resurrects `ready`.
- The bridge connectors (Electron, WebSocket) now classify `TransportClosedError`
  as the operational `BRIDGE_CLOSED`, matching `TransportSendError` — previously
  it fell through to the catch-all `BRIDGE_INTERNAL` (meant for bugs), so a
  bridge consumer branching on `BridgeError.code` would misreport a normal
  transport close as an internal error.
- Close dispatch is now exactly-once, with the first (truest) reason winning,
  across all three transports (spawn, websocket, mock) via a shared
  `CloseGate` — previously a second event could downgrade a real transport
  error (e.g. `spawnTmux`'s `ENOENT`, or a WebSocket abnormal-closure code) to
  a clean exit.
- The websocket transport distinguishes an explicit clean closure (code 1000)
  from a close that carried no data — only the latter falls back to the
  preceding `error` event's generic reason, so an unrelated non-fatal error
  before a genuinely clean close is no longer misreported as a transport
  error.
- An `EPIPE` write in the window between the child dying and its `close` event
  no longer crashes the host process.


## [0.1.0]

Initial public release. Implements the tmux control mode protocol as documented
in [`SPEC.md`](./SPEC.md), targeting tmux 3.2 or later. Wire-protocol conformance
was audited against tmux next-3.7 with **zero conformance bugs**.

Zero runtime dependencies (enforced at publish time). Ships `dist/` only.

### Added — core client & protocol

- `TmuxClient` with FIFO command/response correlation and a typed event emitter
  for every server→client message type the parser emits — see the `TmuxMessage`
  union in `src/protocol/types.ts` for the authoritative list (`src/client.ts`,
  `src/emitter.ts`).
- Streaming line-oriented parser with full response-block tracking
  (`src/protocol/parser.ts`).
- Wire-format encoder as the single source of truth for every client→server
  command (`src/protocol/encoder.ts`). Argument escaping via `tmuxEscape`.
- Octal escape decoder for `%output` data (`src/protocol/decode.ts`).
- Node.js `child_process` spawn transport with DCS framing primitives for a
  future PTY-backed `-CC` transport (`src/transport/spawn.ts`).
- Free-function command surface over `TmuxConnection` (not methods on
  `TmuxClient`): `listWindows`, `listPanes`, `sendKeys`, `splitWindow`,
  `setSize`, `setPaneAction`, `subscribeRaw`, `unsubscribe`, `setFlags`,
  `clearFlags`, `requestReport`, `queryClipboard`, `queryTmuxVersion`.

### Added — pane-output routing

- **`attachBytesSink(sink, options?)`** on every `TmuxClientLike`: a single entry
  point with a scope discriminator. Default scope is `serverScope` (all panes).
- **`BytesSink`** — the unified byte-consumer contract exported from the package
  root. `write(msg: PaneOutputMessage): void; end?(): void`.
- **`PaneScope`** — discriminated union with four arms: `serverScope`,
  `sessionScope(id)`, `windowScope(id)`, `paneScope(id)`. Exported as value
  factory functions and as a type.
- **`PaneTopologyManager`** — paneId→{sessionId,windowId} topology table, lazily
  bootstrapped and kept current by `window-add`, `window-close`, `layout-change`,
  and `sessions-changed` notifications.
- **`TopologyEpochTracker`** — epoch guard for async topology queries; prevents
  stale `list-panes` results from clobbering synchronous `window-close` updates.
- **`parsePaneListLine`** — parses one line of
  `list-panes -F '#{pane_id} #{window_id} #{session_id}'` output.
- **`SinkRegistry`** — scope-bifurcated dispatch, one bucket per scope kind;
  snapshot-before-write prevents re-entrant attach/detach from skipping or
  double-delivering a chunk.
- Topology bootstrap is lazy: fires only when a session- or window-scoped sink
  is attached, so server-scope and pane-scope consumers pay zero extra cost.

### Added — packaging & subpaths

- **`./browser` subpath** — the browser/Deno/Bun-safe protocol + pane-output
  core (`dist/browser.js`), with **zero Node coupling** (never pulls
  `node:child_process`). Non-Node consumers import this instead of the root entry.
- Subpath imports take the form `@promptctl/tmux-control-mode-js/<subpath>` where
  `<subpath>` is one of: `browser`, `protocol`, `keymap`, `electron/main`,
  `electron/renderer`, `websocket`, `websocket/server`, `websocket/client`,
  `websocket/protocol`, `websocket/transport`, `streams/web`, `streams/node` —
  see the `exports` map in `package.json` for the authoritative list.

### Added — tmux version compatibility

- Version-compatibility contract exported from both `.` and `./browser`:
  `MIN_TMUX_VERSION`, `REQUEST_REPORT_MIN_VERSION`, `parseTmuxVersion`,
  `meetsTmuxVersion`, `TmuxVersion`, `queryTmuxVersion`, and the typed
  `UnsupportedTmuxVersionError`. These are the machine-readable form of the
  README Compatibility floors.
- `requestReport` probes the running tmux version and rejects with
  `UnsupportedTmuxVersionError` on tmux 3.2–3.4 (`refresh-client -r` needs 3.5),
  instead of leaking tmux's raw unknown-flag `%error`. Adds one
  `display-message` round-trip per call.

### Tests & demo

- Unit suite plus an integration suite that runs against a real tmux process,
  gated by `TMUX_INTEGRATION=1`. `tests/integration/client.test.ts` is the
  spec-conformance gate (≥ one observation per major event in `SPEC.md` §23).
- Reference `examples/web-multiplexer/` demo with three modes: a full pane
  multiplexer, a protocol inspector (Wireshark for control mode), and an
  activity heatmap across every pane in every session.

### Requirements

- Node.js ≥ 20.
- tmux ≥ 3.2. The 3.2 floor is load-bearing; see the Compatibility section of
  [`README.md`](./README.md) for details.

[Unreleased]: https://github.com/promptctl/tmux-control-mode-js/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/promptctl/tmux-control-mode-js/releases/tag/v0.1.0
