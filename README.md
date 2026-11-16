# tmux-control-mode-js

Node.js client for the tmux control mode protocol. Provides streaming access to tmux pane output and state change notifications. One connection can watch a whole server without disturbing it — see [Watching a whole server](#watching-a-whole-server).

## Install

```bash
npm install @promptctl/tmux-control-mode-js
```

## Requirements

- Node.js >= 20
- tmux >= 3.2

## Compatibility

> Canonical source for the version constants below: [`src/tmux-compat.ts`](https://github.com/promptctl/tmux-control-mode-js/blob/HEAD/src/tmux-compat.ts).
> This section is the human-readable rationale; the constants there are the
> machine-readable single source of truth (tests import from them).

Supports **tmux 3.2 and later**. The 3.2 floor is load-bearing: the library
depends on features introduced in that release and cannot function on older
tmux:

- Format subscriptions — `refresh-client -B name:what:format` and the
  corresponding `%subscription-changed` notification (tmux 3.2: *"Add a way for
  control mode clients to subscribe to a format and be notified of changes
  rather than having to poll."*)
- Pane flow control — `refresh-client -A <pane>:<action>`, the `pause-after`
  client flag, and the `%pause` / `%continue` / `%extended-output` notifications
  (tmux 3.2: *"Add support for pausing a pane when the output buffered for a
  control mode client gets too far behind."*)
- `%client-detached` notification (tmux 3.2)

Some features are also exposed by the API but require a newer tmux when
actually called:

- `queryClipboard(client)` — needs tmux **3.3+** (`refresh-client -l`; on tmux 3.2 the control client exits, dropping the connection). On older tmux it rejects with `UnsupportedTmuxVersionError` before sending anything.
- `requestReport(client, ...)` — needs tmux **3.5+** (`refresh-client -r`; tmux 3.4 rejects the flag as unknown). On older tmux it probes the running version first and rejects with a typed `UnsupportedTmuxVersionError` naming the requirement, instead of leaking tmux's raw flag error.
- `newWindow(client, { sessionId, cwd })` with a directory that does not exist starts the pane in `$HOME` rather than rejecting, except on tmux **3.3**, where a spawn bug leaves it in the tmux server's own cwd (while `$PWD` still says `$HOME`).
- `paneCwd(client, paneId)` — needs tmux **3.7+**. It reads the directory the pane's foreground process is in, so straight after `newWindow()` it returns the requested cwd with symlinks resolved (on macOS, `/tmp/x` reads back as `/private/tmp/x`), or tmux's fallback (`$HOME`, or `/` when that is missing too) when that directory is missing. A shell whose startup files `cd` elsewhere can move it before the read. When tmux cannot read the cwd (a dead pane, or a child that has not taken its pty yet) it rejects with `PaneCwdUnavailableError`. Before 3.7, tmux forks the pane before the child changes directory, so an early read can return the server's own cwd; on those versions `paneCwd` rejects with `UnsupportedTmuxVersionError` instead of guessing.
- `setWindowSize` / `clearWindowSize`, and so the window terminal's default `{ window: "box" }` sizing, need tmux **3.3+**. tmux 3.2 reads `refresh-client -C` only as the client's overall size and answers `bad size argument`. A window terminal in box sizing sends the overall size alongside, which tmux 3.2 does apply, so every box size resizes the session's windows and reports `declare-size` on `onError` once; pass `{ window: "tmux", font: 14, fit: "both" }` there.
- `newEmptyWindow(client, { sessionId })` — needs tmux **3.8+** (`new-window -E`; tmux 3.7 rejects the flag as unknown). On older tmux it rejects with `UnsupportedTmuxVersionError` and opens no window.
- `respawnPane(client, paneId, ...)` — needs tmux **3.8+**. Before 3.8, respawning a pane while a control client is attached (which every connection of this library is) can crash the tmux server, ending every session on it; tmux 3.8 fixed it (issue 5498 in its CHANGES). On older tmux it rejects with `UnsupportedTmuxVersionError` and leaves the pane as it was. A raw `respawn-pane` sent through `execute()` is not gated.
- Each of the calls above that needs a newer tmux rejects with `UnrecognizedTmuxVersionError` (carrying the raw reply) when the running tmux reports a version that is not a tmux version shape — e.g. OpenBSD base's `openbsd-7.4` — rather than guessing whether the feature is there.
- `watchServerArgs` — its `no-detach-on-destroy` client flag needs tmux **3.6+**. Older tmux silently ignores it, so the watcher exits when its attached session ends instead of moving to another one; `(await getOwnClient(client)).flags` shows whether the flag took effect.

Some notifications are parsed on every tmux but only emitted by a newer one;
on older tmux the listener simply never fires:

- `%paste-buffer-changed` / `%paste-buffer-deleted` — tmux **3.4+**
- `%message` — tmux **3.4+**
- `%config-error` — tmux **3.4+**

No known breaking changes through tmux 3.7 (the version `SPEC.md` is derived
from).

## Opening a window in a session

`newWindow` opens a window in the session whose id it is given, and starts a
command there:

```ts
import { listSessions, newWindow } from "@promptctl/tmux-control-mode-js";

const session = (await listSessions(client)).find(
  (s) => s.sessionName === "work",
);
if (session === undefined) throw new Error("no session named work");
const { windowId, paneId } = await newWindow(client, {
  sessionId: session.sessionId,
  command: "npm run dev",
  environment: { PORT: "8080" },
  select: true, // omitted: the window opens in the background
  cwd: "/home/me/project", // omitted: where tmux starts a new window there
});
```

The session is named by id because an id is the one session target tmux
resolves to that session or to nothing; a name can also match as a prefix, a
pattern, another session's id or a client. `environment` is for the window's
process alone: the session's environment is not changed.

tmux does not refuse a command that cannot run: the window closes when the
shell exits. To keep that pane and the shell's message on screen (tmux
**3.8+**), open the window empty, set the option, then start the command, each
its own call:

```ts
const { windowId, paneId } = await newEmptyWindow(client, { sessionId });
await client.execute(`set-option -p -t %${paneId} remain-on-exit failed`);
await respawnPane(client, paneId, { command, environment, cwd });
```

The window exists from the first call. If a later one rejects, finish it or
remove it with `kill-window -t @${windowId}`.

While the pane has no process, tmux refuses an attach from a client that has
no terminal and has `TMUX` in its environment, with `sessions should be nested
with care, unset $TMUX to force`. That is every connection `spawnTmux` opens
from a process started inside tmux, whichever server `TMUX` names. Connections
already attached carry on, and the refusal ends when the pane is respawned or
the window removed, so an empty window left behind keeps such a process from
connecting again. A process that may connect in that interval passes
`spawnTmux` an `env` without `TMUX` and names its socket (`socketPath`): with
no `TMUX` and no socket, tmux looks for the default server.

## Watching a whole server

One connection can follow every session on a server as an extra client that
creates, resizes and reconfigures nothing:

```ts
import {
  TmuxClient, spawnTmux, watchServerArgs, watchServerOptions, getOwnClient,
} from "@promptctl/tmux-control-mode-js";

// watchServerOptions: no pane output unless a sink asks for it, and the
// client's sizes kept out of window sizing.
const client = new TmuxClient(
  spawnTmux(watchServerArgs("main")),
  watchServerOptions,
);
const self = await getOwnClient(client);
```

`watchServerArgs()` with no session name attaches to the session a bare
`tmux attach-session` from the same process would land in, for a consumer that
has no name yet, such as one about to call `listSessions`.

- **Attaches, never creates.** `watchServerArgs` attaches to an existing session,
  so the watcher adds no session the user can see. It cannot watch a server that
  has no sessions.
- **Never starts a server.** With none running, tmux exits instead of starting
  one (`-N`), so the user's `tmux.conf`, its hooks and its plugins do not run
  because something tried to watch.
- **Leaves the session's environment alone.** `-E` keeps tmux from copying the
  watcher process's `SSH_AUTH_SOCK`, `DISPLAY` and the rest of
  `update-environment` into the session it attaches to. That covers the attach
  only: a `switch-client` the watcher sends later copies them into the session
  it switches to unless it carries `-E` too.
- **Never resizes.** `ignore-size` keeps the watcher out of window sizing, even if
  it sets a size of its own. Construct the client with `watchServerOptions`:
  without its `ignoreSize`, the client's size methods clear the flag to put it
  into sizing.
- **Outlives sessions, not the server.** `no-detach-on-destroy` moves the watcher
  to another session when its own one ends (`session-changed`). When the last
  session ends, tmux exits as usual and the watcher gets `exit`.
- **Is still a client.** No flag hides the attach itself, and tmux treats it
  like the user's own. While the watcher is attached to a session, a bare
  `tmux attach` passes over that session for one with no client. The attach
  makes the session the most recently used one, which is where a bare
  `tmux attach` lands once the watcher has gone. Alerts on the session's
  current window clear, and the user's `client-attached` and
  `client-session-changed` hooks run.
- **Knows itself.** tmux counts the watcher like any client (`session_attached`,
  `list-clients`, `%client-detached`). Filter it out by `self.name`. tmux silently
  ignores client flags it doesn't know, so `self.flags` shows which ones took
  effect.
- **Every end is reported.** `exit` fires when the last session ends (or, on
  tmux older than 3.6, when the attached one does), when the server dies, or
  when another client detaches the watcher. tmux sends the same bare
  `%exit` for all of these, so the cause isn't reported.
- **A failed attach says why.** When the watcher never attaches, `exit` carries
  tmux's own text as its `reason` (`no server running on …`,
  `can't find session: main`), and every command already sent rejects with a
  `TransportClosedError` whose `reason` is that same text.

Events in other sessions that tmux does not send to a control client are relayed
separately (`cross-session-layout-change`).

## Events over a bridge

The Electron bridge (`TmuxClientProxy`) and the WebSocket bridge
(`WebSocketTmuxClient`) deliver what the shared `TmuxClient` hears from tmux to
every connected peer: tmux's notifications, `unsolicited-response` (tmux's
reply to a command no caller sent: the command line it was started with, a
hook, an `if-shell -b`) and `protocol-error` (a line from tmux the parser
could not read). A peer sees only those that arrive while it is connected, so the
startup command's reply usually comes before any peer. An Electron renderer's
peer lasts one page: a reload, a navigation or a renderer crash ends it as a
closed socket ends a WebSocket peer, taking the page's sizes and subscriptions
with it.

- `cross-session-layout-*` events reach a peer once it calls
  `enableCrossSessionLayoutChange`.
- `connection-state` and `reconnected` describe each client's own connection.
  An Electron renderer mirrors the main process's; a `WebSocketTmuxClient`
  reports its own socket.
- `topology-error` is each client's own: it reports that client's pane table.

## A window in the browser

`./window-terminal` draws one tmux window, every pane in tmux's layout, into
an element with xterm.js, and sends what is typed in a pane to that pane:

```bash
npm i @promptctl/tmux-control-mode-js @xterm/xterm
```

```ts
import "@xterm/xterm/css/xterm.css";
import { WebSocketTmuxClient } from "@promptctl/tmux-control-mode-js/websocket";
import { mountWindowTerminal } from "@promptctl/tmux-control-mode-js/window-terminal";

const connection = new WebSocketTmuxClient({
  url: "ws://localhost:8080",
  reconnect: { maxAttempts: Infinity },
});
const terminal = mountWindowTerminal(document.getElementById("term")!, {
  connection,
  window: "@3",
});
terminal.onState((s) => console.log(s.phase)); // connecting | live | stale | gone
```

`connection` is a `TmuxClient`, a `WebSocketTmuxClient` or the Electron
renderer client. Each pane arrives with `history` lines of scrollback (default
2000) and follows splits, closes and zoom. A click, or `terminal.focus(paneId)`,
picks the pane this page's keys go to; tmux's active pane never moves.
`terminal.dispose()` releases every subscription the terminal holds.

`./window-terminal/react` is the same terminal as a component, and also needs
`react` (and `@types/react` for TypeScript):

```tsx
import { WindowTerminal } from "@promptctl/tmux-control-mode-js/window-terminal/react";

<WindowTerminal connection={connection} window="@3" sizing={sizing} onState={setState} />;
```

A new `connection`, `window` or `history` mounts a new terminal; `sizing` and
`xterm` update the one there is, each on its own, as `terminal.update()` does.
A prop taken away returns to its default.

`xterm` is xterm.js's options for every pane (`ITerminalOptions`): `theme`,
`fontFamily`, `linkHandler`, `cursorStyle`, `disableStdin` and the rest. An
option left out returns to its default. A key xterm.js does not have, a value it refuses, or a `lineHeight` or `letterSpacing` that is not finite throws
`RangeError` at the call that passed it, changing nothing. The terminal sets
the ones tmux or its layout decides, and the type refuses them: `cols` and
`rows`, `fontSize` (`sizing.font`), `scrollback` (`history`), `tabStopWidth`
(tmux's tab stops), `windowOptions` (tmux answers the window reports),
`overviewRuler` (a pane is exactly its cells wide), `allowProposedApi`
(below), `convertEol`, `windowsMode`, `windowsPty` and `documentOverride`.

A pane counts a character's cells as tmux does: an emoji is two, a character
with VS16 two, and a ZWJ sequence or a flag is one character, so whatever
follows lands in tmux's column. tmux takes a codepoint's width from utf8proc
(the platform's `wcwidth` when built without it); the terminal counts as tmux
3.8 does with its default options, utf8proc's table and
`variation-selector-always-wide` on, so a tmux older than 3.8, on another
table, or with either option changed (`codepoint-widths` too) can count a
character differently. Where xterm.js decides rather than the count, it
parts from tmux: a codepoint tmux drops (a combining character, U+3164) in
column 0 takes a cell; a character that would join the one before it (a
combining character, VS16, a skin tone, a flag's second letter, a jamo
vowel, whatever follows a ZWJ) starts a cell of its own after an escape
sequence, such as a color change between the two; and a character that VS16,
a skin tone or a flag's second letter widens in the last column wraps. The
count runs through xterm.js's proposed Unicode API, so `allowProposedApi` is
always on, and an addon that changes `terminal.unicode.activeVersion` as it
loads is an `onError` (`render`), as an addon that throws.

`addons` is a factory each pane calls once, when it opens, for the xterm.js
addons it loads; it is read at mount. An addon that throws as a pane opens is
an `onError` (`render`), and that pane stays empty. Panes are laid out in the
cell their renderer draws, xterm.js's DOM renderer or a renderer addon
(WebGL). xterm.js 6 makes an OSC 8 link with a scheme other than `http:` or `https:` only when `linkHandler` allows it:

```tsx
import type {
  XtermAddons,
  XtermOptions,
} from "@promptctl/tmux-control-mode-js/window-terminal";
import { WebLinksAddon } from "@xterm/addon-web-links";

const activate = (_: MouseEvent, uri: string) => openLink(uri);
const xterm: XtermOptions = {
  linkHandler: { allowNonHttpProtocols: true, activate },
};
const addons: XtermAddons = () => [new WebLinksAddon(activate)];

<WindowTerminal connection={connection} window="@3" xterm={xterm} addons={addons} />;
```

An OSC 8 link's text need not be its URI, so a host that opens one should
show where it goes first.

`sizing` says who decides the window's size:

- `{ window: "box", font }` (the default, at `font: 14`): the element's box
  declares this client's size for the window (`refresh-client -C`), and tmux
  arbitrates with its other clients by its `window-size` option. With
  `font: { min, max }`, the largest font at which `minCols` x `minRows` fit.
- `{ window: "tmux", font, fit }`: tmux's size is given; the largest font at
  which the window fits the box's width, height, both, or (`"none"`) `max`.

The element needs a definite size; what does not fit scrolls inside it.

Things to know:

- One connection has one size. Two terminals on it showing different
  windows both declare it, and the last declaration wins; after its first
  per-window declaration, tmux sizes the session's other windows to it too.
- Nothing withdraws a declared size. `dispose()`, or switching to
  `{ window: "tmux" }`, clears this window's size, and the window then reads
  the connection's overall size, which keeps the last size declared. Only the
  connection's `ignore-size` client flag, or closing it, takes the connection
  out of window sizing.
- Behind a bridge, pages share one tmux client, and each page's sizes are a
  claim of its own on it. A page that closes, with or without `dispose()`,
  leaves the sizes the other pages declared; once no page declares one, the
  client stops counting toward window sizes (`ignore-size`), and the windows
  read the other tmux clients' sizes. tmux counts an `ignore-size` client
  when no other client counts, so with none the windows keep the last size.
  A `WebSocketTmuxClient` that reconnects is a new page to the bridge, so it
  declares its sizes again; a window terminal does.
- With `pane-border-status` set, a pane's cell is taller than its terminal;
  the terminal sits at the top of its cell.
- Floating panes (tmux 3.8) are not shown.

## Idle pane suppression (opt-in)

By default tmux streams output for **every** pane to a control-mode client,
whether or not anything is consuming it. For a client that only watches a few
panes at a time, that is wasted decoding and wire traffic.

Passing `{ idlePaneSuppression: true }` flips on an opt-in layer that pauses any
pane no sink is interested in and resumes it the moment one is:

```ts
const client = new TmuxClient(transport, { idlePaneSuppression: true });

// Every idle pane is paused. Attaching a sink continues exactly the panes its
// scope admits; disposing it re-pauses them when nothing else admits them.
const dispose = client.attachBytesSink(sink, { scope: paneScope(3) });
```

How it works: the library tracks, per pane, the number of attachments whose
scope admits it (`paneScope` + `windowScope` + `sessionScope` + `serverScope`).
When that count crosses 0 ↔ 1 it issues `refresh-client -A <pane>:pause` /
`:continue`. A `serverScope` sink admits every pane, so attaching one keeps
everything live.

- **Default off** — without the option the client behaves exactly as before and
  issues no pause/continue traffic.
- **Per-control-mode-client** — `pause`/`continue` only affect *this* client's
  view. Other tmux clients attached to the same session are untouched.

## A slow command

tmux runs a `TmuxClient`'s commands one at a time, in the order they arrive, so
a slow command holds up every command sent after it on that connection. A
`run-shell` waiting on its process holds up only that connection. A
`capturePane` of a pane with a very long scrollback runs on tmux's single
server thread, so it also stalls every other client of that server while it
runs. `TmuxClient` sets no timeout: tmux cannot cancel a command it has already
received, so a later command waits for the slow one however long the caller
waits.

To bound how long one caller waits, race the command against a timer, and clear
the timer when the race settles:

```ts
import { capturePane } from "@promptctl/tmux-control-mode-js";

async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const capture = await within(5_000, capturePane(client, paneId));
```

The command keeps running in tmux. The client still holds its place in line,
so the reply that arrives later settles the promise you stopped waiting on and
never reaches another command's. To free the commands queued behind a command
that will never finish, `close()` the connection: the queued commands reject
with `TransportClosedError`.

A `WebSocketTmuxClient` call rejects on its own with `BridgeError`
`BRIDGE_TIMEOUT`, but the same holds there: the command keeps running on the
server's `TmuxClient`, and a retry waits behind it.

## Testing

```bash
pnpm test                 # unit tests only (fast, no tmux required)
pnpm run test:integration # integration tests against real tmux
pnpm run test:all         # everything
```

Integration tests are gated behind `TMUX_INTEGRATION=1` so the default test
run is green even on hosts without tmux installed. The integration suite is
the canonical "is this library spec-compliant" check — it exercises every
client method against a real tmux server.

Its conformance gate covers every server→client message in `SPEC.md` §23: each
is either observed live against a real tmux, or carries an in-code exemption
stating why it cannot be provoked deterministically from the test harness. The
`COVERAGE` table in `tests/integration/client.test.ts` is the single source for
that partition — a structural test reconciles it against the SPEC §23 catalogue
and the parser's own message types, so the doc, the parser, and the tests
cannot drift apart, and the gate reddens if any §23 event is left unaccounted.
At present 24 of the 28 events are observed live on tmux 3.4+; on older tmux,
an event whose `COVERAGE` row carries a `minVersion` above it is skipped. The exemptions each carry
their own reason in the `COVERAGE` table: `%config-error`, whose runtime
provocation is silent on the tmux 3.4 baseline, and the flow-control trio
(`%pause`, `%continue`, `%extended-output`), which fire only under read
backpressure the harness cannot create deterministically.

## Demo

`examples/web-multiplexer/` is a reference web multiplexer that exercises the
library end-to-end. It's a Node bridge server (imports `TmuxClient` directly,
spawns your local tmux) plus a browser frontend (React + Mantine + xterm.js)
that talks to the bridge over WebSocket.

```bash
pnpm install   # once at the repo root — workspaces install demo deps; library itself still has zero runtime deps
pnpm run demo  # starts bridge + Vite dev server; open http://localhost:44173
```

The demo connects to your **existing host tmux server** and shows every
session you already have — click one in the sidebar to switch to it, and the
control client will also switch its attached session so notifications follow
your focus. The only requirement is that tmux must have at least one session
(otherwise `attach-session` fails at startup). If your tmux has zero
sessions, create one first:

```bash
tmux new-session -d -s demo
```

The browser imports only TypeScript *types* from `@promptctl/tmux-control-mode-js` — all
protocol parsing and encoding happens in the Node bridge. This proves you can
drive a real web UI with this library without pulling it into the browser
bundle. The demo is not production code (no auth, no multi-user, no
hardening); it exists to validate the library's API and provide an
integration pattern you can copy.

The header toggles between three views, all driven from the same `BridgeClient`:

- **Multiplexer** — the full xterm.js experience: every session, window, and
  pane live, with keystroke forwarding and resize handling. Exercises the
  round-trip input path and pane output rendering.
- **Protocol Inspector** — Wireshark for tmux control mode. Every frame that
  crosses the WebSocket lands in a ring buffer with timing, direction, and
  request/response correlation. Filter by direction, message type, or
  substring; click any row to see decoded payload and jump to its response.
- **Activity Heatmap** — a live grid of every pane in every session, each cell
  glowing in proportion to its current output byte-rate. A decay tick keeps
  quiet panes visible next to loud ones. Click a cell to jump to that pane in
  the multiplexer.
