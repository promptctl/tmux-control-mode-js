# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); version numbers follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed — breaking

- `TmuxClient` reads the `flags` field of `%begin`. A transport that writes
  guard lines itself (a fake in a test, a replay) must write flags 0 on the
  block that answers the command tmux was started with and flags 1 on every
  reply to a command the client sent, as tmux does. With flags 1 on the first
  block the client stays `connecting`; with flags 0 on a reply, `execute()`
  never settles. `MockTmuxServer.start()` writes its greeting with flags 0.

- `createWebSocketBridge` and `WebSocketTmuxClient` parse `heartbeatIntervalMs`
  and `heartbeatTimeoutMs` at construction and throw
  `BridgeError("BRIDGE_INVALID_ARG", ...)` naming the option and value when
  one is not an integer number of ms in [1, 2^31-1]. `heartbeatIntervalMs: 0`
  remains the off switch; a negative interval used to disable the heartbeat
  silently and a non-positive timeout closed every peer with
  `heartbeat timeout after 0ms` one interval after hello. On the wire,
  `WelcomeLimits.heartbeatIntervalMs` is typed `HeartbeatInterval`
  (`0 | DurationMs`; the types and their parsers `parseDurationMs` and
  `parseHeartbeatInterval` are exported from `./websocket/protocol` and
  `./websocket`), and a client rejects a welcome advertising any other value
  as `BRIDGE_PROTOCOL_ERROR` — a server configured with a negative interval
  must be reconfigured to `0`.
- The same parsing covers every other ms and count option a timer or call
  limiter consumes. `createWebSocketBridge` parses `requestTimeoutMs` and
  `maxInflight` (an integer >= 1); `bridge.shutdown(drainMs)` rejects with
  `BRIDGE_INVALID_ARG` for a `drainMs` outside [1, 2^31-1] before any peer is
  told to drain, so `shutdown(0)` is no longer a "terminate now" idiom.
  `WebSocketTmuxClient` parses `requestTimeoutMs` and every field of
  `reconnect` (`maxAttempts` must be `0`, a positive integer, or `Infinity`;
  `initialDelayMs` and `maxDelayMs` are durations; `factor` is finite and
  >= 1; `jitterMs` is `0` or a duration; `maxDelayMs + jitterMs` must fit the
  timer range) whether or not reconnect is on — `maxAttempts: -1` used to
  disable reconnect silently and now throws. On the wire,
  `WelcomeLimits.requestTimeoutMs` is `DurationMs` and `maxInflight` is the
  new `PositiveInt` (parser `parsePositiveInt`, exported beside the others),
  so a welcome built from raw numbers no longer compiles, and a client rejects
  a welcome advertising `requestTimeoutMs: 0` or `maxInflight: 0` as
  `BRIDGE_PROTOCOL_ERROR`.
- `PaneTopologyManager.seed` and `updateWindow` entries carry a required
  `floating` flag (tmux 3.8 floating panes), and `updateWindow` returns the
  `Contradiction` it found. `parsePaneListLine` reads the flag from an
  optional fourth field; query with the new `PANE_LIST_FORMAT` (unquoted) and
  parse a whole reply with `parsePaneList`.
- `parseTmuxVersion` accepts only tmux's own version shapes (`3.2a`,
  `next-3.6`, `3.4-rc`, bare or after the program name) and returns `null`
  for anything else. Vendor tags such as OpenBSD base's `openbsd-7.4` used to
  read as tmux 7.4 and pass every version gate; strings with trailing text
  (`tmux 3.5 built 1.2`) no longer parse either.
- `queryTmuxVersion` — and so `requestReport` and `queryClipboard` — rejects
  with the new `UnrecognizedTmuxVersionError` (carrying the raw `reported`
  reply) when the running tmux's version is unrecognisable, instead of
  `TmuxReplyFormatError`.

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

- `WebSocketTmuxClient` now rejects with `TmuxCommandError` when tmux answers
  a call with `%error`, instead of resolving with a `CommandResponse` whose
  `success` is `false`. This matches the Electron renderer proxy and a direct
  `TmuxClient`. Code that checked `!r.success` after awaiting a WebSocket
  `execute()` must catch instead. The wire carries this as a new
  `{ k: "result", ok: false, tmuxError }` frame, and the hello handshake has no
  protocol version, so a mismatch fails silently in both directions. A client
  from an earlier release talking to this server treats that frame as a
  protocol error. A client from this release talking to an earlier server
  still receives `{ ok: true, response: { success: false } }` and resolves
  it, so code written to catch never sees the failure. Upgrade server and
  client together.
- The WebSocket server's `onEvent` `result` event for a call tmux answered
  with `%error` now reports `ok: false, code: "TMUX_ERROR"` instead of
  `ok: true`. Hosts that count `ok: false` results as bridge failures will
  see ordinary tmux errors (a mistyped command, a closed window) counted.
- `TransportClosedError.reason` is the `exit` event's `reason`. After a bare
  `%exit` it is `undefined` whatever the process's exit code; it used to be
  the transport's own (`exit 1`). A command issued after the connection ended
  rejects with `TransportSendError` reason `transport closed: <that reason>`
  when there is one.

### Added

- `unsolicited-response` event on `TmuxClient`: tmux's reply to a command no
  caller sent, carrying the whole `CommandResponse` (output, and `success`
  false for a `%error`). One per command: the command line tmux was started
  with (`tmux -C list-sessions` now delivers its listing here), a hook a
  command set off (`after-*`, `command-error`), an `if-shell -b` or
  `run-shell -b -C`. Only the failure of the first startup command is also the
  `exit` reason; any other failure appears in this event only, whether or not
  the connection lives on. The Electron bridge forwards it to renderers; the
  WebSocket bridge does not.
