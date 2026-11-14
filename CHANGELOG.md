# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); version numbers follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed — breaking

- `TopologyRouter`'s constructor takes a `DeliveryQueue` first:
  `new TopologyRouter(delivery, reportTopologyError, options)`. A transport
  adapter passes the queue its own entry points step through, so the
  router's sinks and error reports run after the adapter's transition.
- `WebSocketTmuxClient`'s frame handlers, public only so a module-level table
  could call them, are gone from its surface: `onWelcome`, `onResult`,
  `onDraining`, `dispatchEvent` and `emitError` are private, and `onPong`
  and `emitSynthetic` are removed.
- `PaneRecord` says whether its pane has a process. `pid`, `cwd` and
  `currentCommand` move into `process`, a `PaneProcessState` (exported from
  `.`, `./browser` and `./protocol`): `{ state: "running", pid, cwd,
  currentCommand }`, `{ state: "dead" }` for a pane `remain-on-exit` kept
  after its process exited, or `{ state: "empty" }` for a pane that never had
  one (`newEmptyWindow()`, `split-window -I`). Before, a pane with no
  process read as `pid: 0` and `cwd: ""`, its `currentCommand` the default
  shell's name or the exited command, and on tmux 3.7 a dead pane kept the
  exited process's pid. A
  running pane's `cwd` is `null` when tmux cannot read it, where it was
  `""`. Read `p.process.pid` after checking `p.process.state === "running"`.
  The bridge wire carries the new shape; upgrade server and client together.
- `listWindows`, `listPanes` and `listSessions` reject with
  `TmuxReplyFormatError` (carrying the command and the reply) when a reply
  line does not parse, where 0.2.0 skipped the line and a pane list read as
  one pane fewer. An id, size or count that is not an unsigned integer no
  longer parses, where it was `NaN`.
- `parsePaneList` is removed: it skipped a line it could not read. The
  topology bootstrap and window refresh now reject such a reply, which
  reaches `topology-error`, where a skipped line left that pane's output
  unrouted. `parsePaneListLine` also rejects an id beyond
  `Number.MAX_SAFE_INTEGER`.
- `listPanes` reads a pane whose process name holds a tab, as tmux on Linux
  can report it: `pane_current_command` is escaped like `pane_current_path`.
  It also reads a pane whose cwd or process name holds a newline, which tmux
  prints raw, splitting the pane's line. 0.2.0 dropped both panes from the
  list.

### Fixed

- A listener, a sink or `onError` may call `close()` or `connect()` at any
  transition, and the client ends in the state its last call asked for.
  `TmuxClient`, `WebSocketTmuxClient` and the Electron `TmuxClientProxy` now
  call consumer code only once the transition that caused it has finished:
  before a call from outside the client returns, and after the current
  listener returns for a call made from one. Each message tmux sends is one
  transition, so a sink a listener attaches or disposes takes effect from the
  next message, however the transport split its reads. A reply a transport
  delivers synchronously from within `send()`, as `./mock` does, is part of
  the call that sent it. Before, a
  `WebSocketTmuxClient` callback that closed or reconnected mid-transition
  could leave a heartbeat timer or socket running on a closed client, or
  announce a connection the callback had ended. Listeners hear events in the
  order the client reached them: `exit` before `closed`, `ready` before
  `reconnected` before a `closed` its listener caused. A listener that
  throws no longer interrupts the client's transition or cuts short the
  events after it, though it still skips the rest of that one event's
  listeners. The throw (an `AggregateError` when several threw) leaves
  through the call that delivered the event. For an event caused by a
  command's reply, such as a topology query, it is an unhandled rejection.
- `execute()` rejects a command holding a NUL with `TmuxInvalidCommandError`,
  and nothing is sent. tmux ends a command line at a NUL, runs what precedes
  it and replies success, so `execute("new-window -e 'A=x<NUL>y' -- cmd")`
  opened a window running the default shell and resolved. This holds on
  `TmuxClient`, `WebSocketTmuxClient` and the Electron `TmuxClientProxy`.
  `sendKeys` still sends a NUL key: it writes keys as hex. The error's
  message now says why the command was refused and leaves the command out,
  since an `-e` value in it is often a credential and a bridge forwards the
  message to its peer; the command stays on `.command`.
- `WebSocketTmuxClient` now receives `unsolicited-response` and
  `protocol-error`. Its `on` accepted both names, but the WebSocket bridge
  never forwarded the events, so a handler compiled and stayed silent. Both
  bridges now deliver them to every connected peer; the README section
  "Events over a bridge" says which events reach a peer. Upgrade server and
  client together: an older `WebSocketTmuxClient` reports each such frame
  through `onError` as a non-fatal `BRIDGE_PROTOCOL_ERROR`.
- `toEventEmitter` now re-emits `unsolicited-response` and `protocol-error`,
  like tmux's own notifications. `connection-state`, `reconnected` and
  `topology-error` stay on the client's typed channels.
