# Console — a new tab in `examples/web-multiplexer/`

**Status:** design. Implementation-ready.
**Date:** 2026-05-04
**Scope:** adds a fourth `AppMode` to the existing app, alongside
Multiplexer / Inspector / Heatmap.

---

## What this is

A **Console** tab that turns the browser into a live operator surface
for the underlying tmux server. Two functions, side-by-side:

- **REPL** — type a tmux command, see the response with timing.
- **Format Playground** — pick a target (session/window/pane), type a
  format string, see it evaluated live (one-shot or subscribed).

The Multiplexer tab consumes tmux state. The Inspector observes the
wire. The Console **drives** tmux directly — it's the third leg of
the table.

---

## Why these two together (and nothing else)

The original brainstorm had five candidates: Format Playground, REPL,
Layout Designer, Key Binding Browser, Snapshot/Restore. The first two
combine into a single coherent tab; the others either belong
elsewhere or want their own design pass.

Reasons REPL + Playground share a tab:

- **Same mental model** for the user: "type something tmux evaluates,
  see the result." Different *shape* of result (command response vs.
  format substitution), same UI grammar (input → result area).
- **Same UI primitives** — input box, monospaced output, history,
  copy-to-clipboard. Building one builds 80% of the other.
- **Complementary coverage of the protocol**: REPL exercises
  `%begin`/`%end`/`%error` correlation; Playground exercises formats
  + `%subscription-changed`. Together they make the *whole* command
  side of the protocol tangible.

Layout Designer, Key Bindings, Snapshot/Restore are **out of scope
for this doc**. Each is a viable future tab; none belongs in Console.

---

## Integration with the existing app

### `UiStore.AppMode`

Add `"console"` to the union, default flow stays `"multiplexer"`:

```ts
// ui-store.ts
export type AppMode = "multiplexer" | "inspector" | "heatmap" | "console";
```

Update the persistence guard in `loadFromStorage()` and the
`SegmentedControl` data array in `App.tsx` to include the new value.
The persisted-shape migration is forward-compatible — older sessions
fall back to `"multiplexer"` automatically.

### `App.tsx`

One new branch in the existing rendering switch:

```tsx
{uiStore.appMode === "inspector" ? (
  <InspectorView ... />
) : uiStore.appMode === "heatmap" ? (
  <HeatmapView ... />
) : uiStore.appMode === "console" ? (
  <ConsoleView store={consoleStore} demoStore={demoStore} />
) : currentSession === null ? (
  ...
)}
```

`ConsoleStore` is constructed in `App.tsx` next to `InspectorStore`
and `HeatmapStore`, with the same lifecycle (constructed once via
`useMemo`, disposed in the `useEffect` cleanup).

### Component layout

```
web/components/
  ConsoleView.tsx          ← top-level layout (split, header)
  ConsoleRepl.tsx          ← REPL half
  ConsoleFormatPlayground.tsx ← Playground half
```

Visual: horizontal split via Mantine `Grid` on wide viewports, vertical
stack below ~900px width. REPL on the left/top (it's the busier
surface), Playground on the right/bottom.

---

## State model

Single `ConsoleStore`, MobX, follows the `InspectorStore` /
`HeatmapStore` pattern (constructed with the bridge, has a `dispose()`).

```ts
// console-store.ts
import { makeAutoObservable, runInAction } from "mobx";
import type { TmuxBridge } from "./bridge.ts";
import type { CommandResponse } from "../../../src/protocol/types.js";

export type ReplEntryStatus = "pending" | "ok" | "error";

export interface ReplEntry {
  readonly id: number;
  readonly command: string;
  readonly issuedAt: number;
  status: ReplEntryStatus;
  response: CommandResponse | null;
  latencyMs: number | null;
  errorMessage: string | null;
}

export type PlaygroundMode = "one-shot" | "subscribed";

export interface PlaygroundTarget {
  readonly kind: "session" | "window" | "pane";
  readonly tmuxId: string; // "$1" | "@3" | "%7"
  readonly label: string;  // human-readable for the picker
}

export class ConsoleStore {
  // REPL
  readonly history: ReplEntry[] = [];      // bounded ring (default 200)
  draft: string = "";
  historyCursor: number | null = null;     // for up/down recall
  private nextId = 1;

  // Playground
  format: string = "#{session_name}: #{window_name} → #{pane_current_command}";
  target: PlaygroundTarget | null = null;  // null = current active pane
  mode: PlaygroundMode = "one-shot";
  oneShotResult: string | null = null;
  oneShotError: string | null = null;
  subscriptionResult: string | null = null;
  subscriptionUpdates: number = 0;
  private subscriptionName: string | null = null;
  private subscriptionDispose: (() => void) | null = null;

  constructor(private readonly bridge: TmuxBridge) {
    makeAutoObservable(this, {}, { autoBind: true });
  }

  dispose(): void {
    void this.teardownSubscription();
  }

  // ... methods below
}
```

