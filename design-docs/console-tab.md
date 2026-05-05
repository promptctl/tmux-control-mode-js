# Console — design

**Status:** design.
**Date:** 2026-05-04 (rev 2026-05-05).
**Scope:** adds a fourth `AppMode` to `examples/web-multiplexer/`,
alongside Multiplexer / Inspector / Heatmap.

---

## What this is

A **Console** tab that turns the browser into a live operator surface
for the underlying tmux server. Two functions, side-by-side:

- **REPL** — type a tmux command, see the response with timing.
- **Format Playground** — pick a target (session/window/pane), type
  a format string, see it evaluated live (one-shot or subscribed).

The Multiplexer tab consumes tmux state. The Inspector observes the
wire. The Console **drives** tmux directly — the third leg of the
table.

---

## Why these two together (and nothing else)

The brainstorm produced five candidates: Format Playground, REPL,
Layout Designer, Key Binding Browser, Snapshot/Restore. The first two
combine into a single coherent tab; the others either belong elsewhere
or want their own design pass.

REPL + Playground share a tab because:

- **Same mental model**: "type something tmux evaluates, see the
  result." Different shape of result (command response vs. format
  substitution), same UI grammar (input → result area).
- **Same UI primitives**: input box, monospaced output, history,
  copy-to-clipboard. Building one builds 80% of the other.
- **Complementary protocol coverage**: REPL exercises
  `%begin`/`%end`/`%error` correlation; Playground exercises formats
  + `%subscription-changed`. Together they make the *whole* command
  side of the protocol tangible.

Layout Designer, Key Binding Browser, Snapshot/Restore are **out of
scope for this doc**.

---

## Integration with the existing app

### App-mode union

`UiStore.AppMode` extends to include `"console"`. Default flow stays
`"multiplexer"`. The persistence guard in `loadFromStorage()` updates
to accept the new value; older sessions fall back to `"multiplexer"`
automatically (forward-compatible).

### `App.tsx`

- New render branch for `appMode === "console"` mounts
  `<ConsoleView>` with the new store and `demoStore`.
- New option in the header `SegmentedControl`. Suggested ordering:
  Multiplexer, Console, Inspector, Heatmap (operator-driving sits
  next to operator-using; diagnostic surfaces trail).
- The current header `SegmentedControl.onChange` maps any unknown
  value to `"multiplexer"`. The trust boundary for invalid persisted
  app modes is the persistence guard in `UiStore`, not the `onChange`
  handler — extend the union exhaustively so the handler stops
  swallowing unknown values silently. Without this, clicking Console
  routes back to Multiplexer.
- `ConsoleStore` lifecycle parallels `InspectorStore` /
  `HeatmapStore`: constructed at mount, explicitly disposed at
  unmount.

### Component layout

```
web/components/
  ConsoleView.tsx              ← top-level shell
  ConsoleRepl.tsx              ← REPL half
  ConsoleFormatPlayground.tsx  ← Playground half
```

Visual: horizontal split on wide viewports, vertical stack below
~900px. REPL on the left/top (busier surface), Playground on the
right/bottom.

---

## State model

A single `ConsoleStore` (MobX) owns all Console-tab state. It mirrors
`InspectorStore` / `HeatmapStore`: bridge-coupled, `dispose()` for
explicit teardown, no React-state crossover.

State the store owns:

- **REPL history** — bounded ring (~200 entries). Persisted commands,
  not persisted response bodies (responses can be huge).
- **Pending-command tracking** — entries transition `pending → ok |
  error` with latency captured at submit time.
- **Playground subscription** — exactly one active at a time.
  Switching target / format / mode mechanically tears down and
  re-subscribes inside the store, never inside a component effect.
- **Playground evaluation result** — one-shot value or subscribed
  latest snapshot, plus the tmux error string when present.

Architectural rules (the load-bearing constraints; implementation
details belong in the tickets):

- REPL entries are **discriminated by `status`**, not a nullable
  bag-of-fields. Each variant carries only the fields it can
  populate; TypeScript narrows from `status` alone. State transitions
  *replace* entries in the array — variants change shape, so
  in-place mutation is wrong.
- The bounded ring **never evicts a pending entry**. A pending
  entry's resolution must always find a slot.
- Subscription lifecycle is owned by the store. `dispose()` is the
  single tear-down point. Component mount/unmount does not start or
  stop subscriptions.
- Target picker reads from `demoStore.sessions` / `windows` / `panes`
  — `[LAW:one-source-of-truth]`. No separate enumeration.
- Every REPL submit runs the same pipeline regardless of outcome —
  `[LAW:dataflow-not-control-flow]`. Status is data, not control flow.

---

## Wire / library: nothing new required

The Console reuses existing seams. The REPL submits commands through
the same execute path the rest of the app already uses. The Playground
one-shot mode goes through that same execute path; subscribed mode
rides the existing format-subscription channel and its
`%subscription-changed` event flow. No new bridge wire messages, no
new library API, no new event types — Console is purely a new
*consumer* of surfaces that already exist. Exact tmux command
syntax for subscribe / unsubscribe / one-shot evaluation is verified
against tmux source during implementation; it is not a design-doc
concern.

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
- The visible **[clear]** button is the only clear path. Chord
  shortcuts are intentionally not bound: the app-level keymap
  already bypasses regular text inputs, so a chord would not fire
  from the focused REPL input; and Ctrl+L collides with the
  browser's address-bar shortcut.