- A WebSocket result frame whose `tmuxError` is not a well-formed
  `CommandResponse` (numbers `commandNumber` and `timestamp`, a string array
  `output`, a boolean `success`) is now a `BRIDGE_PROTOCOL_ERROR` naming the field, instead of
  reaching the caller's `TmuxCommandError` as whatever arrived.
- `WebSocketTmuxClient` now checks every field of what a bridge sends against
  its type. A result whose `response` is not the shape its method returns (a
  `CommandResponse`, or the `listWindows`/`listPanes`/`listSessions` records,
  or `null`), or whose `error.code` is not a `BridgeErrorCode`, rejects the call
  with a `BRIDGE_PROTOCOL_ERROR` naming the field, for example
  `result(listPanes).response[0].pid must be a number`. An event frame
  carrying a tmux message with a missing or mistyped field is reported through
  `onError` the same way, for example
  `event.msg(window-renamed).name must be a string`, instead of reaching
  listeners. Before, a bad value reached the caller unchecked, and the failure
  came later, far from the wire. A field the type does not declare is dropped.
- `parseServerFrame` returns a `ReceivedServerFrame`: a result frame comes back
  as a `ReceivedResultFrame` holding its `id` and the frame unread, since what
  a result holds depends on the call it answers. `parseResultFrame(method, raw)`
  parses it as the answer to a call of `method`.
- A tmux line whose id or number field is not an unsigned decimal integer
  (`%output %x5 …`, `%window-add @12abc`) is no longer delivered as a message
  holding `NaN` (or `12`). Like a line with too few fields, it is now a
  `protocol-error`, which reports every line of a known type that the parser
  cannot read, not only a reply block's malformed terminator.
  `ProtocolErrorMessage` gains `kind`: `terminator` (the block's command
  rejects with `TmuxProtocolError`, as before, and only this kind carries
  `commandNumber`), `begin` (an unreadable `%begin`: no reply can be matched
  to its command any more, so `TmuxParser` reads no further line until
  `reset()` and `TmuxClient` ends the connection, rejecting every pending
  command and refusing any a listener issues, with `exit` reason
  `malformed %begin: "<line>"` (the line JSON-quoted) and state
  `closed`/`transport-error`), or `line` (anything else; dropped).
  `TmuxParser` takes its `onProtocolError` handler as a required second
  constructor argument (no longer a settable field), so no parser can miss a
  `begin` report. Upgrade a WebSocket bridge and its clients together: an
  older `WebSocketTmuxClient`
  reports a `begin` or `line` `protocol-error` frame through `onError`.

### Added

- `DeliveryQueue` (and its `Outcome` type), exported from `.`: runs a
  transport adapter's entry points as run-to-completion steps and delivers
  what they post to consumer code once the outermost step has finished.
  `TopologyRouter` takes one.

## [0.2.0]

### Changed — breaking