Key design points:

- **Bounded history ring** — `MAX_REPL_ENTRIES = 200`. When exceeded,
  drop the oldest. No unbounded growth.
- **No `any`, no swallowed errors** — `ReplEntry.status` is a
  discriminated state, not an optional response. A failed command
  renders the error inline and stays in history.
- **Playground subscription is owned by the store**, never by a
  component effect. `dispose()` on the store is the single tear-down
  point. Switching `target` or `format` while subscribed transparently
  re-subscribes (no leaked subscriptions).
- **`autoBind: true`** so methods can be passed as event handlers
  without `bind` boilerplate.

### Methods (sketches)

```ts
async submit(): Promise<void> {
  const command = this.draft.trim();
  if (command.length === 0) return;
  const entry: ReplEntry = {
    id: this.nextId++,
    command,
    issuedAt: Date.now(),
    status: "pending",
    response: null,
    latencyMs: null,
    errorMessage: null,
  };
  this.appendEntry(entry);
  this.draft = "";
  this.historyCursor = null;

  const start = performance.now();
  try {
    const response = await this.bridge.execute(command);
    runInAction(() => {
      entry.status = response.error ? "error" : "ok";
      entry.response = response;
      entry.latencyMs = performance.now() - start;
    });
  } catch (err) {
    runInAction(() => {
      entry.status = "error";
      entry.errorMessage = err instanceof Error ? err.message : String(err);
      entry.latencyMs = performance.now() - start;
    });
  }
}

recallPrev(): void { /* walk historyCursor back */ }
recallNext(): void { /* walk historyCursor forward */ }
clear(): void { this.history.length = 0; }

setFormat(s: string): void { this.format = s; void this.refresh(); }
setTarget(t: PlaygroundTarget | null): void { this.target = t; void this.refresh(); }
setMode(m: PlaygroundMode): void { this.mode = m; void this.refresh(); }

private async refresh(): Promise<void> {
  await this.teardownSubscription();
  this.mode === "subscribed"
    ? await this.startSubscription()
    : await this.runOneShot();
}

private async runOneShot(): Promise<void> {
  const target = this.targetSpec(); // "" if null → current
  const cmd = `display-message -p ${target} -F '${escapeFormat(this.format)}'`;
  const resp = await this.bridge.execute(cmd);
  runInAction(() => {
    this.oneShotResult = resp.error ? null : resp.lines.join("\n");
    this.oneShotError = resp.error ? resp.lines.join("\n") : null;
  });
}

private async startSubscription(): Promise<void> { /* refresh-client -B + onEvent listener */ }
private async teardownSubscription(): Promise<void> { /* refresh-client -u + dispose listener */ }
```

**Important:** `escapeFormat` and the format string itself are sent
unmodified except for shell-quote-escaping of single quotes. The
Playground is for the *operator*; we do not validate or rewrite
their format. tmux's error message is the truth.

---

## Wire / library: nothing new required

- REPL → `bridge.execute()` (already exists).
- Playground one-shot → `bridge.execute("display-message -p ...")`.
- Playground subscribed → `bridge.execute("refresh-client -B name::format")`
  + listening to `subscription-changed` events on the bridge.
- Tear-down → `bridge.execute("refresh-client -u name")`.

