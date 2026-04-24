# Keymap

`tmux-control-mode-js` ships a headless keymap engine that turns raw key events into tmux actions. It lets UI consumers hand off the "user pressed `C-b c`, so create a window" boilerplate to the library without forcing any particular UI stack (xterm, Electron, React, plain DOM) onto everyone.

The module is exported at a separate subpath:

```ts
import {
  bindKeymap,
  defaultTmuxKeymap,
  handleKey,
  parseChord,
} from "tmux-control-mode-js/keymap";
```

It is pure, has no runtime dependencies, and does not import the transport layer — so it is safe to use in the browser, in Deno/Bun, or in a worker. The only thing that ever touches `TmuxClient` is the thin dispatcher in `bindKeymap`, which takes a structural `TmuxCommander` interface that many clients (including the WebSocket bridge in `examples/web-multiplexer`) already satisfy.

---

## What it does, and what it deliberately doesn't

**In scope (MVP):**

- Tmux's prefix keytable — the bindings you get by pressing `C-b` followed by another key.
- Window operations: create, kill, cycle, jump-to-index, rename, last.
- Pane operations: split (horizontal / vertical), cycle, kill, zoom, break, swap, resize, select by direction.
- Session/client operations: detach, next/previous session, choose-tree, command-prompt.

**Explicitly out of scope (for now):**