- `listWindows` and `listPanes` return structured records for the whole
  server instead of a raw `CommandResponse` for the current session or
  window. `listWindows(client)` resolves `readonly WindowRecord[]`
  (`sessionId`, `sessionName`, `windowId`, `windowName`, `width`, `height`)
  and `listPanes(client)` resolves `readonly PaneRecord[]` (`sessionId`,
  `sessionName`, `windowId`, `windowName`, `paneId`, `cwd`, `pid`,
  `startCommand`, `currentCommand`, and the pane's `width` and `height`);
  both query with `-a`. Names, cwd and commands arrive decoded as Unicode
  text, a cwd containing a tab or backslash survives intact, and a reply
  line that does not parse is skipped. Code that read `response.output` must
  read the records instead. `WebSocketTmuxClient` and the Electron
  `TmuxClientProxy` return the same records and the bridge wire carries
  them, so upgrade server and client together. The `WindowRecord` and
  `PaneRecord` types are exported from `.`, `./browser` and `./protocol`.
- `execute()` rejects a command that is not one non-empty line with the new
  `TmuxInvalidCommandError` (carrying `command`; exported from `.` and
  `./browser`) before anything is sent: an empty or whitespace-only string,
  a line whose first non-blank character is `#`, or a string containing a
  newline, a trailing one included. `execute("")` used to send a bare
  newline, which detaches the control client; a multi-line string ran as
  several commands behind one promise, and the extra replies answered the
  commands queued after it; a blank or comment line, which tmux does not
  answer, took the next command's reply, so every later reply went to the
  wrong caller. `TmuxClient`, `WebSocketTmuxClient` and the Electron
  `TmuxClientProxy` all check locally, and a bridge server answers such a
  call from a raw peer with `BRIDGE_INVALID_ARG`. Use `TmuxClient.detach()`
  to detach.
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
- `WebSocketTmuxClient` has one connection-state surface. The deprecated
  `state` getter, the `onState` option and the `WebSocketTmuxClientState`
  type are removed; read `connectionState` or listen for the
  `connection-state` event, as on every other connection. While a server
  drains, `connectionState` now stays `ready` — it used to report `closed`
  with reason `exit` although the socket was open and calls in flight were
  still being answered. New calls are still refused with `BRIDGE_CLOSED`
  and `onDraining` still fires.
- `connection-state` reaches `ready` when the reply to the command tmux was
  started with closes, not on the first byte received, and `TmuxClient`
  tells that block from a reply to a caller by the `flags` field of
  `%begin`. A transport that writes guard lines itself (a custom
  `TmuxTransport`, a fake in a test, a replay) must write flags 0 on the
  block that answers the command tmux was started with and flags 1 on every
  reply to a command the client sent, as tmux does. With no flags-0 block,
  or with flags 1 on the first block, the client stays `connecting` even
  while its `execute()` calls settle; with flags 0 on a reply, `execute()`
  never settles. `MockTmuxServer` (`./mock`) writes its greeting with flags
  0 on `start()`.
- `CommandResponse.output` lines are no longer stripped of a trailing `\r`.
  The parser used to drop one from every line; it now does so only for
  protocol lines, so pane bytes read through a response block
  (`capturePane`, `capture-pane -p`) keep a real carriage return. On a
  transport that delivers CRLF line endings an output line can therefore end
  in `\r` — strip it where a reply is parsed as text
  (`line.replace(/\r+$/, "")`). `parsePaneListLine` and the record parsers
  behind `listWindows`/`listPanes`/`listSessions` already tolerate it.
- `TmuxTransport.send()` returns `SendResult`
  (`{ ok: true } | { ok: false; reason: string }`) instead of `void`. A send
  failure is now a representable outcome rather than a silent no-op — every
  transport the package ships, and every `TmuxTransport` a consumer
  implements, must state whether it accepted the command. Update the
  `send()` return type of a custom transport; `TmuxClient.execute()` rejects
  with the new `TransportSendError` (carrying `reason`) when a send is
  refused. `websocketTransport` refuses a send while its socket is not open,
  where it used to call `ws.send()` regardless, which throws on a connecting
  socket and drops the command on a closing one. `SendResult` is exported
  from `.`.
- `TmuxClient.detach()` likewise returns `SendResult` instead of `void`, for the
  same reason — a refused detach is now observable instead of silently dropped.
- `queryTmuxVersion` — and so `requestReport` — rejects with typed errors
  instead of a generic `Error`: the new `UnrecognizedTmuxVersionError`
  (carrying the raw `reported` reply) when tmux's reply is one line that is
  not a tmux version, and the new `TmuxReplyFormatError` when the reply is
  not exactly one line. It used to scan every reply line for anything that
  looked like a version. `queryClipboard` and the new `paneCwd`,
  `newEmptyWindow` and `respawnPane` ask the version first and reject the
  same way.
- `parseTmuxVersion` accepts only tmux's own version shapes (`3.2a`,
  `next-3.6`, `3.4-rc`, bare or after the program name) and returns `null`
  for anything else. Vendor tags such as OpenBSD base's `openbsd-7.4` used to
  read as tmux 7.4 and pass every version gate; strings with trailing text
  (`tmux 3.5 built 1.2`) no longer parse either.
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
- The WebSocket server's `onEvent` `result` event for a call tmux answered
  with `%error` now reports `ok: false, code: "TMUX_ERROR"` instead of
  `ok: true`. Hosts that count `ok: false` results as bridge failures will
  see ordinary tmux errors (a mistyped command, a closed window) counted.
- `PaneTopologyManager.seed` and `updateWindow` entries carry a required
  `floating` flag (tmux 3.8 floating panes), and `updateWindow` returns what
  the update contradicted (`{ left, lostTrack }`) instead of `void`.
  `parsePaneListLine` returns a `PaneListEntry` (`paneId`, `windowId`,
  `sessionId`, `floating`), reading the flag from an optional fourth field;
  query with the new `PANE_LIST_FORMAT` (unquoted) and parse a whole reply
  with `parsePaneList`.
- `TopologyRouter`'s constructor takes a required `reportTopologyError` reporter
  as its first argument (`new TopologyRouter(reportTopologyError, options?)`),
  an `(error: Error) => void` the router calls with the `error` of each
  `topology-error` event. External consumers constructing a
  `TopologyRouter` directly (an advanced path — building a custom transport
  adapter) must supply it. An adapter also calls the new
  `onTransportLost(run)` the moment its connection drops, before it rejects
  the commands in flight.