No new bridge wire messages. No new library API. The
`subscription-changed` event ships through `TmuxBridge.onEvent`,
same path InspectorStore uses.

---

## UI specifics

### REPL pane

```
┌─ REPL ──────────────────────────────── [clear] ┐
│ #1  display-message test              12ms      │
│     OK: test                                    │
│ #2  list-sessions -F '#{session_name}'  4ms     │
│     OK: 0                                       │
│         demo                                    │
│ #3  bogus-command                     6ms  ✗   │
│     ERROR: unknown command: bogus-command       │
│ ...                                             │
├─────────────────────────────────────────────────┤
│ > [_______________________________] [Send]      │
└─────────────────────────────────────────────────┘
```

- Up/Down recalls history into the input.
- Enter submits. (Multiline commands deferred — see Open questions.)
- Ctrl+L clears history (matches tmux/shell convention).
- Latency rendered next to the command, color-coded
  (green ≤25ms, yellow ≤200ms, red >200ms).
- Error responses render with a red gutter; ok responses neutral.
- Each history row is selectable; click to copy via Mantine
  `CopyButton`.

### Playground pane

```
┌─ Format Playground ─────────────────────────────────────┐
│ Target: [ Active pane ▾ ]                                │
│ Mode:   ( ) One-shot   (•) Subscribed   updates: 12      │
│                                                          │
│ Format:                                                  │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ #{session_name}: #{window_name} → #{pane_current...} │ │
│ └──────────────────────────────────────────────────────┘ │
│ Presets: [#{pane_active}] [#{pane_pid}] [#{T:status-l}]  │
│                                                          │
│ Result:                                                  │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ 0: vim → nvim                                        │ │
│ └──────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

- **Target picker** is a Mantine `Select` populated from
  `demoStore.sessions`/`windows`/`panes` — *one source of truth*,
  per `[LAW:one-source-of-truth]`. Plus a synthetic "Active pane"
  entry that resolves to whatever the current active pane is at
  request time. No duplicate enumeration.
- **Mode toggle** = Mantine `SegmentedControl`. Switching modes
  triggers `setMode()` which tears down any live subscription and
  starts the appropriate flow.
- **Presets** are a small fixed set (≤6) of useful formats —
  not user-editable in v1. v2 can persist user-saved presets through
  UiStore; flag in open questions, don't build.
- **Result area** shows either the value (mono, no highlighting),
  or the tmux error message in red. Subscription-mode result is the
  latest snapshot; previous values are not retained (no log, just a
  counter so the operator sees pushes are arriving).

### Header

The existing header `SegmentedControl` (mode picker) gets a fourth
option:

```tsx
data={[
  { label: "Multiplexer", value: "multiplexer" },
  { label: "Console",     value: "console" },
  { label: "Inspector",   value: "inspector" },
  { label: "Heatmap",     value: "heatmap" },
]}
```

Order: Multiplexer first (default), Console second (operator-driving
sits next to operator-using), Inspector and Heatmap after (diagnostic).

---

## Persistence

Light-touch additions to `UiStore`:

| Field | Default | Persisted? | Why |
|---|---|---|---|
| `appMode === "console"` | no | yes (existing) | already round-trips. |
| `console.commandHistory` (last N strings) | `[]` | yes | recall across reloads is table stakes for a REPL. |
| `console.lastFormat` | preset | yes | iterating on a format and reloading mid-iteration is common. |
| `console.lastTarget` | active | yes | sticky targeting matches operator expectation. |
| `console.lastMode` | one-shot | yes | mode preference. |
| Live response history (the `ReplEntry` ring with responses) | n/a | **no** | responses can be huge; persist only commands. |

Persist commands as a flat `string[]` capped at 50. On boot,
`ConsoleStore` reads them from `UiStore` and seeds the up-arrow
recall buffer (without rendering them as past history — they're
"available to recall," not "things I just ran").

---

## Edge cases (the production bar)

- **Unmount during pending command.** A `ReplEntry` in `pending`
  state when the user switches tabs: do not abort. The bridge call
  is in flight; let it resolve into history naturally. The store is
  owned by `App.tsx`, not the view, so the `runInAction` patch lands
  even when the view is unmounted. Switching back shows the resolved
  entry.
- **Live subscription across tab switches.** Switching away from
  Console: subscription stays alive (cheap — tmux keys by name and
  rate-limits per subscription). The store outlives the view.
  Subscription is torn down only on `dispose()`, which fires when
  the bridge tears down or the app unmounts.
- **Bridge disconnects mid-command.** REPL command in flight when
  bridge closes: the `bridge.execute()` promise rejects. The catch
  branch transitions the entry to `error` with the error message.
  UI shows the failure.
- **Multiline command output.** `CommandResponse.lines` is already
  an array of strings. Render with `<pre>` semantics; do not
  collapse newlines.
- **Format with embedded single quotes.** `escapeFormat` doubles
  any `'` into `'\''` for the shell-quoted form. Test fixture: a
  format containing `it's`.
