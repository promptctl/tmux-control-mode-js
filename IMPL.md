# tmux-control-mode-js — Implementation Notes

> **LIBRARY RATIONALE — the home for "what this library does."**
>
> `SPEC.md` and `SPEC_MANIFEST.md` document the tmux **wire protocol**: what tmux
> emits and accepts, derived from the tmux C source and man page. This file is the
> mirror boundary: it documents what **this library** does *on top of* that protocol
> — decoder tolerances, the typed API surface, synthetic events, version policy, and
> lifecycle. The two are kept separate on purpose so neither drifts into the other.
>
> **Every note here is anchored to a real `src/` symbol.** A library note that names
> code which does not exist is the failure mode that retired the previous `IMPL.md`
> (deleted in `redesign-z31.7`, #73, after it accumulated fiction). If you add a note,
> cite the symbol and file; if the symbol moves or dies, the note moves or dies with it.
> `[LAW:one-source-of-truth]` the code is canonical; this prose is derived and must track it.

Library: tmux control-mode client. Protocol floor: tmux 3.2 (see `README.md`
compatibility table). Implementation layering is described in `CLAUDE.md` →
*Architecture*; this file does not restate it.

---

## Status: relocation home (epic `tmux-audit-a91`)

This file was (re)created by **R4** (`tmux-audit-a91.4`) as the destination for
library-behavior notes that the q17 spec-conformance audit found mis-filed inside the
two wire-protocol specs. R4 created the home and the destination map only. **R5**
(`tmux-audit-a91.5`) relocated the SPEC.md library notes — filling IMPL.md §2.1–2.3,
writing the JSDoc-home notes, and deleting the SPEC.md `(library)` blocks. **R6**
(`tmux-audit-a91.6`) did the same for SPEC_MANIFEST.md: it filled §2.4–2.5, deleted the
remaining `(library)` blocks (including the mirror-pair blocks whose shared home R5
already wrote), and trimmed the MANIFEST Invariant 4.1 `Library reliance`/`Why named`
bullets — whose substance already lives in the `processLine` code at its
`[LAW:one-source-of-truth]` annotation. With R6 done, both wire-protocol specs hold
only tmux protocol facts and every library note has exactly one home here or in JSDoc.

The relocation map (§ *Relocation map* below) is the contract those two tickets
implement. Each note has **exactly one** canonical home — never both IMPL.md *and*
JSDoc — so consolidating the three drifting copies does not mint a fourth.
`[LAW:one-source-of-truth]`

---

## 1. Decisions: where each note lives, and why

The audit recommended "IMPL.md **or** JSDoc" for every note. R4 decides per note using
one principle:

- **Single-symbol behavioral contract → JSDoc at that symbol.** A note that describes
  exactly one function/type's tolerance or output shape belongs next to it, where it
  cannot drift from the code and a reader meets it at the callsite.
  `[LAW:locality-or-seam]`
- **Cross-cutting rationale or a multi-symbol relationship → an IMPL.md section.** A
  policy that spans the library (version floor), a design rationale (`-C` vs `-CC`), a state
  machine (connection lifecycle), or a catalogue (typed-method map) has no single host
  symbol, so its home is here.

IMPL.md remains the navigable index for *both* kinds: JSDoc-home notes appear in the
pointer table (§3) — a reference, not a copy.

---

## 2. IMPL.md-home sections

> §2.1–2.3 are the relocated SPEC.md library notes (filled by R5); §2.4–2.5 are the
> relocated SPEC_MANIFEST.md library notes (filled by R6). Each is anchored to a verified
> `src/` symbol.

### 2.1 Transport & control flag (`-C` vs `-CC`) rationale
<!-- R5 (done): relocated from SPEC.md §12.1 "spawnTmux refusal (library)". -->
<!-- R6 (done): deleted the SPEC_MANIFEST.md §2.1 mirror block — its content lives here. -->

Why `spawnTmux` (`src/transport/spawn.ts`; argv built by `buildArgv`) emits
`tmux -C` (single `-C`) and **refuses** `-CC`:

The `-CC` (double control mode) wire contract puts the terminal in raw mode, which
tmux applies by calling `tcgetattr(stdin)` at startup to read the current terminal
attributes — so stdin must be a tty (a PTY is the typical kind; a real terminal
device also qualifies). `spawnTmux` uses `child_process.spawn`, which supplies
**pipe** stdio; `tcgetattr` would fail and tmux would exit before the control-mode
protocol begins. `spawnTmux` therefore emits `-C` only and exposes no option to
request `-CC`, so the incompatible configuration is **unrepresentable by
construction** rather than reached at tmux exit time. `[LAW:types-are-the-program]`

Programmatic consumers should use `-C`: it carries the identical protocol minus the
DCS framing that `-CC` adds (the `\033P1000p` prologue and `\033\\` terminator —
see SPEC.md §12). For terminal-emulator use cases that genuinely require `-CC`
framing, supply a PTY-backed `TmuxTransport` (e.g. built on `node-pty`) in place of
`spawnTmux`; the `-CC` raw-mode configuration belongs in that separate transport.

*(The bare wire facts — `-CC` raw-mode config and the `tcgetattr` tty requirement —
remain in SPEC.md §12 / SPEC_MANIFEST.md §2 with their C-source citations; only this
library rationale lives here.)*

### 2.2 Version-compatibility policy
<!-- R5 (done): relocated from SPEC.md §15.1 "Library note (library)". -->

The library's version-gating stance: tmux **3.2** is the floor; a feature that needs
a newer tmux enforces its own per-command floor and rejects with a typed error rather
than leaking tmux's raw `%error` or silently no-opping. `[LAW:no-silent-failure]`

Concrete case — `requestReport()` (`src/commands/index.ts`) requires tmux **3.5+**.
The `-r` flag to `refresh-client` was not recognized in tmux 3.4 (tmux rejects it with
an unknown-flag error). The minimum is encoded in `src/tmux-compat.ts` as
`REQUEST_REPORT_MIN_VERSION = { major: 3, minor: 5 }`. Because the library supports
tmux 3.2+, `requestReport()` probes the running version in-protocol
(`display-message -p "#{version}"`, a format available since tmux 2.4) via
`queryTmuxVersion()`, and on tmux 3.2–3.4 rejects with a typed
`UnsupportedTmuxVersionError` naming the requirement. The README compatibility table
reflects this constraint.

### 2.3 Synthetic events & connection lifecycle
<!-- R5 (done): relocated from SPEC.md §23.1 "Synthetic Events (library)". -->

The following events are emitted by `TmuxClient` itself and are **NOT** parsed from
tmux wire output — they have no emit site in the tmux C source. They carry lifecycle
state synthesized as the underlying transport transitions, a library superset over the
wire protocol. Type declarations live in `src/connection-state.ts`; both events are
present in `TmuxEventMap` (`src/emitter.ts`).

| Event name | Payload type | Description |
|------------|--------------|-------------|
| `connection-state` | `ConnectionStateMessage` (`{ type: "connection-state"; state: ConnectionState }`) | Emitted on every `ConnectionState` transition. `ConnectionState` is a discriminated union of four statuses: `{ status: "connecting" }` (pre-handshake), `{ status: "ready" }` (tmux is talking), `{ status: "reconnecting"; attempt: number; lastError?: Error }` (between auto-reconnect attempts; currently only WebSocket transport), `{ status: "closed"; reason: "exit" \| "transport-error" \| "disposed" }` (terminal). |
| `reconnected` | `ReconnectedMessage` (`{ type: "reconnected" }`) | Emitted on every transition into `ready` after the first such transition (currently only WebSocket transport). The previous state need not be `reconnecting` — manual close→connect cycles count. The spawn-based `TmuxClient` never emits this. |

Both are subscribable via `client.on("connection-state", ...)` and
`client.on("reconnected", ...)` with full type inference. `output` and
`extended-output` are intentionally **absent** from `TmuxEventMap`; pane bytes route
exclusively through `attachBytesSink`.

### 2.4 Detach vs close
<!-- R6 (done): relocated from SPEC_MANIFEST.md §3.2 "Library detach note" (no SPEC.md mirror). -->

`TmuxClient` has two distinct teardown operations (`src/client.ts`), and the
distinction is a contract a caller must understand to pick correctly — so it lives
here rather than on either method's JSDoc alone:

- **`detach()`** sends the wire-level detach signal: a bare `\n` (the empty line that
  tmux reads as `CLIENT_EXIT`, SPEC_MANIFEST.md §3). It writes that newline straight
  to the transport via the `detachClient()` protocol encoder — it does **not** go
  through `execute()`, because the empty line carries no `%begin`/`%end` guard block
  and so cannot be command-correlated. The tmux server tears the client down and the
  transport closes on the server's exit.
- **`close()`** tears down the underlying transport directly and sends **no** protocol
  signal to tmux. It is the local-side teardown.

`detach()` therefore asks tmux to end the session; `close()` just drops the local
connection. They are deliberately not collapsed: `detach()` cannot be expressed as a
command (no correlation), which is also why it is not one of the free command-functions
in §2.5. `[LAW:single-enforcer]` `execute()` remains the sole command-dispatch path;
`detach()` is the one wire write that is correctly *not* a command.

### 2.5 Typed command-function API map
<!-- R6 (done): relocated from SPEC_MANIFEST.md §26.1 "Library typed operations". -->

The catalogue of the library's typed tmux operations and the wire command each issues.
It spans many symbols, so it has no single host symbol and lives here.

**The shape matters and is easy to get wrong** (the relocated MANIFEST note had it
backwards): `TmuxClient` (`src/client.ts`) is **not** a god-object of per-command
methods. Its only command-related member is `execute(command)` — the sole
command-dispatch path, `[LAW:single-enforcer]`. Every other typed operation is a
**free function** in `src/commands/index.ts` taking `(client: TmuxConnection, …)` and
delegating to `client.execute(…)`; they are composable command *encoders* over the one
enforcer, not methods on the client. (`close()` and `detach()` are the two genuine
`TmuxClient` methods beyond `execute()` — see §2.4 — and `detach()` is intentionally
not a command-function because its bare-newline signal cannot be correlated.)

| Typed operation | Defined in | tmux command issued |
|---|---|---|
| `execute(command)` | `TmuxClient` method (`src/client.ts`) | raw passthrough — the escape hatch for any command without a named wrapper |
| `listWindows(client)` | `src/commands/index.ts` | `list-windows` |
| `listPanes(client)` | `src/commands/index.ts` | `list-panes` |
| `sendKeys(client, target, keys)` | `src/commands/index.ts` | `send-keys -H -t …` (hex bytes; empty keys → synthetic success, no wire send) |
| `splitWindow(client, options?)` | `src/commands/index.ts` | `split-window -h`/`-v` |
| `setSize(client, width, height)` | `src/commands/index.ts` | `refresh-client -C <w>x<h>` |
| `setPaneAction(client, paneId, action)` | `src/commands/index.ts` | `refresh-client -A` (pane flow control) |
| `subscribeRaw(client, name, what, format)` | `src/commands/index.ts` | `refresh-client -B` (subscribe) |
| `unsubscribe(client, name)` | `src/commands/index.ts` | `refresh-client -B <name>` (unsubscribe) |
| `setFlags(client, flags)` | `src/commands/index.ts` | `refresh-client -f` |
| `clearFlags(client, flags)` | `src/commands/index.ts` | `refresh-client -f` (`!`-prefixed to disable) |
| `queryTmuxVersion(client)` | `src/commands/index.ts` | `display-message -p "#{version}"` |
| `requestReport(client, paneId, report)` | `src/commands/index.ts` | `refresh-client -r` (tmux 3.5+; version-gated — see §2.2) |
| `queryClipboard(client)` | `src/commands/index.ts` | `refresh-client -l` |

---

## 3. JSDoc-home notes (pointer index — content lives at the symbol)

These notes' canonical home is **source JSDoc**, not this file. Listed here only so the
relocation home is a complete index. R5/R6 write the JSDoc and delete the source block;
do **not** copy the prose into this file.

| Note (audit) | Documents | JSDoc target | Source incursion(s) |
|---|---|---|---|
| Decoder octal tolerance | how `decodeOctalEscapes` tolerates malformed/partial escapes | `decodeOctalEscapes` — `src/protocol/decode.ts` | SPEC §10.1 + MANIFEST §9.1 (mirror) |
| Parser CRLF tolerance | how `feed()` accepts `\r\n` as well as `\n` | `TmuxParser.feed` — `src/protocol/parser.ts` | SPEC §4.3.1 + MANIFEST §3.1 (mirror) |
| Parsed message types | library `output` vs `extended-output` parsed shapes | `OutputMessage` / `ExtendedOutputMessage` — `src/protocol/types.ts` | SPEC §7.1 (untagged, inline) |
| Notification-block reliance | `processLine`'s reliance on "notifications never appear inside `%begin`/`%end`" | `processLine` — `src/protocol/parser.ts` (where `[LAW:one-source-of-truth]` already lives) | MANIFEST Invariant 4.1 "Library reliance" |
| Size-control mapping | how the library maps size control to the `setSize` command | `setSize` — `src/commands/index.ts` | SPEC §11.1 |

> **Precision note for R5/R6:** `setSize` and `requestReport` are **free functions** in
> `src/commands/index.ts`, *not* `TmuxClient` methods — the R5/R6 ticket text says
> "JSDoc on `TmuxClient.setSize`", which would target a method that does not exist. Put
> the JSDoc on the free functions. `close()` and `detach()` **are** `TmuxClient`
> methods (`src/client.ts`).

---

## 4. Relocation map (R5/R6 traceability)

The complete map. Mirror-pairs share one canonical home; both source blocks are deleted
when their shared home is written. Line numbers are from the audit
(`audit/work-q17/C-library-content.md`) and may shift — locate by section heading.

| # | Topic | Canonical home | Source incursion(s) | Ticket |
|---|---|---|---|---|
| 1 | Decoder octal tolerance | JSDoc `decodeOctalEscapes` | SPEC §10.1 ↔ MANIFEST §9.1 | R5+R6 |
| 2 | Parser CRLF tolerance | JSDoc `TmuxParser.feed` | SPEC §4.3.1 ↔ MANIFEST §3.1 | R5+R6 |
| 3 | Parsed message types | JSDoc `OutputMessage`/`ExtendedOutputMessage` | SPEC §7.1 | R5 |
| 4 | Notification-block reliance | JSDoc `processLine` | MANIFEST Invariant 4.1 | R6 |
| 5 | Size-control mapping | JSDoc `setSize` | SPEC §11.1 | R5 |
| 6 | Transport / `-C` vs `-CC` rationale | IMPL.md §2.1 | SPEC §12.1 ↔ MANIFEST §2.1 | R5+R6 |
| 7 | Version-compat policy | IMPL.md §2.2 | SPEC §15.1 | R5 |
| 8 | Synthetic events / lifecycle | IMPL.md §2.3 | SPEC §23.1 | R5 |
| 9 | Detach vs close | IMPL.md §2.4 | MANIFEST §3.2 | R6 |
| 10 | Typed-method API map | IMPL.md §2.5 | MANIFEST §26.1 | R6 |

**Header trim (C-F14), for R5:** keep SPEC.md's protocol-vs-library boundary statement
(it prevents future incursions); after relocation, reduce the transient `(library)`-
tracking sentence to one line: *"Do not add library notes here; they belong in IMPL.md
or JSDoc."* The same applies to any equivalent tracker line in SPEC_MANIFEST.md.

**Epic invariant (do not violate in R5/R6):** fix the spec to match tmux; never weaken
the library or delete a feature to match the spec. Library behavior is **relocated**
here / to JSDoc, never removed. No `src/` behavior change; the conformance gate
(`tests/integration/client.test.ts`, run via `pnpm run test:all`) must stay green.