- `newWindow(client, { session, command?, environment?, cwd?, select? })` —
  opens a window in the session with that exact name and resolves a
  `NewWindowResult` (`windowId`, `paneId`). `environment` reaches the window's
  process only (`new-window -e`; values arrive as written), `select: true`
  makes it the session's current window (by default it opens in the
  background), and an omitted `cwd` is the session's own directory. It rejects
  with `RangeError` before sending when `session`, `command` or `cwd` is empty
  or spans lines, `session` starts with `$` (tmux reads that as a session id),
  `cwd` is not absolute, an environment name is empty or holds `=` or a
  newline, or a value holds a newline; and with `TmuxCommandError` when no
  session has that name (unless a client does: tmux then uses that client's
  session). The command is sent after `--`, so one
  starting with `-` is never read as tmux flags. A `cwd` that does not exist
  does not reject: tmux starts the pane in `$HOME`, except tmux 3.3, which
  leaves it in the server's own cwd — the new `missingCwdFallback(version)`
  returns `"home"` or `"server-cwd"` for a `TmuxVersion`.
- `newEmptyWindow(client, { session, select? })` (tmux 3.8,
  `EMPTY_WINDOW_MIN_VERSION`) and
  `respawnPane(client, paneId, { command?, environment?, cwd? })` — a window
  whose pane has no process, and the call that starts one in a pane that has
  none (an empty pane, or a dead one kept by `remain-on-exit`). Between the
  two a caller sets what must hold before the process starts: with
  `set-option -p -t %N remain-on-exit failed`, a command that cannot run
  leaves a dead pane `capturePane()` reads instead of a window that closes.
  `newEmptyWindow` rejects with `UnsupportedTmuxVersionError` below 3.8;
  `respawnPane` rejects with `TmuxCommandError` on a pane whose process is
  alive; with no options it runs the pane's command again in the same
  directory, without the earlier `environment`, which tmux does not keep. The
  option types are exported as `NewWindowPlacement` and
  `PaneProcess`.
- `watchServerArgs(targetSession?)` — arguments for `spawnTmux` that attach a
  connection which watches a whole server as an extra client: it never starts
  a server (`-N`), leaves the attached session's environment alone (`-E`),
  takes no part in window sizing (`ignore-size`) and moves to another session
  when its own ends (`no-detach-on-destroy`, tmux 3.6+). With a session name
  it attaches to exactly that session; with none, to the session a bare
  `tmux attach-session` would land in, for a consumer that has no name yet.
  The README lists what tmux still does for any attached client.
  `getOwnClient(client)` returns the
  connection's own client name and the flags tmux accepted.
- `TmuxParser.onUnguardedLine` — called with each non-`%` line tmux writes
  outside a response block (`run-shell` output, or its complaint about a
  startup command it cannot parse). Such lines used to be dropped.
- `TmuxParser` reads a `tmux -CC` stream as it comes off a PTY: the DCS
  introducer in front of tmux's first line is dropped, wherever outside a
  response block that line falls.
- `paneCwd(client, paneId)` and `PANE_CWD_MIN_VERSION` (tmux 3.7). The
  function reads the directory a new pane is in (the requested cwd with
  symlinks resolved, or tmux's `$HOME` fallback) with one call: any path it returns is the settled one, so a
  caller never polls for a changing value. Below 3.7 it
  rejects with `UnsupportedTmuxVersionError`, because older tmux forks the pane
  before the child changes directory. When tmux cannot read the cwd at all
  it rejects with the new `PaneCwdUnavailableError`.
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
- `listSessions(client)` — a typed free function over `TmuxConnection`
  returning structured `SessionRecord[]` (`sessionId`, `sessionName`,
  `windowCount`, `attached`), mirroring `listWindows`/`listPanes`. Bridged on
  every RPC connector (Electron, WebSocket).

### Fixed

- A reply to a command no caller sent no longer takes a caller's place. tmux
  writes a response block for each command of the command line it was started
  with and of each hook a command sets off; the client used to hand every
  block after the first to the oldest pending `execute()`, so a startup list
  of two commands, or one hook, gave that caller the wrong output and shifted
  every later reply by one for the rest of the connection. The client now
  assigns a
  block to a caller only when tmux marks it as answering a line the client
  wrote (`flags` 1, SPEC.md §5.5).
- A failed attach says why. When the command tmux was started with fails
  (`can't find session: main`, `no sessions`, an unknown flag) or tmux never
  reaches a server (`no server running on …`, from `watchServerArgs`' `-N`),
  the `exit` event's `reason` is tmux's own text, and every command pending at
  the end rejects with a `TransportClosedError` whose `reason` is that same
  text. Both used to say only `exit 1`, or nothing. `spawnTmux` now reads the
  child's stderr: it is the close reason when the child exits non-zero without
  having written to stdout.
- `queryClipboard` no longer kills the connection on tmux 3.2: it probes the
  running version and rejects with `UnsupportedTmuxVersionError` instead of
  sending `refresh-client -l`, which made the control client exit. Adds one
  `display-message` round-trip per call. `QUERY_CLIPBOARD_MIN_VERSION`,
  `PASTE_BUFFER_NOTIFY_MIN_VERSION`, and `MESSAGE_NOTIFY_MIN_VERSION` are
  exported for consumers that pre-check.
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
- `listPanes()` no longer silently drops a pane whose cwd contains a literal
  tab. Previously every record was split on `\t` with a strict field count,
  so a tab in `pane_current_path` desynced the split and the pane vanished
  with no error. The encoder now escapes `pane_current_path` (backslash,
  then tab) via tmux's own format substitution; the parser reverses it.


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