- Latency rendered next to the command, color-coded
  (green ≤25ms, yellow ≤200ms, red >200ms).
- Error responses render with a red gutter; ok responses neutral.
- Each row supports click-to-copy (Mantine `CopyButton`).

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
  `demoStore.sessions` / `windows` / `panes`, plus a synthetic
  "Active pane" entry resolving at request time.
- **Mode toggle** = Mantine `SegmentedControl`. Switching modes
  triggers store-side teardown + restart of the appropriate flow.
- **Presets** are a small fixed set (≤6) of useful formats, not
  user-editable in v1. Possible v2: persisted custom presets
  (deferred — see Open questions).
- **Result area** shows the value (mono, no highlighting) or the
  tmux error string in red. Subscription mode shows the latest
  snapshot + an update counter; previous values are not retained.

### Header

The existing header `SegmentedControl` gains a fourth option in the
suggested order above. No other header changes.

---

## Persistence

Light-touch additions to `UiStore`:

| Field                           | Persisted? | Why |
|---|---|---|
| `appMode === "console"`         | yes (existing) | already round-trips. |
| `console.commandHistory` (≤50)  | yes        | recall across reloads is table stakes for a REPL. |
| `console.lastFormat`            | yes        | iterating on a format and reloading mid-iteration is common. |
| `console.lastTarget`            | yes        | sticky targeting matches operator expectation. |
| `console.lastMode`              | yes        | mode preference. |
| In-flight REPL response bodies  | **no**     | responses can be huge; commands are enough to seed recall. |

On boot the store hydrates the recall buffer from the persisted
command list. Persisted commands are *recall-available*, not rendered
as past history.

---

## Edge cases (the production bar)

- **Unmount during a pending command.** The store outlives the view
  (owned by `App.tsx`); the resolution still lands. Switching back
  shows the resolved entry.
- **Live subscription across tab switches.** Subscription stays
  alive — tmux keys subscriptions by name and rate-limits per-name,
  so leaving it active costs nothing visible. Tear-down only on
  `dispose()`.
- **Bridge disconnects mid-command.** The execute call rejects; the
  entry transitions to the error variant carrying the actual error
  message — never a swallowed log.
- **Multiline command output.** Command responses are
  line-oriented; render preserving line breaks, no newline collapse.
- **Format with embedded single quotes.** Single-quote escaping for
  shell-quoted format strings is owned by the store, not by callers
  — format strings round-trip through tmux safely regardless of
  embedded quotes. Test fixture: `it's`.
- **Format that produces empty output.** Render `(empty)` in dimmed
  gray. Distinguishes "evaluated to empty" from "subscription hasn't
  fired yet."
- **Subscription that never fires.** Some formats depend on state
  that doesn't change. Show last value with the update counter; no
  spinner, no false "loading" state.

---

## What "production quality" means concretely

- Discriminated state for REPL entries — `status` is the discriminant,
  no nullable bag-of-fields.
- MobX store with explicit lifecycle, not React state.
- Persistence via the existing `UiStore` reaction pattern.
- Subscription lifecycle owned by the store, mechanically prevents
  leaks.
- Bounded ring for history; no unbounded growth; pending entries
  never evicted.
- Errors surface the actual tmux error message, not a swallowed
  `console.error`.
- Target picker pulls from `demoStore` (one source of truth); does
  not re-enumerate sessions/windows/panes.
- Architectural law markers (`[LAW:one-source-of-truth]`,
  `[LAW:dataflow-not-control-flow]`) on the new store.
- No `any`.

---

## Tracking

Implementation tracked via `lit` under epic
`tmux-showcase-bhx.25` with three children:

- `.25.1` — store + UiStore integration + tab shell (foundation;
  blocks both panes).
- `.25.2` — REPL pane.
- `.25.3` — Format Playground pane.

The foundation blocks both panes; the panes are independent. Per
`.planning/STATE.md`, no new phase artifacts under `.planning/phases/`.

---

## Open questions

- **Multiline commands in REPL.** Single-line covers >99% of usage
  and is much simpler. Argument for multiline: `if-shell` /
  `bind-key` syntax. Lean single-line for v1; revisit if operator
  usage demands.
- **Custom user presets in the Playground.** v2 candidate; persist
  through `UiStore`. Out of scope for v1.
- **Rate-limit of subscription pushes.** tmux throttles
  `%subscription-changed` to 1Hz per subscription. Fine for the
  Playground display; document via tooltip on the update counter.

---

## Non-goals

- Not reimplementing tmux's `choose-tree` / `command-prompt` TUI
  affordances inside the browser.
- Not a generic shell. The Console REPL takes tmux commands; shell
  commands belong in panes.
- Not a configuration editor. `.tmux.conf` editing is out of scope.
- Not a tmux replacement. We drive tmux via control mode; we do not
  reimplement multiplexing in JS.

---

## Future tabs (out of scope, listed for context)

The brainstorm's other ideas remain viable. Each warrants its own
design when its turn comes:

- **Layout designer** — visual splitter editor.
- **Snapshot/restore** — needs the fidelity question answered (TUI
  processes don't survive `send-keys` replay).
- **Key Binding Browser** — likely a side panel rather than a tab.