- Four unions have new members, so a `switch` written to cover every member
  stops compiling until it handles them: `TmuxEventMap` / `EmitterMessage`
  (`.` and `./browser`: `protocol-error`, `unsolicited-response`,
  `topology-error` and the seven `cross-session-layout-*` events),
  `BridgeObservabilityEvent` (`./websocket`: six kinds, named under Added),
  `RpcMethod` (`./websocket` and `./websocket/protocol`: `listSessions`,
  `enableCrossSessionLayoutChange`, `disableCrossSessionLayoutChange`) and
  `ResultFrame` (`./websocket/protocol`: the `ResultTmuxErrorFrame` arm, so
  `!frame.ok` alone no longer narrows to the frame that has `error`). Two
  frame fields of `./websocket/protocol` are wider the same way:
  `EventFrame.msg` also carries the `cross-session-layout-*` messages, and
  `ResultOkFrame.response` is the result of the method that was called — a
  `CommandResponse`, the records of `listWindows`/`listPanes`/`listSessions`,
  or `null` for the two cross-session-layout calls — so code that reads
  `frame.response.output` must narrow first.
- Two types have new required fields, so code that builds one itself (a
  fixture, a fake) must supply them: `LayoutChangeMessage` (`layout` and
  `visibleLayout`; `windowLayoutFields`, from `./protocol`, builds them from
  the raw strings) and the `connection-closed` `BridgeObservabilityEvent`
  (`socketEnd`). Both are described under Added.

### Added

- `listSessions(client)` — a typed free function over `TmuxConnection`
  returning structured `SessionRecord[]` (`sessionId`, `sessionName`,
  `windowCount`, `attached`), mirroring `listWindows`/`listPanes`. Bridged on
  every RPC connector (Electron, WebSocket).
- `capturePane(client, paneId)` — reads a pane's whole history and screen as
  a `PaneCapture` (`bytes`, `lineCount`): escape sequences included,
  soft-wrapped lines rejoined, lines joined with `\n`. A free function over
  `TmuxConnection`, exported from `.` and `./browser`.
- `newWindow(client, { sessionId, command, environment, select, cwd })` opens
  a window in the session with that id (`listSessions()` reports it) and
  returns the new window's and pane's ids. `environment` is for the window's
  process alone, `select: true` makes the window the session's current one
  (otherwise it opens in the background), and an omitted `cwd` is where tmux
  starts a new window of that session. A `cwd` that does not exist does not
  reject: tmux starts the pane in `$HOME`, except tmux 3.3, which leaves it
  in the server's own cwd — the new `missingCwdFallback(version)` returns
  `"home"` or `"server-cwd"` for a `TmuxVersion`.
- `newEmptyWindow(client, { sessionId, select })` and
  `EMPTY_WINDOW_MIN_VERSION` (tmux 3.8) open a window whose pane has no
  process, and `respawnPane(client, paneId, { command, environment, cwd })`
  starts one in it or in a dead pane. Between the two a caller sets what must
  hold before the process starts, such as `remain-on-exit failed`, which keeps
  the pane of a command that cannot run. The README shows the three calls,
  and which new connections tmux refuses while a pane has no process.
  `respawnPane` rejects with `UnsupportedTmuxVersionError` below
  `RESPAWN_PANE_MIN_VERSION` (tmux 3.8): older tmux can crash its server when
  a pane is respawned while a control client is attached.