- **Format that produces empty output.** Render `(empty)` in
  dimmed gray, not blank. Otherwise the operator can't tell
  "evaluated to empty" from "subscription hasn't fired yet."
- **Subscription that never fires.** A format that depends on
  state that doesn't change won't push events. Show last value
  with the update counter; no spinner, no false "loading" state.

---

## What "production quality" means concretely

- ✅ Discriminated state for `ReplEntry`, no optional-bag-of-fields.
- ✅ MobX store with explicit lifecycle, not React state.
- ✅ Persistence via the existing `UiStore` reaction pattern (one
  source of truth for persistent UI).
- ✅ Subscription lifecycle owned by the store, mechanically
  prevents leaks.
- ✅ Bounded ring for history; no unbounded growth.
- ✅ Errors render visibly with the actual tmux error message.
- ✅ Target picker pulls from `demoStore` (one source); does not
  re-enumerate sessions/windows/panes from tmux.
- ✅ Architectural law markers (`[LAW:one-source-of-truth]`,
  `[LAW:dataflow-not-control-flow]`) on the store, matching
  existing conventions.
- ✅ No `any`. Discriminated unions where state has multiple shapes.

---

## Implementation order

1. `console-store.ts` — full state model, methods, dispose.
2. `ui-store.ts` — extend `AppMode` union, persistence shape, guards.
3. `ConsoleView.tsx` — layout shell.
4. `ConsoleRepl.tsx` — input + history + recall + clear.
5. `ConsoleFormatPlayground.tsx` — picker + format input + result + mode toggle.
6. `App.tsx` — wire store construction, dispose, render branch, header
   `SegmentedControl` option.
7. Tests — at minimum: store unit tests for REPL submit (ok / error /
   pending → resolved), Playground subscribe/teardown idempotency,
   `escapeFormat` round-trip with embedded quotes.

Lands as one phase under `.planning/phases/`. The full app is
testable end-to-end once #6 is wired; #7 is concurrent.

---

## Open questions

- **Multiline commands in REPL.** Single-line is much simpler to
  build and covers >99% of usage. Argument for multiline:
  `if-shell` / `bind-key` syntax. Lean single-line for v1; revisit
  if operator usage demands.
- **Should the Playground share a session with `demoStore`'s
  subscriptions?** The store sends its own
  `refresh-client -B playground::...`; the bridge already has
  `sessions`/`windows`/`panes` subscriptions named separately. They
  don't collide (tmux keys subscriptions by name) but they do
  generate two listener fan-outs. Acceptable; flag if perf shows up
  in profiling.
- **Subscription rate vs. UI render rate.** tmux rate-limits
  `%subscription-changed` to once per second per subscription. Fine
  for the playground display, but if the operator picks a
  fast-changing format (`#{cursor_x}`) we still update at 1Hz. No
  action needed; document in the UI as a tooltip on the update
  counter.

---

## Future tabs (out of scope here, listed for context)

The other ideas from the brainstorm are still good. Each warrants
its own design doc when its turn comes:

- **Layout designer** — visual splitter editor; needs its own pane
  geometry model.
- **Snapshot/restore** — needs the fidelity question answered (TUI
  processes don't survive `send-keys` replay).
- **Key binding browser** — likely a side panel rather than a tab.
