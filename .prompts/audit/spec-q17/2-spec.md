# Audit: /Users/bmf/code/tmux-control-mode-js/SPEC.md

## Scope
- Spec file: /Users/bmf/code/tmux-control-mode-js/SPEC.md
- Source modules in scope: src/index.ts, src/client.ts, src/protocol/**, src/transport/spawn.ts, src/transport/types.ts, src/transport/sockets.ts, src/tmux-compat.ts, src/emitter.ts, src/connection-state.ts, src/errors.ts
- Source commit SHA: 1fe97c59058e6dcb1de7e47969f3d06529610cfe
- Audit date: 2026-05-24
- Ticket: tmux-audit-q17 (Audit 2/4: Spec accuracy)

## Coverage notes

- Modules read end-to-end:
  - src/index.ts
  - src/client.ts
  - src/protocol/types.ts
  - src/protocol/parser.ts
  - src/protocol/encoder.ts
  - src/protocol/decode.ts
  - src/transport/spawn.ts
  - src/transport/types.ts
  - src/tmux-compat.ts
  - src/emitter.ts
  - src/connection-state.ts
  - src/errors.ts
- Modules grep-sampled only:
  - src/transport/sockets.ts — `grep -n -i "spec\|protocol\|control-mode"` returned one unrelated jsdoc match; the file does not make protocol claims that SPEC.md describes. The three exported helpers (`tmuxSocketDir`, `listTmuxSocketNames`, `isTmuxServerAlive`) ARE public-API surface; their omission from SPEC.md is rolled into the public-API omission finding.
- Modules not examined:
  - src/connectors/**, src/keymap/** — SPEC.md makes no claims about connector or keymap layers; per scope these are downstream consumers of `src/protocol/**` and `src/client.ts`.
- Test files read (per P0 cross-check rule, one file only):
  - tests/integration/client.test.ts — read once end-to-end to assess whether P0 findings would invalidate conformance assertions.
- Spec sections examined (every numbered section of SPEC.md):
  - §1 Overview — read.
  - §2 Entering Control Mode — read (incl. §2.1 Variants, §2.2 Initialization Sequence, §2.3 Teardown).
  - §3 Identifier Prefixes — read.
  - §4 Command Input — read (incl. §4.1, §4.2, §4.3, §4.4).
  - §5 Command Response Protocol — read (incl. §5.1, §5.2, §5.3, §5.4).
  - §6 Notifications — read (incl. §6.1, §6.2, §6.3).
  - §7 Notification Reference — read (§7.1 through §7.12).
  - §8 Exit Handling — read.
  - §9 Client Flags — read.
  - §10 Data Encoding — read.
  - §11 Client Size Control — read.
  - §12 DCS Wrapping (`-CC` Mode) — read.
  - §13 Pane Control — read.
  - §14 Subscriptions — read.
  - §15 Reports — read.
  - §16 Backpressure and Flow Control — read (incl. §16.1, §16.2).
  - §17 Internal Buffering — read (incl. §17.1 through §17.4).
  - §18 Pane Output Integration — read.
  - §19 Clipboard Query — read.
  - §20 Data Structures — read; entirely tmux C-source structures, not library types.
  - §21 Format Variables — read.
  - §22 Control Mode Behavioral Differences — read.
  - §23 Complete Message Reference — read.
  - §24 Source File Reference — read; describes the tmux source tree, not this library.
  - §25 Known Man Page vs Code Discrepancies — read.

## Findings

### F1 — SPEC.md documents tmux internals but never declares the library's public API surface

- Severity: P2 (omission)
- Category: omission
- Spec location: SPEC.md as a whole (all sections — no §dedicated to library API)
- Source location: src/index.ts:1-21 (canonical export manifest); src/client.ts:68-355 (every public method on `TmuxClient`); src/protocol/types.ts:275-280 (`CommandResponse`); src/connection-state.ts:21-32 (`ConnectionState`); src/errors.ts:42-55 (`TmuxCommandError`).
- Claim in spec:
  > (no section in SPEC.md names `TmuxClient`, `spawnTmux`, `TmuxTransport`, `SpawnOptions`, `CommandResponse`, `TmuxMessage`, `ConnectionState`, `TmuxCommandError`, `PaneAction`, `TmuxEventMap`, `TmuxClientLike`, `tmuxSocketDir`, `listTmuxSocketNames`, or `isTmuxServerAlive`. A literal `grep` for every public export of `src/index.ts` against SPEC.md returns zero hits.)
- Reality in source:
  > src/index.ts:1-21 exports a complete library surface — class (`TmuxClient`), error (`TmuxCommandError`), enum (`PaneAction`), spawn helper (`spawnTmux`), socket-listing helpers (`tmuxSocketDir`, `listTmuxSocketNames`, `isTmuxServerAlive`), and type aliases (`TmuxClientLike`, `SplitOptions`, `ConnectionState`, `CommandResponse`, `TmuxMessage`, `TmuxEventMap`, `TmuxTransport`, `SpawnOptions`). SPEC.md describes the *wire protocol* tmux speaks but does not describe how `TmuxClient` maps that protocol onto promises, events, or types. A consumer reading SPEC.md as "the library's spec" cannot determine the return type of `client.execute()`, the name of any event, the existence of the FIFO correlation queue, the shape of `CommandResponse`, that errors are thrown as `TmuxCommandError`, that pane output is decoded into `Uint8Array`, or which methods exist at all.
- Recommendation: Add a "Library API" section to SPEC.md that mirrors `src/index.ts` exports and the public methods of `TmuxClient`, declares the shape of `CommandResponse` and `TmuxMessage` (or links to `src/protocol/types.ts` as the type source of truth), names the events emitted via `client.on(...)`, and states the `TmuxCommandError` rejection contract. The remediation may choose to split this into a sibling `API.md` and have SPEC.md link to it — what matters is that SPEC.md ceases to be silent about the library it ostensibly specifies. Sub-findings F2..F8 below are specific instances of this larger omission that should also be cleaned up in passing.

### F2 — `%output` / `%extended-output` `<value>` is documented as octal-escaped but the library exposes decoded `Uint8Array`

- Severity: P2 (omission)
- Category: omission
- Spec location: SPEC.md §7.1 lines 268-269, lines 286-287; SPEC.md §10
- Source location: src/protocol/types.ts:34-45 (`OutputMessage.data: Uint8Array`, `ExtendedOutputMessage.data: Uint8Array`); src/protocol/parser.ts:65-87 (parser invokes `decodeOctalEscapes(value)`); src/protocol/decode.ts:36-79 (decoder).
- Claim in spec:
  > - `<value>`: octal-escaped output data (see Section 10)
  > …
  > | `value`   | Octal-escaped output data (same encoding as `%output`) |
- Reality in source:
  > The library's `OutputMessage` and `ExtendedOutputMessage` carry `data: Uint8Array` — not the octal-escaped wire string. The parser at src/protocol/parser.ts:69 (`data: decodeOctalEscapes(value)`) decodes before emission. The decoder at src/protocol/decode.ts:36-79 also drops literal control bytes (< 0x20) and replaces malformed escapes with `?`. SPEC.md describes the wire and gestures at §10 for the encoding, but never tells the library consumer that the `data` field on parsed messages is the decoded byte array, not the raw escaped text — and never documents the malformed-escape `?` substitution or literal-control-byte drop the library performs.
- Recommendation: At §7.1 (and §10), add a paragraph: "The library's `OutputMessage.data` and `ExtendedOutputMessage.data` carry the *decoded* bytes as `Uint8Array`. Malformed octal escapes are recovered as the byte `?` (0x3F); literal bytes < 0x20 in the wire stream (which the encoding rule guarantees never occur from tmux but may appear as transport noise) are dropped."

### F3 — §11 documents three `refresh-client -C` forms; the library wraps only one of them

- Severity: P2 (omission)
- Category: omission
- Spec location: SPEC.md §11 lines 717-725
- Source location: src/protocol/encoder.ts:28-30 (`refreshClientSize(width, height)`); src/client.ts:204-206 (`setSize(width, height)`).
- Claim in spec:
  > ```
  > refresh-client -C <width>x<height>
  > refresh-client -C @<window-id>:<width>x<height>
  > refresh-client -C @<window-id>:
  > ```
  >
  > - First form: sets overall client size
  > - Second form: sets size for a specific window
  > - Third form: clears per-window size override
- Reality in source:
  > src/protocol/encoder.ts:28-30:
  > ```
  > function refreshClientSize(width: number, height: number): string {
  >   return buildCommand(`refresh-client -C ${width}x${height}`);
  > }
  > ```
  > and src/client.ts:204-206 exposes only `setSize(width, height)`. Of the three forms catalogued in §11, only form 1 has a typed wrapper. Forms 2 and 3 (per-window size, per-window clear) are reachable only via the untyped `client.execute("refresh-client -C @1:80x24")` escape hatch. SPEC.md presents the three forms as a single capability list without indicating which are surfaced as typed methods and which are not.
- Recommendation: Annotate §11 with which forms the library exposes as typed methods (form 1 via `setSize`) and which require `client.execute("…")` (forms 2 and 3). Either add typed wrappers for forms 2 and 3, or state explicitly that they are intentionally only reachable through `execute()`.

### F4 — §12 describes `-CC` behavior without telling library consumers that `spawnTmux` rejects `-CC`

- Severity: P2 (omission)
- Category: omission
- Spec location: SPEC.md §2.1 line 38, §12 lines 733-751
- Source location: src/transport/spawn.ts:105-113.
- Claim in spec:
  > | `-CC` | Control mode with echo disabled. Additionally sets `CLIENT_CONTROLCONTROL` (`0x4000`). Stdin and stdout share a single bidirectional socket. A DCS escape sequence is used to frame the session (see Section 12). |
  > …
  > ## 12. DCS Wrapping (`-CC` Mode)
  >
  > When started with `-CC` (double control mode):
- Reality in source:
  > src/transport/spawn.ts:105-113 throws unconditionally when `controlControl: true`:
  > ```
  > if (controlControl) {
  >   throw new Error(
  >     "spawnTmux: controlControl (-CC) mode requires PTY-backed stdio, " +
  >       "which child_process.spawn cannot provide. Use -C mode for " +
  >       "programmatic clients (it carries the identical protocol), or " +
  >       "supply a custom transport built on node-pty. " +
  >       "See SPEC.md §12 for details.",
  >   );
  > }
  > ```
  > The error message points readers AT SPEC §12 for context, but §12 itself does not state the implication. A consumer who reads §12 without reading the source has no way to know that the typical entry point (`spawnTmux`) hard-refuses `-CC` and that the PTY-backed transport is the consumer's responsibility to supply. The inner-audit finding F10 flags this against SPEC_MANIFEST; this outer-layer instance is in SPEC.md.
- Recommendation: At §12 add an "Implementation note" subsection: "`spawnTmux` (the library's default transport) refuses `-CC` because tmux calls `tcgetattr(stdin)` at startup, which fails on `child_process.spawn`'s pipe stdio. Programmatic clients should use `-C` (it carries the identical protocol). For terminal-emulator use cases that require `-CC` framing, supply a PTY-backed `TmuxTransport` (e.g., built on `node-pty`)."

### F5 — §15 (Reports) omits the tmux version floor that the library enforces

- Severity: P3 (under-cited / ambiguous)
- Category: omission
- Spec location: SPEC.md §15 lines 808-829
- Source location: src/tmux-compat.ts:23-27 (`REQUEST_REPORT_MIN_VERSION = { major: 3, minor: 5 }`); the test file at tests/integration/client.test.ts:31-39 skips the requestReport test when tmux is older than this floor.
- Claim in spec:
  > ```
  > refresh-client -r <pane-id>:<report>
  > ```
  >
  > Allows a control mode client to provide terminal reports (such as OSC 10/11
  > color responses) on behalf of a pane. The report is parsed for color values
  > which are stored as `wp->control_fg` and `wp->control_bg`.
  > …
  > Note: `-r` does NOT require `CLIENT_CONTROL` (it operates on the client's tty).
- Reality in source:
  > src/tmux-compat.ts:23-27:
  > ```
  > /**
  >  * `client.requestReport()` sends `refresh-client -r`, which tmux 3.4
  >  * rejects as an unknown flag. Available from tmux 3.5+.
  >  */
  > export const REQUEST_REPORT_MIN_VERSION: TmuxVersion = { major: 3, minor: 5 };
  > ```
  > The library's overall floor is tmux 3.2 (`MIN_TMUX_VERSION` at src/tmux-compat.ts:21) but `refresh-client -r` was added in 3.5 — older tmux rejects it as an unknown flag. SPEC.md §15 gives a "Note" about `CLIENT_CONTROL` but says nothing about the 3.5 floor. The library's own conformance test (tests/integration/client.test.ts:31-39, 303) skips the requestReport assertion when tmux < 3.5; a consumer following SPEC.md alone would not know to gate on tmux version.
- Recommendation: Add to §15: "Available from tmux 3.5+ (`refresh-client -r` is rejected as an unknown flag by older tmux). The library exports `REQUEST_REPORT_MIN_VERSION` from `src/tmux-compat.ts` for runtime gating."

### F6 — §4.3 documents tmux's "no CR stripping" rule; the library's parser DOES strip trailing CR

- Severity: P2 (omission)
- Category: omission
- Spec location: SPEC.md §4.3 lines 111-115
- Source location: src/protocol/parser.ts:322-336.
- Claim in spec:
  > ### 4.3 Line Reading
  >
  > Lines are read using `EVBUFFER_EOL_LF` (LF-terminated, no CR stripping).
  >
  > **Source:** `control.c:557`
- Reality in source:
  > src/protocol/parser.ts:322-336:
  > ```
  > let newlineIdx = this.buffer.indexOf("\n");
  > while (newlineIdx !== -1) {
  >   // Drop a trailing \r so CRLF transports parse identically to LF ones.
  >   // The reference treats \r as line-driver noise; protocol lines and
  >   // command-response text never depend on it (real \r in pane output is
  >   // octal-escaped and handled in decodeOctalEscapes).
  >   const end =
  >     newlineIdx > 0 && this.buffer.charCodeAt(newlineIdx - 1) === 0x0d
  >       ? newlineIdx - 1
  >       : newlineIdx;
  >   const line = this.buffer.slice(0, end);
  >   …
  > }
  > ```
  > §4.3 documents tmux's input-side behavior (LF-only, no CR stripping). The library's parser, which consumes tmux's *output*, deliberately strips a trailing `\r` before the `\n` — defensively, against transports that introduce CRLF. SPEC.md is silent about this deviation; a reader reconciling §4.3 with the parser code would assume the parser also enforces "no CR stripping" and break it on the next refactor. (The inner audit catalogues the same behavior as F7 against SPEC_MANIFEST §3; this is the SPEC.md-side restatement of the rule that needs the parallel note.)
- Recommendation: At §4.3 add: "Library parser note: `TmuxParser.feed()` strips a trailing `\r` before the `\n` so CRLF-introducing transports parse identically to LF-only ones. This is library-side defensive behavior, not a tmux rule."

### F7 — §7.8 (paste-buffer-changed / paste-buffer-deleted) cites collision-overlapping man-page line ranges

- Severity: P3 (under-cited / ambiguous)
- Category: under-cited
- Spec location: SPEC.md §7.3 line 336, §7.8 lines 528, 538, §7.2 line 310
- Source location: n/a — this is purely a SPEC.md citation hygiene issue; the underlying parsers (src/protocol/parser.ts:270-271, src/protocol/types.ts:181-189) match the documented wire formats.
- Claim in spec:
  > §7.3 `%pane-mode-changed`:
  > > **Source:** `control-notify.c:34-39`, `tmux.1:7969-7971`
  > §7.8 `%paste-buffer-changed`:
  > > **Source:** `control-notify.c:242`, `tmux.1:7969-7971`
  > §7.8 `%paste-buffer-deleted`:
  > > **Source:** `control-notify.c:255`, `tmux.1:7972-7973`
  > §7.2 `%pause`:
  > > **Source:** `control.c:383` (explicit), `control.c:455` (age-triggered), `tmux.1:7973-7975`
- Reality in source:
  > Three different notifications (`%pane-mode-changed`, `%paste-buffer-changed`) cite the *same* man-page line range `tmux.1:7969-7971`, which cannot be correct — a man-page range describes one section. Similarly `tmux.1:7972-7973` (paste-buffer-deleted) overlaps `tmux.1:7973-7975` (pause). The library's parsers and types for all three notifications match the documented wire format, so this is citation hygiene only — but per the project's SPECIAL RULE that upstream citations are the ground truth, these collisions undermine the spec's claim to be "derived from tmux source code (version next-3.7, commit 5c30b145)" (SPEC.md:3-4).
- Recommendation: Re-derive the correct man-page line ranges from the cited tmux commit for `%pane-mode-changed`, `%paste-buffer-changed`, and `%paste-buffer-deleted`. The library code under audit is correct; the SPEC's citations are the only thing wrong here.

### F8 — §6.3 hook table has a `window-unlinked`/`window-linked` entry pair the library never observes as such; §6.2's link/unlink phrasing is the actually-observable rule

- Severity: P3 (under-cited / ambiguous)
- Category: ambiguity
- Spec location: SPEC.md §6.3 lines 239-240 ("Hook-to-Notification Mapping"); §6.2 lines 219-228
- Source location: src/protocol/parser.ts:256-262 (PARSERS for `window-add`, `window-close`, `unlinked-window-add`, `unlinked-window-close`); the integration test at tests/integration/client.test.ts:460-477 demonstrates the linked-vs-unlinked observable: killing a window in the only-session case produces `%unlinked-window-close`, not `%window-close`.
- Claim in spec:
  > | Hook Name | Control Notify Function | Notification(s) |
  > | …
  > | `window-unlinked` | `control_notify_window_unlinked` | `%window-close` or `%unlinked-window-close` |
  > | `window-linked` | `control_notify_window_linked` | `%window-add` or `%unlinked-window-add` |
- Reality in source:
  > The hook→notification mapping says hook `window-unlinked` may produce either `%window-close` or `%unlinked-window-close`, but does not state in §6.3 itself which one is sent when (§6.2 supplies the rule indirectly: "Window linked vs unlinked logic: … If found in the client's session, sends `%window-*`; otherwise sends `%unlinked-window-*`."). A reader of §6.3 alone cannot predict which notification will arrive. The library exposes both variants as separate `TmuxMessage` discriminants (src/protocol/types.ts:91-115); the integration test at tests/integration/client.test.ts:460-477 has to use `nextMessage(c, "unlinked-window-close")` rather than `"window-close"` because, in the single-session test setup, `kill-window` unlinks the window from the receiving client's session BEFORE the close notification fires. SPEC.md §6.3's "or" formulation is the correct upstream description but is decoupled from the rule that determines the actual variant; the cross-reference to §6.2 should be explicit at §6.3.
- Recommendation: At each `…` or `…` row of §6.3, add `(see §6.2 for which variant is sent)` so a reader landing on §6.3 first doesn't have to discover §6.2's link/unlink rule by reading the rest of the document.

### F9 — §23 ("Complete Message Reference") is incomplete: omits the `connection-state` / `reconnected` synthetic events the emitter actually delivers

- Severity: P2 (omission)
- Category: omission
- Spec location: SPEC.md §23 lines 1087-1126 ("Complete Message Reference")
- Source location: src/connection-state.ts:44-51 (`ConnectionStateMessage`, `ReconnectedMessage`); src/emitter.ts:23-26, 51-56 (`EmitterMessage = TmuxMessage | ConnectionStateMessage | ReconnectedMessage`, `TmuxEventMap` includes `"connection-state"` and `"reconnected"` keys); src/client.ts:128-132 (TmuxClient emits `connection-state` events).
- Claim in spec:
  > ## 23. Complete Message Reference
  >
  > ### Server-to-Client Messages
  >
  > | Message | Arguments | Source |
  > | …
  > | `%exit` | `[<reason>]` | `client.c:424-427` |
  >
  > ### Client-to-Server Messages
  >
  > Any valid tmux command, newline-terminated. An empty line causes detach.
- Reality in source:
  > §23 claims to be the "Complete Message Reference" but lists only wire-level `%`-prefixed notifications. The library's emitter (src/emitter.ts:51-56) delivers TWO additional synthetic events that consumers subscribe to via `client.on("connection-state", …)` and `client.on("reconnected", …)` — these are NOT tmux wire messages but they ARE part of the public event API and ARE listed in `TmuxEventMap`. A consumer reading §23 to enumerate "every event I can subscribe to" will miss these two and may add ad-hoc connection-state tracking elsewhere, duplicating state the library already owns. Per the cross-layer rule that SPEC.md should match `src/index.ts` exports, this is a P2 omission (an export not mentioned in SPEC.md).
- Recommendation: Add a short §23.1 or supplementary table after the wire-message table titled "Synthetic events" listing `connection-state` (with the `ConnectionState` payload shape) and `reconnected` (no payload), with a sentence stating these come from the client/transport layer, not the wire.

### F10 — §9 names the `wait-exit` flag and §8 documents `CLIENT_CONTROL_WAITEXIT`, but the library has no observable wait-exit machinery distinct from `detach()`/transport close

- Severity: P3 (under-cited / ambiguous)
- Category: ambiguity
- Spec location: SPEC.md §8 lines 655-657, §9 line 686
- Source location: src/client.ts:295-308 (`detach()` and `close()`); src/protocol/encoder.ts:188-192 (`detachClient()` returns `"\n"`); grep for `wait-exit` in `src/` returns one hit at src/protocol/encoder.ts:112 in a doc-comment listing flag names accepted by `refresh-client -f`.
- Claim in spec:
  > §8: After `%exit`:
  > > 1. If `CLIENT_CONTROL_WAITEXIT` is set: the client blocks reading stdin until
  > >    an empty line or EOF is received before actually exiting.
  > §9 flag table:
  > > | `wait-exit` | `CLIENT_CONTROL_WAITEXIT` (`0x200000000ULL`) | Wait for empty line on stdin before exiting |
- Reality in source:
  > The library accepts `wait-exit` as a flag name string (it flows through `setFlags(["wait-exit"])` unchanged into the `refresh-client -f` payload — src/protocol/encoder.ts:124-130), but exposes no API for the post-`%exit` "block until empty line" behavior the flag triggers. The library's existing `detach()` (src/client.ts:295-297) sends a bare LF, which IS the empty-line trigger described in §8, but SPEC.md does not connect these two surfaces: a consumer wanting to use `wait-exit` cannot tell from SPEC.md (a) whether the library cooperates with it at all, (b) which library method sends the unblocking empty line, or (c) what observable difference the flag makes. The behavior is mostly upstream-tmux-internal, but the spec presents the flag as if it's a feature the library exposes.
- Recommendation: At §9's `wait-exit` row add: "When set, tmux blocks its own exit until the library sends `\n` on stdin (the `detach()` method, src/client.ts) or the transport closes. The library does not synthesize this empty line automatically." This pairs the spec claim with the actually-callable library operation.

### F11 — §10 encoding table claims `0x00 - 0x1F` are escaped; library decoder DROPS literal `0x00 - 0x1F` from the wire stream

- Severity: P3 (under-cited / ambiguous)
- Category: omission
- Spec location: SPEC.md §10 lines 698-711
- Source location: src/protocol/decode.ts:36-79 (decoder).
- Claim in spec:
  > | Input Byte | Encoding |
  > |------------|----------|
  > | `0x00` - `0x1F` | `\` + 3-digit octal (e.g., `\000`, `\012`, `\033`) |
  > | `\` (0x5C) | `\134` |
  > | All other bytes (0x20-0x5B, 0x5D-0xFF) | Sent as-is |
  >
  > To decode: scan for `\` followed by exactly 3 octal digits, and replace with
  > the corresponding byte value.
- Reality in source:
  > src/protocol/decode.ts:44-51:
  > ```
  > if (c < SPACE) {
  >   i++;
  >   continue;
  > }
  > ```
  > and lines 56-58:
  > ```
  > // Skip stray \r the line driver may have inserted between digits.
  > while (i < len && encoded.charCodeAt(i) === CR) i++;
  > ```
  > and lines 60-66 (malformed escape → `?`):
  > ```
  > if (d < 0 || d > 7) {
  >   c = QUESTION;
  >   i--;
  >   break;
  > }
  > ```
  > §10's "To decode" instruction is correct *only* for clean streams. The library's actual decoder performs three additional moves the spec does not document: (1) literal bytes < 0x20 are dropped on the floor (rationale: tmux's encoding rule guarantees they cannot occur from the server, so any literal control byte must be transport noise), (2) stray `\r` between octal digits is skipped, (3) malformed escapes are recovered by emitting `?` (0x3F). All three are byte-faithful to the canonical iTerm2 reference (per the comment at src/protocol/decode.ts:5-14), but a library consumer reading §10 alone cannot predict the byte sequence the decoder will produce on noisy input. The inner audit's F8 flags the same set of behaviors against SPEC_MANIFEST §9 — this is the SPEC.md-side restatement of the rule that needs the parallel "decoder corollaries" note.
- Recommendation: Add a "Decoder behavior (library)" subsection to §10 documenting the three recovery rules: literal-control-byte drop, mid-escape CR skip, and malformed-escape `?` substitution. Cite the canonical iTerm2 reference if relevant.

### F12 — §6 says "Notifications (except `%exit`) also correspond to tmux hooks", but the library treats `%exit` as a regular notification with no special routing

- Severity: P3 (under-cited / ambiguous)
- Category: ambiguity
- Spec location: SPEC.md §6 line 196
- Source location: src/protocol/parser.ts:275 (PARSERS map entry for `exit`); src/protocol/parser.ts:234-239 (parseExit); src/client.ts:101-113 (TmuxClient emits `exit` event from BOTH the parsed `%exit` notification AND the transport `onClose` path).
- Claim in spec:
  > Notifications (except `%exit`) also correspond to tmux hooks.
- Reality in source:
  > §6's "(except `%exit`)" parenthetical implies `%exit` is special. The library DOES route `%exit` through the same parser dispatch table (src/protocol/parser.ts:275) as every other notification, and emits it through `TypedEmitter` the same way. Where it IS special in the library is invisible to §6: the `"exit"` event is emitted from TWO sites — when tmux sends `%exit` over the wire AND when the transport's `onClose` fires (src/client.ts:101-105, the transport-close handler synthesizes `{ type: "exit", reason }`). So a consumer listening for `"exit"` receives the event whether tmux sent the wire message or the transport just died. SPEC.md says nothing about this dual-source emission; a consumer might assume the `"exit"` event always corresponds to a real `%exit` notification (which would let them parse `reason` as one of the values listed in §7.12's Exit Reasons table), but it might equally well be transport noise with a generic reason like `"exit 1"` or a signal name.
- Recommendation: At §6 (or §7.12) document the library-side dual emission: "The library's `"exit"` event fires from two sources: (a) a wire `%exit` notification from tmux, in which case `reason` is one of the values in the Exit Reasons table, or (b) the transport closing for any reason (including unexpected child process death), in which case `reason` is a transport-derived string (signal name, `"exit <code>"`, or `undefined`). Consumers that need to distinguish the two should subscribe to `"connection-state"` as well — the `closed` state's `reason` field disambiguates `exit` / `transport-error` / `disposed`."

## Sections with no findings

- §1 Overview — accurate; "line-oriented (terminated by `\n`)" matches src/protocol/parser.ts:322-336 (LF-driven line splitting). "All protocol lines from the server begin with `%`" matches src/protocol/parser.ts:351, 364-388 (the `0x25` check and the response-block-purity rule).
- §2 Entering Control Mode — examples `tmux -C new-session` and `tmux -C attach-session -t mysession` are reachable via `spawnTmux(["new-session"])` and `spawnTmux(["attach-session", "-t", "mysession"])`; src/transport/spawn.ts:67-80 prepends `-C` and optional `-L`/`-S` socket args, then the user args.
- §2.1 Variants — `-C` vs `-CC` table is accurate as protocol description; the library's refusal of `-CC` is a separate finding at F4 above.
- §2.2 Initialization Sequence — tmux-internal C-source behavior; no library-visible claim to verify.
- §2.3 Teardown — tmux-internal C-source behavior; no library-visible claim to verify.
- §3 Identifier Prefixes — src/protocol/parser.ts:14-26 implements `$`/`@`/`%` → unsigned-integer parsing exactly as the table describes; no findings.
- §4 Command Input (incl. §4.1-§4.4) — `\n`-terminated commands at src/protocol/encoder.ts:24-26 (`buildCommand`); empty-line detach at src/protocol/encoder.ts:188-192 + src/client.ts:295-297; multi-command semicolon syntax is upstream behavior, used as-is by `execute()` consumers.
- §5 Command Response Protocol (incl. §5.1, §5.2, §5.3, §5.4) — `%begin`/`%end`/`%error` guard format matches `parseGuard` at src/protocol/parser.ts:47-59 (`>= 3` head parts, [timestamp, commandNumber, flags]). FIFO correlation at src/client.ts:315-354 produces `CommandResponse` with the spec's field shape. `%error` rejection via `TmuxCommandError` is library-specific but does not contradict §5.
- §6 Notifications (incl. §6.1 Notification Dispatch, §6.2 Notification Client Filtering, §6.3 Hook-to-Notification Mapping) — the "never inside response block" invariant is encoded at src/protocol/parser.ts:364-388 (see inner audit's F6 for the load-bearing implications). Filtering and dispatch are tmux server-side; library does not contradict.
- §7 Notification Reference (§7.1 through §7.12) — every notification type catalogued has a corresponding `TmuxMessage` variant in src/protocol/types.ts and a parser entry in src/protocol/parser.ts:247-276. Cross-referenced one-by-one: `%output`, `%extended-output`, `%pause`, `%continue`, `%pane-mode-changed`, `%window-add`, `%window-close`, `%window-renamed`, `%window-pane-changed`, `%unlinked-window-add`, `%unlinked-window-close`, `%unlinked-window-renamed`, `%layout-change`, `%session-changed`, `%session-renamed`, `%sessions-changed`, `%session-window-changed`, `%client-session-changed`, `%client-detached`, `%paste-buffer-changed`, `%paste-buffer-deleted`, `%subscription-changed`, `%message`, `%config-error`, `%exit`. Wire shapes all match. (F2 and F11 add omission-class library-side notes; F7 flags a citation hygiene issue; otherwise the §7 entries themselves are accurate.)
- §8 Exit Handling — tmux-internal post-`%exit` behavior; library has no machinery to contradict. (F10 flags an under-citation ambiguity about how the library cooperates with `wait-exit`.)
- §9 Client Flags — flag-name pass-through via src/protocol/encoder.ts:124-130 (`refresh-client -f ${flags.join(",")}`); flag names are not enumerated in code, so there is no library-side enumeration to drift from §9's table.
- §10 Data Encoding — encoding rules (`0x00-0x1F` → octal, `\` → `\134`, others as-is) match the inverse decode at src/protocol/decode.ts:36-79 modulo the recovery rules flagged in F11.
- §11 Client Size Control — wire syntax matches the first form at src/protocol/encoder.ts:28-30. F3 flags the missing forms.
- §12 DCS Wrapping — DCS introducer `P1000p` and terminator `\\` at src/transport/spawn.ts:14-15 match the spec; `createDcsStripper` at src/transport/spawn.ts:40-64 enforces the 7-byte introducer. F4 flags the `-CC` refusal omission.
- §13 Pane Control — four-action table matches `PaneAction` enum at src/protocol/types.ts:294-300 ({On, Off, Continue, Pause}); wire format `refresh-client -A <pane-id>:<action>` matches src/protocol/encoder.ts:32-39.
- §14 Subscriptions — `refresh-client -B name:what:format` matches src/protocol/encoder.ts:41-49; the remove form matches src/protocol/encoder.ts:51-53. `what` values (`""`, `%N`, `%*`, `@N`, `@*`) are pass-through strings; the library does not enumerate them, no drift.
- §15 Reports — wire format `refresh-client -r <pane-id>:<report>` matches src/protocol/encoder.ts:158-162. F5 flags the missing version-floor citation.
- §16 Backpressure and Flow Control (§16.1, §16.2) — purely tmux server-side behavior; library exposes the wire-visible result via `%pause`/`%continue`/`%extended-output` only.
- §17 Internal Buffering (§17.1-§17.4) — tmux C-source internals; no library-visible surface.
- §18 Pane Output Integration — tmux server-side pane→client routing; no library-visible surface.
- §19 Clipboard Query — `refresh-client -l` matches src/protocol/encoder.ts:176-178 exactly.
- §20 Data Structures — tmux C structs (`control_block`, `control_pane`, `control_state`, `control_sub`, etc.); not library types.
- §21 Format Variables — `client_control_mode` is a tmux-side format variable; library does not expose it.
- §22 Control Mode Behavioral Differences — entirely tmux server-side.
- §23 Complete Message Reference — wire-message table is accurate (28 rows, every row matches a `TmuxMessage` variant). F9 flags the omission of synthetic events from the "complete" reference.
- §24 Source File Reference — describes the tmux source tree, not this library; no library-side claim to verify.
- §25 Known Man Page vs Code Discrepancies — single row about `%session-renamed`; library follows the code form (sessionId + name) per src/protocol/parser.ts:149-161 + src/protocol/types.ts:145-149. Matches.

## Source-level bugs surfaced (separate from spec findings)

- src/protocol/types.ts:237 — the union-comment "Discriminated Union — all 28 server-to-client message types" is a count-comment. Counting the union members on lines 241-269 yields 28, so the comment is currently accurate, but per the project's `comments-explain-why-only` law (and the recent commit a01fadf "docs: strip '28 message types' count across 5 sites"), in-source count comments are forbidden. This was already flagged in the inner-audit report's "Source-level bugs surfaced" section; restating here for cross-layer continuity.
- src/transport/spawn.ts:111 — the `-CC` refusal error message says "See SPEC.md §12 for details." but SPEC.md §12 does not itself say `-CC` is refused (see F4 above). The source's claim about what SPEC §12 contains is wrong until F4 is remediated; either the message should be updated or §12 should be expanded so the cross-reference is accurate.