- `paneCwd(client, paneId)` and `PANE_CWD_MIN_VERSION` (tmux 3.7). The
  function reads the directory a new pane is in (the requested cwd with
  symlinks resolved, or tmux's `$HOME` fallback) with one call: any path it
  returns is the settled one, so a caller never polls for a changing value.
  Below 3.7 it rejects with `UnsupportedTmuxVersionError`, because older tmux
  forks the pane before the child changes directory. When tmux cannot read
  the cwd at all it rejects with the new `PaneCwdUnavailableError`.
- `watchServerArgs(targetSession?)` — arguments for `spawnTmux` that attach a
  connection which watches a whole server as an extra client: it never
  starts a server (`-N`), leaves the attached session's environment alone
  (`-E`), takes no part in window sizing (`ignore-size`) and moves to
  another session when its own ends (`no-detach-on-destroy`, tmux 3.6+).
  With a session name it attaches to exactly that session; with none, to
  the session a bare `tmux attach-session` would land in, for a consumer
  that has no name yet. The README lists what tmux still does for any
  attached client. `getOwnClient(client)` resolves the connection's own
  `OwnClient` — its tmux client `name`, its `pid`, and the `flags` tmux
  accepted — so a watcher can filter itself out of what it observes and
  confirm its flags took effect.
- `unsolicited-response` event on `TmuxClient`: tmux's reply to a command no
  caller sent, carrying the whole `CommandResponse` (output, and `success`
  false for a `%error`). One per command: the command line tmux was started
  with (`tmux -C list-sessions` now delivers its listing here), a hook a
  command set off (`after-*`, `command-error`), an `if-shell -b` or
  `run-shell -b -C`. Only the failure of the first startup command is also the
  `exit` reason; any other failure appears in this event only, whether or not
  the connection lives on. The Electron bridge forwards it to renderers; the
  WebSocket bridge does not.
- `protocol-error` event (`{ type: "protocol-error", commandNumber, line }`)
  on `TmuxClient`, emitted when a response block's `%end`/`%error` line is
  malformed. The command that block answered rejects with the new
  `TmuxProtocolError` (`commandNumber`, `line`, and the `output` collected so
  far) and parsing resumes with the next line. `TmuxParser` exposes the same
  detection as `onProtocolError`; the `ProtocolErrorMessage` type is exported
  from `./protocol`. `'*'` listeners receive the event and `isTmuxMessage` is
  false for it. The Electron bridge forwards it to renderers; the WebSocket
  bridge does not.
- `topology-error` event (`{ type: "topology-error", error }`) on every
  `TmuxClient`-shaped connection, emitted when the pane table that session-
  and window-scoped sinks route by could not be kept true: a bootstrap
  (`list-panes -a`) or a window refresh failed, or output held for unplaced
  panes overflowed the 4 MiB hold and the excess was dropped for those
  sinks. `error.message` says which, and for the
  first two `error.cause` is the underlying rejection. It distinguishes "no
  output because routing failed" from "no output because tmux is quiet" — a
  session/window-scoped consumer is no longer starved with no signal. A
  failure caused by the connection dropping, or superseded by a newer query,
  is not reported, and neither is a refresh that failed because its window
  is gone. `'*'` listeners receive the event and `isTmuxMessage` is false
  for it.
- Parsed layout geometry. `layout-change` messages carry `layout` and
  `visibleLayout` beside the raw strings: each a `WindowLayout`, either
  `{ kind: "parsed", panes }` with one `PaneGeometry` (`paneId`, `width`,
  `height`, `x`, `y`, in character cells) per tiled pane, or
  `{ kind: "malformed", reason }`. `parseWindowLayout(raw)` does the same
  for a layout string read any other way. Floating panes (tmux 3.8) are not
  in a layout string and so not in `panes`. The `WindowLayout`,
  `WindowLayoutFields` and `PaneGeometry` types are exported from `.`,
  `./browser` and `./protocol`.
  `windowLayoutFields(windowLayout, windowVisibleLayout, windowFlags)`, from
  `./protocol`, builds the group.
- Cross-session layout coverage. After
  `await client.enableCrossSessionLayoutChange()` a connection emits
  `cross-session-layout-change` (`sessionId`, `windowId`, and the same layout
  fields as `layout-change`) for windows in every session on the server, the
  attached one included — match on `windowId`, not `sessionId`. Enables are
  counted; each pairs with one `disableCrossSessionLayoutChange()`. Coverage
  rides on a global `window-layout-changed[9001]` hook and tmux's format
  subscriptions, so a change arrives up to about a second after it happens;
  the hook stays installed on the server after the last disable.
  The connection says what it could not cover instead of going quiet:
  `cross-session-layout-uncovered` (`windowIds`: the windows whose changes it
  cannot see — those whose own window or session hook shadows the global
  one, and every window while the global hook is removed; emitted on
  enabling and whenever the set changes, `[]` when coverage is whole, so the
  latest event is the current state), `cross-session-layout-overrun`
  (`lostEntries`), `cross-session-layout-hook-restored` (the hook had been
  removed and was reinstalled), `cross-session-layout-fetch-failed`
  (`windowId`, `reason`), `cross-session-layout-decode-error`
  (`skippedBytes`) and `cross-session-layout-repair-failed` (`reason`);
  after an overrun or a restored hook, re-read every window's layout.
  Available on `TmuxClient`, `WebSocketTmuxClient` (re-enabled after a
  reconnect) and the Electron `TmuxClientProxy`; a bridge forwards the
  events only to peers that enabled coverage, and reports a release of a
  departed peer's coverage that a live tmux refused through the
  `cross-session-layout-release-failed` `onEvent` (WebSocket) or
  `MainBridgeOptions.onCoverageReleaseFailure` (Electron). The message types
  are exported from `.` only, not `./browser`; `toEventEmitter`
  (`./streams/node`) projects the events; `'*'` listeners receive them and
  `isTmuxMessage` is false for them. The subscription name
  `ttcmjs-cross-session-layout` is reserved: a bridge refuses a peer's
  `subscribeRaw` or `unsubscribe` of it with `BRIDGE_INVALID_ARG`.
- `TransportClosedError` (`reason`), the rejection of a command that was
  queued or already inflight when the transport closed before tmux replied.
  Its `reason` is the `exit` event's `reason`: tmux's own text after a
  failed attach, `undefined` after a bare `%exit` whatever the process's
  exit code. Distinct from `TransportSendError` (the send was refused
  outright) and `TmuxCommandError` (tmux replied with `%error`).
- `TmuxReplyFormatError` (`command`, `output`), exported from `.` and
  `./browser` — the rejection of a typed command when tmux's reply does not
  have the shape that command reads: `newWindow`, `newEmptyWindow`,
  `paneCwd`, `getOwnClient`, and `queryTmuxVersion` (with every command that
  asks the version first) when the reply is not exactly one line.
- `./browser` exports the whole error taxonomy — `TmuxCommandError`,
  `TmuxProtocolError`, `TmuxInvalidCommandError`, `TmuxReplyFormatError`,
  `PaneCwdUnavailableError`, `TransportClosedError`, `TransportSendError`,
  `UnrecognizedTmuxVersionError` — where it used to export only
  `UnsupportedTmuxVersionError`, so browser code can classify a rejection
  with `instanceof`. `isConnectionGone(error)`, new on `.` and `./browser`,
  is true for `TransportClosedError` and `TransportSendError`: the
  connection went away, as opposed to a live tmux saying no. Everything else
  added to `.` in this
  release is exported from `./browser` too, except `watchServerArgs`
  (arguments for the Node-only `spawnTmux`), the `SendResult` type and the
  `CrossSessionLayout*Message` types.
- `./mock` subpath — `MockTmuxServer`, an in-process `TmuxTransport` that
  speaks the control-mode wire format with no tmux and no Node dependency.
  Construct it with a `MockScenario` (`greeting` notifications and a
  `respond(command)` that returns a `CommandReply` — `{ kind: "ok" | "error",
  output? }` — or `undefined` for an ok with no output), hand it to
  `TmuxClient`, call `start()`, then drive it with
  `emit(message)` and `emitOutput(paneId, bytes)`; `sentCommands` lists what
  the client sent. For tests, demos and browser playgrounds.
- `./chaos` subpath — `withChaos(transport, options)` wraps any
  `TmuxTransport` and drops, corrupts and delays the chunks it delivers to
  the client (`dropRate`, `corruptRate`, `latencyMs: { min, max }`,
  `corruptions`), reproducibly from a `seed`. Commands the client sends pass
  through untouched. `ManualClock`, passed as the `clock` option, makes the
  latency deterministic in tests;
  `planChunk`, `corruptChunk`, `ALL_CORRUPTIONS`, `mulberry32` and
  `randomInt` are exported for building other fuzzers.
- `./conformance` subpath — `buildConformanceChecks()` returns a list of
  `ConformanceCheck`s (`id`, `channel`, `title`, `spec`, `run()`), each of
  which drives a real `TmuxClient` over the in-process mock and resolves
  `{ status: "pass" | "fail", detail }`: one check per notification and
  pane-output sample, and three `command` checks (`command:ok`,
  `command:output`, `command:error`) that run a command through `execute()`.
  Needs no tmux, so it runs in a browser. `MESSAGE_SAMPLES` holds one sample
  per `TmuxMessage` type and `CHANNEL_OF` the channel each type is observed
  on (`notification`, `command`, `pane-output`).
- `./protocol` exports the inverse of the parser and of the octal decoder:
  `serializeMessage(message)` turns a `TmuxMessage` back into its wire text
  and `encodeOctalEscapes(bytes)` produces the `%output` escaping that
  `decodeOctalEscapes` reverses exactly. Both are also exported from
  `./mock`.
- `TmuxParser.onUnguardedLine` — called with each non-`%` line tmux writes
  outside a response block (`run-shell` output, or its complaint about a
  startup command it cannot parse). Such lines used to be dropped.
- `TmuxParser` reads a `tmux -CC` stream as it comes off a PTY: the DCS
  introducer in front of tmux's first line is dropped, wherever outside a
  response block that line falls.
- WebSocket bridge observability (`onEvent`). `connection-closed` carries
  `socketEnd`, a `SocketEnd` that says how the socket actually ended —
  `{ kind: "close-event", code, reason }`, `{ kind: "error", message }` or
  `{ kind: "terminated", by: "shutdown" | "heartbeat" }` — and `errorCode`,
  the `BridgeErrorCode` of why the bridge ended the connection: the fatal it
  sent the peer, `BRIDGE_INTERNAL` for a socket error, `BRIDGE_CLOSED` for a
  shutdown; absent when the peer closed on its own. New event kinds:
  `upstream-closed` (`reason`: why the tmux connection behind this peer
  closed — `exit`, `transport-error` or `disposed`),
  `handshake-failure-unreported` (`code`, `message`: an auth denial or
  `createClient` rejection the bridge could not send the peer, because an
  earlier fatal was already closing the connection or, for `createClient`,
  the connection had already closed), `client-dispose-failed` (`message`:
  the `disposeClient` hook threw or rejected) and `release-failed`
  (`message`: one cleanup step threw while a half-opened connection was
  being unwound). A switch over `BridgeObservabilityEvent` needs these four
  and the two described in their own entries, `pane-resume-failed` and
  `cross-session-layout-release-failed`. The `SocketEnd` type is exported
  from `./websocket`.
- `pane-resume-failed` observability event on the WebSocket bridge server
  (`onEvent`) and a matching `onResumeFailure` hook on the Electron
  `MainBridgeOptions`, emitted when a live tmux refuses a pane's resume
  (`refresh-client -A %<pane>:continue`) while the watermark loop wants it
  flowing. The WebSocket event carries `paneId`, `code` and `message`; the
  Electron hook receives a `ResumeFailure` (`paneId`, `error: BridgeError`),
  a type exported from `./electron/main`. Both are opt-in: a host that does
  not observe them is making an informed choice — the bridge never swallows
  the failure internally.
- `./websocket/protocol` exports `toBridgeProtocolError(error)`, which
  returns a `BridgeError` unchanged and wraps anything else as
  `BRIDGE_PROTOCOL_ERROR`, and the `ResultTmuxErrorFrame` type for the
  `{ k: "result", ok: false, tmuxError }` frame.

### Fixed

- A reply to a command no caller sent no longer takes a caller's place. tmux
  writes a response block for each command of the command line it was
  started with and of each hook a command sets off; the client used to hand
  every such block to the oldest pending `execute()`. A command issued
  before the startup block arrived (right after construction), a startup
  list of two commands, or one hook, gave that caller the wrong output — an
  early `execute()` resolved with the startup block's empty output — and
  shifted the replies of the commands queued behind it by one. The client
  now assigns a block to a caller only when tmux marks it as answering a
  line the client wrote (`flags` 1, SPEC.md §5.5).
- A failed attach says why. When the command tmux was started with fails
  (`can't find session: main`, `no sessions`, an unknown flag) or tmux never
  reaches a server (`no server running on …`, from `watchServerArgs`' `-N`),
  the `exit` event's `reason` is tmux's own text, where it used to say only
  `exit 1`, or nothing, and every command pending at the end rejects with a
  `TransportClosedError` whose `reason` is that same text. `spawnTmux` now
  reads the child's stderr: it is the close reason when the child exits
  non-zero without having written to stdout.
- `execute()` promises no longer hang forever when the transport closes. A
  command queued or inflight when the transport closes rejects with
  `TransportClosedError`, and one issued after it closed rejects with
  `TransportSendError` (reason `transport closed: <the exit reason>` when
  there is one); it used to be written to nothing and never settle. Through
  a bridge (Electron, WebSocket) both arrive as `BRIDGE_CLOSED`.
- A malformed `%end`/`%error` line no longer wedges the connection. The
  parser used to stay inside the response block, so everything after it —
  notifications and the next command's reply included — was read as that
  command's output until a later well-formed terminator closed the block,
  and from then on each reply settled the command sent before its own. The
  command now rejects with `TmuxProtocolError` (carrying `commandNumber`,
  the raw `line` and the `output` collected so far), a `protocol-error`
  event fires, and parsing resumes.
- The `exit` event now fires exactly once per connection. Previously a
  graceful disconnect (tmux sends `%exit`, then the transport closes) fired
  it twice; a killed server that never gets to send `%exit` still fires it
  exactly once, synthesized from the transport's own close.
- `TmuxClient`'s `closed` connection state is now terminal, matching its
  documented contract: a data chunk delivered after the transport reports
  closed (a legitimate race under delayed/chaotic delivery) no longer
  resurrects `ready`.
- `spawnTmux` dispatches close exactly once, with the first (truest) reason
  winning. A failed spawn (e.g. `ENOENT`) used to call every `onClose`
  listener twice — once from the child's `error` event and again from its
  `close` event — so one death looked like two.
- An `EPIPE` write in the window between the child dying and its `close` event
  no longer crashes the host process.
- `queryClipboard` no longer kills the connection on tmux 3.2: it probes the
  running version and rejects with `UnsupportedTmuxVersionError` instead of
  sending `refresh-client -l`, which made the control client exit. Adds one
  `display-message` round-trip per call. `QUERY_CLIPBOARD_MIN_VERSION`,
  `PASTE_BUFFER_NOTIFY_MIN_VERSION`, and `MESSAGE_NOTIFY_MIN_VERSION` are
  exported for consumers that pre-check.
- Session- and window-scoped sinks no longer lose output for a pane the
  topology table has not placed yet. Output that arrives while a topology
  query is in flight — at startup, or after `break-pane` or `move-window`
  moved a pane — is held (up to 4 MiB) and delivered in arrival order once
  the pane is placed, to the sinks that were attached when it arrived; it
  used to be dropped for those scopes. `window-add` and `window-close` now
  both unplace the window's panes and re-query — `window-add` used to
  re-query without unplacing, `window-close` to unplace without re-querying
  — a `layout-change` that contradicts the table unplaces the affected
  panes and re-queries, and a failed window refresh re-bootstraps and
  raises `topology-error` instead of silently emptying the window (tmux
  answering `can't find window`, the expected reply for a closed window,
  raises nothing). A hold that overflows is reported as a `topology-error`
  too.
- A failed topology bootstrap no longer silently starves session/window-scoped
  byte sinks. Previously the bootstrap's `list-panes -a` rejection was
  swallowed, leaving an empty topology that routed every session/window
  consumer to zero bytes with no error — indistinguishable from a quiet tmux.
  The failure now surfaces as a `topology-error` event, and the next
  bootstrap trigger (`session-changed`, a window event, a new session- or
  window-scoped sink) tries again.
- The websocket transport reports how the socket really closed. An `error`
  event used to dispatch close at once with the generic `websocket error`,
  discarding the close code that followed (1006, 1001, …); the `close` event
  is now the only dispatcher, and `websocket error` is the reason only when
  the close carried neither a code nor a reason. A clean closure (code 1000
  with no reason text) reports no reason, as a clean tmux exit does — it
  used to report `code 1000`, which reads as an abnormal close. A socket
  already closed when `websocketTransport` adapts it now dispatches close
  (`websocket already closed`) instead of never closing.
- `WebSocketTmuxClient.connect()` called while the client is waiting to
  reconnect no longer opens a second socket. It used to open one without
  cancelling the retry, so the retry opened another on the same client:
  events arrived twice, `reconnected` fired spuriously, and when the
  orphaned socket closed it tore down the working connection and rejected
  its pending calls. The call is now a no-op until the retry has run.
- The WebSocket bridge closes a peer when the tmux connection behind it
  closes. A peer used to stay `ready` on a dead `TmuxClient`: the forwarded
  `exit` event was its only signal, the socket stayed open and nothing
  further arrived. It is now closed with `BRIDGE_CLOSED` (`upstream tmux
  connection closed (<reason>)`) and the host sees an `upstream-closed`
  event. A `createClient` that returns an already-closed client ends the
  same way at hello, so a `createClient` that hands one `TmuxClient` to
  every connection must return a new one once that client has closed.
- A WebSocket peer that never answers a fatal close is terminated. After
  sending a fatal error and a close frame the bridge used to wait for the
  peer's own close frame with no bound of its own, keeping the connection
  and its tmux client alive; the heartbeat now bounds the wait at one cycle
  (`heartbeatIntervalMs` + `heartbeatTimeoutMs`, 40 s by default), after
  which the socket is terminated (`socketEnd: { kind: "terminated", by:
  "heartbeat" }`). With `heartbeatIntervalMs: 0` the bridge sets no bound
  and only the transport's own close timer ends the wait.
- A WebSocket `ping()` that throws now counts as an unanswered ping. The
  bridge used to skip that heartbeat tick, so a socket whose every ping
  threw was never timed out.
- The WebSocket bridge's hello handshake no longer leaks a tmux client. A
  peer that disconnected while `authenticate` or `createClient` was pending
  left the created client and its listeners alive, and a client was not
  disposed when wiring it to the connection threw. A disconnect during
  `authenticate` now creates no client at all; a disconnect during
  `createClient` and a wiring failure both end in `disposeClient`. A second
  hello sent while the first is still being handled closes the connection
  with `BRIDGE_PROTOCOL_ERROR` (`duplicate hello frame`); it used to run a
  second handshake alongside the first.
- A `disposeClient` hook that throws or rejects no longer escapes the
  bridge. A rejection used to become an unhandled rejection in the host
  process, and a synchronous throw escaped the socket's `close` handler
  before `connection-closed` was emitted; the bridge now reports either as
  a `client-dispose-failed` `onEvent` (carrying `message`).
- `connection-closed`'s `reason` (WebSocket bridge `onEvent`) is the
  bridge's own fatal message whenever the bridge closed the peer. It used to
  prefer the close frame's text, so an abnormal close with an empty reason
  blanked the reason the peer had been given.
- A failed pane resume no longer strands the pane paused in tmux while the
  bridge's ledger claims it resumed. Previously the bridge deleted the pane
  from its paused ledger _before_ the `continue` command settled and
  swallowed every rejection, so a transient failure on a live pane left it
  paused in tmux forever — no retry, no signal. The ledger transition now
  follows the command's
  outcome: on success the pane leaves the ledger; on a connection-gone
  rejection (transport refused/closed — a moot pane on a dead connection) it is
  dropped quietly; on any live-tmux failure (`%error`, corrupted terminator) the
  pane stays paused so the next watermark crossing retries, and the failure is
  surfaced (see the `pane-resume-failed` / `onResumeFailure` additions above).

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

[Unreleased]: https://github.com/promptctl/tmux-control-mode-js/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/promptctl/tmux-control-mode-js/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/promptctl/tmux-control-mode-js/releases/tag/v0.1.0