- **Copy-mode.** tmux's copy-mode is a server-side mode with its own keytable. A client-side JS reimplementation would fight the server. For now, `C-b [` is not a recognized chord — it falls through as an unhandled key and the UI can let tmux handle it if it wishes (e.g., by not consuming the `C-b` that precedes it, or by sending the chord as literal keys).
- **The root keytable.** Only the prefix table is wired. Keys pressed *without* the prefix are returned to the caller as "not handled" so the UI can route them wherever it already does (typically: straight to the focused pane via `send-keys`).
- **Focus tracking.** Every dispatched tmux command relies on tmux's implicit "current client" targeting — e.g. `new-window` applies to the client's current session automatically. The library owns no per-client focus state. If you need to target a specific pane or session explicitly, either `switch-client` first or build a custom dispatcher (see [Custom dispatchers](#custom-dispatchers)).

---

## Architecture at a glance

Three layers, same split as the rest of the library (protocol / transport / client):

```
┌──────────────────────────────────────────────────────────────┐
│  UI adapter   (xterm, Electron, plain DOM, TUI)              │
│     translates native KeyboardEvent → KeyEvent and feeds it  │
│     to binding.handleKey(event)                              │
└────────────────────────┬─────────────────────────────────────┘
                         │ KeyEvent
                         ▼
┌──────────────────────────────────────────────────────────────┐
│  bindKeymap  (src/keymap/bind.ts)                            │
│     stateful closure: owns the KeymapState, calls the pure   │
│     engine, then dispatches each emitted Action through a    │
│     TmuxCommander.                                           │
└────────────────────────┬─────────────────────────────────────┘
                         │ Action
                         ▼
┌──────────────────────────────────────────────────────────────┐
│  Pure engine  (src/keymap/engine.ts)                         │
│     (event, state, keymap) → { state, actions, handled }     │
│     Zero I/O. Zero dependencies. Trivially testable.         │
└──────────────────────────────────────────────────────────────┘
```

The pure engine is the core; `bindKeymap` is a ~150-line convenience wrapper that exists so you don't have to reimplement the `Action` → tmux command table. If you need to, you can call the engine directly and wire your own dispatcher.

---

## Concepts

### `KeyEvent`

A neutral, platform-independent key-event shape:

```ts
interface KeyEvent {
  readonly key: string;     // "a", "Enter", "ArrowUp", "%", "1"
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}
```

The `key` field uses the [`KeyboardEvent.key`](https://developer.mozilla.org/en-US/docs/Web/API/UI_Events/Keyboard_event_key_values) vocabulary — `"ArrowUp"`, not `"Up"` — because that's what browsers give you. When writing keymaps by hand, use `parseChord` so you don't have to remember the exact spellings.

### `parseChord(chord: string) → KeyEvent`

Parse tmux-style chord notation:

```ts
parseChord("C-b")    // ctrl:true,  key:"b"
parseChord("M-x")    // alt:true,   key:"x"
parseChord("S-Tab")  // shift:true, key:"Tab"
parseChord("Up")     // key:"ArrowUp"      (tmux "Up" maps to browser "ArrowUp")
parseChord("%")      // key:"%",    no modifiers
parseChord("C-Left") // ctrl:true,  key:"ArrowLeft"
```

Modifier prefixes: `C-` (control), `M-` (alt/meta in emacs notation), `S-` (shift), `D-` (meta key on macOS / super/win elsewhere). These can be combined: `C-M-x` is Ctrl+Alt+x.

### `Action`

A discriminated union of every intent a bound chord can produce. A few examples:

```ts
{ type: "new-window" }
{ type: "split", orientation: "horizontal" | "vertical" }
{ type: "select-window", index: 3 }
{ type: "select-pane", direction: "up" | "down" | "left" | "right" }
{ type: "resize-pane", direction: "up", amount: 5 }
{ type: "detach" }
// ...and 13 more
```

See `src/keymap/actions.ts` for the full list. Adding your own action means extending this union (see [Custom actions](#custom-actions)).

### `Keymap`

A plain-data description of prefix + bindings:

```ts
interface Keymap {
  readonly prefix: KeyEvent;
  readonly bindings: readonly ChordBinding[];
}

interface ChordBinding {
  readonly chord: KeyEvent;
  readonly action: Action;
}
```

This is *data*, not code. A custom keymap is just a different array of bindings — no subclassing, no config DSL, no registration functions.

### `KeymapState`

```ts
type KeymapState = { mode: "root" } | { mode: "prefix" };
```

- `root`: the default. Keys flow through the UI to the pane as normal.
- `prefix`: the user has pressed the prefix chord and the engine is waiting for the second keystroke.

The engine is stateless *per call*. The state is passed in and returned out. `bindKeymap` holds it in a closure so consumers don't have to thread it through event handlers.

### The engine function

```ts
function handleKey(
  event: KeyEvent,
  state: KeymapState,
  keymap: Keymap,
): {
  state: KeymapState;
  actions: readonly Action[];
  handled: boolean;
};
```

Contract:

| Current state | Event               | New state | Actions       | `handled` |
| ------------- | ------------------- | --------- | ------------- | --------- |
| `root`        | prefix chord        | `prefix`  | `[]`          | `true`    |
| `root`        | anything else       | `root`    | `[]`          | `false`   |
| `prefix`      | bound chord         | `root`    | `[the action]`| `true`    |
| `prefix`      | unbound chord       | `root`    | `[]`          | `true`    |

The `handled` flag is how the UI knows whether to also route the key somewhere (back to the pane, to the menu system, etc.). **Unhandled = "I didn't do anything with this; it's still yours."**

Unbound keys *in prefix mode* are swallowed silently — same as tmux's own behavior when you press an unbound key after the prefix.

### `bindKeymap(client, keymap) → KeymapBinding`

The convenience layer. Creates a closure with the state machine and an `Action` → tmux-command dispatcher.

```ts
interface KeymapBinding {
  handleKey(event: KeyEvent): boolean;
}
```

`handleKey` returns the same `handled` flag as the pure engine, so the calling code has one branch to take.

### `TmuxCommander`

The minimal interface the dispatcher needs:

```ts
interface TmuxCommander {
  execute(command: string): unknown;   // send a raw tmux command
  detach(): void;                      // detach this client from tmux
}
```

`TmuxClient` satisfies it structurally. So does the `BridgeClient` used by the demo's WebSocket bridge. So does any fake you write in a unit test. No inheritance, no registration — if it has those two methods, it works.

---

## Quickstart

### Node / CLI / headless scripts

```ts
import { spawnTmux, TmuxClient } from "tmux-control-mode-js";
import { bindKeymap, defaultTmuxKeymap, parseChord } from "tmux-control-mode-js/keymap";

const transport = spawnTmux(["attach-session", "-t", "main"]);
const client = new TmuxClient(transport);
const bound = bindKeymap(client, defaultTmuxKeymap());

// Simulate: C-b c
bound.handleKey(parseChord("C-b"));
bound.handleKey(parseChord("c"));
// tmux just created a new window in session "main"
```

### Browser (xterm.js)

The `attachCustomKeyEventHandler` hook on xterm runs *before* xterm decides what bytes to send via `onData`. Return `false` and the key is swallowed — perfect for us:

```ts
import { Terminal } from "@xterm/xterm";
import { bindKeymap, defaultTmuxKeymap } from "tmux-control-mode-js/keymap";

// client must expose execute(cmd: string) and detach() —
// a thin WebSocket bridge usually already does.
const bound = bindKeymap(client, defaultTmuxKeymap());
const term = new Terminal();
term.open(containerEl);

term.attachCustomKeyEventHandler((ev) => {
  if (ev.type !== "keydown") return true;
  const consumed = bound.handleKey({
    key: ev.key,
    ctrl: ev.ctrlKey,
    alt: ev.altKey,
    shift: ev.shiftKey,
    meta: ev.metaKey,
  });
  // `false` = xterm must NOT process this key. The keymap engine has
  // already dispatched any resulting tmux command.
  return !consumed;
});

term.onData((data) => {
  // Reached only when the keymap handler returned true (key not consumed).
  client.sendKeys(`%${paneId}`, data);
});
```

This is the exact pattern used in `examples/web-multiplexer/web/pane-terminal.ts`.

### Plain DOM / React (no xterm)

```ts
const bound = bindKeymap(client, defaultTmuxKeymap());

window.addEventListener("keydown", (ev) => {
  const consumed = bound.handleKey({
    key: ev.key,
    ctrl: ev.ctrlKey,
    alt: ev.altKey,
    shift: ev.shiftKey,
    meta: ev.metaKey,
  });
  if (consumed) ev.preventDefault();
});
```

### Electron main process

```ts
// After the BrowserWindow is ready
win.webContents.on("before-input-event", (event, input) => {
  if (input.type !== "keyDown") return;
  const consumed = bound.handleKey({
    key: input.key,
    ctrl: input.control,
    alt: input.alt,
    shift: input.shift,
    meta: input.meta,
  });
  if (consumed) event.preventDefault();
});
```

---

## Default bindings

These are the bindings tmux ships with, minus copy-mode. Prefix is `C-b`.

### Windows

| Chord       | Action                                 | tmux command dispatched |
| ----------- | -------------------------------------- | ----------------------- |
| `C-b c`     | new-window                             | `new-window`            |
| `C-b n`     | next-window                            | `next-window`           |
| `C-b p`     | previous-window                        | `previous-window`       |
| `C-b l`     | last-window                            | `last-window`           |
| `C-b &`     | kill-window                            | `kill-window`           |
| `C-b 0`–`9` | select-window at that index            | `select-window -t :N`   |

### Panes

| Chord       | Action               | tmux command dispatched      |
| ----------- | -------------------- | ---------------------------- |
| `C-b %`     | horizontal split     | `split-window -h`            |
| `C-b "`     | vertical split       | `split-window -v`            |
| `C-b o`     | next pane            | `select-pane -t :.+`         |
| `C-b x`     | kill pane            | `kill-pane`                  |
| `C-b z`     | zoom pane            | `resize-pane -Z`             |
| `C-b !`     | break pane           | `break-pane`                 |
| `C-b {`     | swap with previous   | `swap-pane -U`               |
| `C-b }`     | swap with next       | `swap-pane -D`               |
| `C-b ↑/↓/←/→`   | select pane by direction | `select-pane -U/-D/-L/-R` |
| `C-b C-↑/↓/←/→` | resize pane by 5 rows/cols | `resize-pane -U/-D/-L/-R 5` |

### Sessions / client

| Chord       | Action           | tmux command dispatched |
| ----------- | ---------------- | ----------------------- |
| `C-b d`     | detach           | (LF on stdin)           |
| `C-b (`     | previous session | `switch-client -p`      |
| `C-b )`     | next session     | `switch-client -n`      |
| `C-b s`     | choose session   | `choose-tree -s`        |
| `C-b :`     | command prompt   | `command-prompt`        |

---

## Customizing

### Change the prefix

The default is `C-b`. For `C-a` (screen-style):

```ts
import { defaultTmuxKeymap, parseChord } from "tmux-control-mode-js/keymap";

const keymap = {
  ...defaultTmuxKeymap(),
  prefix: parseChord("C-a"),
};
const bound = bindKeymap(client, keymap);
```

### Add or replace bindings

The `Keymap` is plain data. Start from the default, filter/append, pass it to `bindKeymap`:

```ts
import { defaultTmuxKeymap, parseChord } from "tmux-control-mode-js/keymap";

const base = defaultTmuxKeymap();

const keymap = {
  ...base,
  bindings: [
    ...base.bindings,
    // Extra binding: C-b | for a horizontal split (an ergonomic alias for %)
    { chord: parseChord("|"), action: { type: "split", orientation: "horizontal" } },
    // And C-b - for a vertical split
    { chord: parseChord("-"), action: { type: "split", orientation: "vertical" } },
  ],
};
```

Later bindings in the array win over earlier ones for the same chord, so you can override defaults by appending.

### Build a keymap from scratch

```ts
import { parseChord } from "tmux-control-mode-js/keymap";
import type { Keymap } from "tmux-control-mode-js/keymap";

const minimal: Keymap = {
  prefix: parseChord("C-Space"),
  bindings: [
    { chord: parseChord("c"), action: { type: "new-window" } },
    { chord: parseChord("x"), action: { type: "kill-pane" } },
    { chord: parseChord("|"), action: { type: "split", orientation: "horizontal" } },
    { chord: parseChord("-"), action: { type: "split", orientation: "vertical" } },
  ],
};
```

---

## Custom dispatchers

If the built-in dispatcher's assumptions don't fit (e.g., you want to target a specific pane explicitly, or log every action, or route some actions through a UI widget instead of tmux), skip `bindKeymap` and drive the engine yourself:

```ts
import {
  handleKey,
  INITIAL_STATE,
  defaultTmuxKeymap,
  type KeymapState,
} from "tmux-control-mode-js/keymap";

const keymap = defaultTmuxKeymap();
let state: KeymapState = INITIAL_STATE;

function onKey(ev: KeyboardEvent): boolean {
  const result = handleKey(
    { key: ev.key, ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey, meta: ev.metaKey },
    state,
    keymap,
  );
  state = result.state;

  for (const action of result.actions) {
    dispatch(action);
  }
  return result.handled;
}

function dispatch(action: Action): void {
  switch (action.type) {
    case "choose-session":
      // Override: show our own session picker instead of tmux's choose-tree.
      openOurSessionPicker();
      return;
    case "command-prompt":
      // Override: show our own command palette.
      openCommandPalette();
      return;
    default:
      // Everything else: delegate to the built-in translation.
      defaultDispatch(client, action);
  }
}
```

This is how you build a first-class UI around tmux: keep the chord-recognition engine, override the actions you care about.

### Targeting a specific pane

`bindKeymap`'s built-in dispatcher uses tmux's implicit current-client targeting. If you need to target a specific session/pane (e.g., you have a multi-session UI where the UI-selected session ≠ tmux's current), write your own dispatcher that appends `-t <target>`:

```ts
function targetedDispatch(paneId: number, action: Action): void {
  switch (action.type) {
    case "new-window":
      client.execute(`new-window -t %${paneId}`);
      return;
    case "split":
      client.execute(
        `split-window -${action.orientation === "vertical" ? "v" : "h"} -t %${paneId}`,
      );
      return;
    // ...
  }
}
```

The engine stays pure; the variability is in the dispatcher.

---

## Custom actions

If you want actions that aren't tmux commands — show a modal, open a devtools panel, trigger an app feature — extend the `Action` union in your own code:

```ts
import type { Action as BaseAction } from "tmux-control-mode-js/keymap";

type AppAction =
  | BaseAction
  | { type: "open-settings" }
  | { type: "toggle-inspector" };

const keymap: Keymap = {
  prefix: parseChord("C-b"),
  bindings: [
    ...base.bindings,
    { chord: parseChord(","), action: { type: "open-settings" } as AppAction },
    { chord: parseChord("?"), action: { type: "toggle-inspector" } as AppAction },
  ],
};
```

Then your custom dispatcher handles the extra variants and delegates the rest.

---

## Gotchas and design notes

### "Not handled" vs. "swallow"

Root-mode: "not a prefix" → `handled: false`, UI sends the key to the pane as usual.
Prefix-mode: "unbound chord" → `handled: true`, key is swallowed. This matches tmux's own behavior (`C-b Q` does nothing, the `Q` doesn't reach the pane).

If you prefer the `C-b <unbound>` case to forward both keys to the pane, write a custom dispatcher on top of the pure engine that detects the prefix-mode-unbound case by comparing `handled === true && actions.length === 0`.

### Timeouts

Tmux has a `repeat-time` / `escape-time` concept; this library does not. Once the user presses the prefix, the engine stays in prefix mode until the next keystroke, no matter how long that takes. In practice, this is rarely noticeable — the time between two keystrokes in a chord is typically milliseconds. If you need a timeout, wrap `bindKeymap` and call `handleKey` with a synthesized no-op event (or reset state externally) when your timer fires.

### Single engine per client session

The engine state is per-binding. If you instantiate multiple `KeymapBinding`s, each has its own state — which is almost certainly wrong if they share a `TmuxClient`: pressing `C-b` in one pane would leave the *other* panes' keymaps still in root mode.

The demo solves this by putting one binding on the `DemoStore`, shared across all `PaneTerminal` instances. Do the same in your app.

### Meta keys in browsers

`KeyboardEvent.metaKey` is the `⌘` key on macOS and the Win/Super key on other platforms. `KeyboardEvent.altKey` is `⌥` / Alt. If you want consistent bindings across platforms, prefer `ctrl` chords (like tmux itself does — the default prefix is `C-b` precisely because it's the most portable).

### Why no `forward` action?

An earlier design emitted a `forward` action for unbound prefix-mode keys. We dropped it: the same outcome is cleaner via `handled: false` in root mode (caller sends), and swallow-on-unbound-in-prefix mirrors tmux. Mixing "please send these keys through" as an action muddied the dispatcher and required a second encoder path to send key names (vs. literal text). The current design: the library decides *what* to do; the caller decides *what to do with keys the library doesn't care about*.

---

## Complete API reference

Module: `tmux-control-mode-js/keymap`

### Types

```ts
interface KeyEvent {
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

type Action =
  | { type: "new-window" }
  | { type: "next-window" }
  | { type: "previous-window" }
  | { type: "last-window" }
  | { type: "select-window"; index: number }
  | { type: "kill-window" }
  | { type: "split"; orientation: "horizontal" | "vertical" }
  | { type: "select-pane"; direction: "up" | "down" | "left" | "right" }
  | { type: "next-pane" }
  | { type: "kill-pane" }
  | { type: "zoom-pane" }
  | { type: "break-pane" }
  | { type: "swap-pane"; direction: "next" | "previous" }
  | { type: "resize-pane"; direction: "up" | "down" | "left" | "right"; amount: number }
  | { type: "detach" }
  | { type: "next-session" }
  | { type: "previous-session" }
  | { type: "choose-session" }
  | { type: "command-prompt" };

interface ChordBinding {
  readonly chord: KeyEvent;
  readonly action: Action;
}

interface Keymap {
  readonly prefix: KeyEvent;
  readonly bindings: readonly ChordBinding[];
}

type KeymapState = { mode: "root" } | { mode: "prefix" };

interface HandleResult {
  readonly state: KeymapState;
  readonly actions: readonly Action[];
  readonly handled: boolean;
}

interface TmuxCommander {
  execute(command: string): unknown;
  detach(): void;
}

interface KeymapBinding {
  handleKey(event: KeyEvent): boolean;
}
```

### Functions

```ts
function parseChord(chord: string): KeyEvent;
function keysEqual(a: KeyEvent, b: KeyEvent): boolean;

function handleKey(
  event: KeyEvent,
  state: KeymapState,
  keymap: Keymap,
): HandleResult;

function defaultTmuxKeymap(): Keymap;

function bindKeymap(client: TmuxCommander, keymap: Keymap): KeymapBinding;
```

### Constants

```ts
const INITIAL_STATE: KeymapState;   // { mode: "root" }
```

---

## Related files

- `src/keymap/engine.ts` — pure state machine
- `src/keymap/actions.ts` — `Action` union
- `src/keymap/key-event.ts` — `KeyEvent`, `parseChord`, `keysEqual`
- `src/keymap/default-keymap.ts` — tmux default bindings
- `src/keymap/bind.ts` — `bindKeymap` + built-in dispatcher
- `tests/unit/keymap/*.test.ts` — engine + dispatcher unit tests (pure, no tmux)
- `tests/integration/keymap.test.ts` — end-to-end against a real tmux server
- `examples/web-multiplexer/web/store.ts` — demo: creates the shared binding
- `examples/web-multiplexer/web/pane-terminal.ts` — demo: wires xterm's `attachCustomKeyEventHandler`
