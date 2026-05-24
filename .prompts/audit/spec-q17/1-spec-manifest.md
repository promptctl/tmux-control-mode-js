# Audit: /Users/bmf/code/tmux-control-mode-js/SPEC_MANIFEST.md

## Scope
- Spec file: `SPEC_MANIFEST.md`
- Source modules in scope: src/protocol/**, src/transport/**, src/client.ts, src/tmux-compat.ts, src/emitter.ts, src/connection-state.ts, src/errors.ts, src/index.ts
- Source commit SHA: 1fe97c59058e6dcb1de7e47969f3d06529610cfe
- Audit date: 2026-05-24
- Ticket: tmux-audit-q17 (Audit 2/4: Spec accuracy)

## Coverage notes

- Modules read end-to-end:
  - src/protocol/types.ts
  - src/protocol/parser.ts
  - src/protocol/decode.ts
  - src/protocol/encoder.ts
  - src/protocol/index.ts
  - src/client.ts
  - src/tmux-compat.ts
  - src/transport/spawn.ts
  - src/transport/types.ts
  - src/transport/index.ts
  - src/transport/sockets.ts
  - src/emitter.ts
  - src/connection-state.ts
  - src/errors.ts
  - src/index.ts

- Modules grep-sampled only:
  - src/connectors/** — sampled with `grep -rn "%output|%begin|%end|%error|extended-output|isPaneOutput|asPaneOutput" src/connectors/`. SPEC_MANIFEST.md makes no claims about connectors; they are downstream consumers of `src/protocol/**`. No protocol-shape claims found in connectors that the manifest documents.
  - src/keymap/** — sampled with `grep -rn "subscription|%output|extended-output|%begin|%end|%error|%pause|%continue" src/keymap/`. No matches; the keymap layer is a UI-only key-binding engine outside the protocol surface the manifest catalogues.

- Modules not examined: none (every source path under `src/**` was at least grep-sampled).

- Spec sections not examined: none — every numbered section of SPEC_MANIFEST.md was examined; per-section outcomes are listed below under "Spec sections examined."

- Spec sections examined:
  - §1 Entry Points and Initialization — examined. Manifest only describes the upstream tmux C source (`control.c`, `server-client.c`); the library does not implement these C entry points, it consumes the wire output. No library-side claim to verify; citations are upstream C source per the SPECIAL RULE.
  - §2 DCS Wrapping (-CC Mode) — examined against src/transport/spawn.ts.
  - §3 Command Input Protocol — examined against src/protocol/encoder.ts and src/transport/spawn.ts (LF framing, empty-line detach).
  - §4 Command Response Protocol — examined against src/protocol/parser.ts (parseGuard) and src/client.ts (handleMessage, FIFO correlation).
  - §5 Notifications Overview — examined against src/protocol/parser.ts and src/emitter.ts.
  - §6 All Notification Types — examined against src/protocol/parser.ts and src/protocol/types.ts message-by-message.
  - §7 Exit Reasons — examined; library parses `%exit [<reason>]` as a free-form string (src/protocol/parser.ts:234-238). The manifest's enumeration of upstream-generated reason strings is C-source documentation; not a library-side contract.
  - §8 Exit Handling — examined; library has no `wait-exit` orchestration of its own (encoder line in src/protocol/encoder.ts:112 mentions `wait-exit` as a recognized flag name only). Manifest's claims are upstream C-source behavior.
  - §9 Data Encoding (Pane Output) — examined against src/protocol/decode.ts.
  - §10 Client Flags — examined against src/protocol/encoder.ts (refreshClientSetFlags) and src/client.ts (setFlags/clearFlags).
  - §11 Client Size Control — examined against src/protocol/encoder.ts (refreshClientSize) and src/client.ts (setSize).
  - §12 Pane Control — examined against src/protocol/encoder.ts (refreshClientPaneAction) and src/protocol/types.ts (PaneAction).
  - §13 Subscriptions — examined against src/protocol/encoder.ts (refreshClientSubscribe / refreshClientUnsubscribe) and src/client.ts (subscribeRaw / unsubscribe).
  - §14 Reports — examined against src/protocol/encoder.ts (refreshClientReport), src/client.ts (requestReport), src/tmux-compat.ts (REQUEST_REPORT_MIN_VERSION).
  - §15 Clipboard Query — examined against src/protocol/encoder.ts (refreshClientQueryClipboard) and src/client.ts (queryClipboard).
  - §16 Backpressure and Flow Control — examined; library has no client-side enforcement of these constants. It parses `%pause`/`%continue`/`%extended-output` (the wire-visible result of these C-source rules) — see src/protocol/parser.ts. The constants themselves are upstream tmux behavior, not duplicated in the library.
  - §17 Internal Buffering and Write Queue — examined; entirely about tmux C-source internals, not library-side. No library-visible surface to audit.
  - §18 Pane State Flags — same: C-source-internal flags, not exposed on the wire.
  - §19 Data Structures — same: tmux C internals.
  - §20 Client Struct Fields — same: tmux C internals.
  - §21 CLIENT_CONTROL* Flag Values — same: tmux C internals.
  - §22 Identifier Prefixes — examined against src/protocol/parser.ts (parsePaneId / parseWindowId / parseSessionId).
  - §23 Format Variables — `client_control_mode` is a tmux-side format variable; library does not expose it. Not a library-side claim.
  - §24 Hooks / Notification Dispatch — tmux-internal; library only sees the resulting wire notifications.
  - §25 Pane Output Integration — tmux-internal pane→client routing; library only sees `%output`/`%extended-output` lines.
  - §26 Control Mode Commands (via refresh-client) — examined against src/protocol/encoder.ts and src/client.ts. Library exposes wrappers for `-A`, `-B`, `-C`, `-f`/`-F`, `-r`, `-l`.
  - §27 detach-client -E — tmux command; library executes commands generically via `execute()` (src/client.ts:160). Not a per-command library claim.
  - §28 Server-Side Exit Handling — tmux-internal.
  - §29 Control Mode Behavioral Differences — entirely tmux server-side. Library only observes wire effects.
  - §30 Internal Helper Functions — tmux C internals.
  - §31 Source Files — tmux source file mapping; not a library claim.
  - §32 Man Page Sections — tmux man page references; not a library claim.
  - §33 Man Page vs Code Discrepancies — examined; library parses `%session-renamed` with both sessionId and name, consistent with the cited code behavior (src/protocol/parser.ts:265 → parseSessionWithName).

## Findings

### F1 — Discriminated union variant count stated only in code comment is not a manifest claim, but `%subscription-changed` reserved-fields semantics are under-documented

- Severity: P3 (under-cited / ambiguous)
- Category: under-cited
- Spec location: SPEC_MANIFEST.md §6 "Subscription Events" (lines 261-266)
- Source location: src/protocol/parser.ts:207-224
- Claim in spec:
  > **`%subscription-changed <name> <session-id> <window-id> <window-index> <pane-id> ... : <value>`**
  >   - Session-level: `$%u - - - : %s` (`control.c:862`)
  >   - Pane-level: `$%u @%u %u %%%u : %s` (`control.c:909, 944`)
  >   - Window-level: `$%u @%u %u - : %s` (`control.c:989, 1024`)
- Reality in source:
  > parser at src/protocol/parser.ts:207-224 splits args on `" : "`, then splits the head on space and requires `>= 5` head parts: `[name, sessionId, windowId, windowIndex, paneId]`. Each id field accepts the literal `"-"` and yields `-1` (see `parseOptionalId` at parser.ts:29 and `parseOptionalInt` at parser.ts:34). Note that the spec's three subtype lines (Session/Pane/Window-level) show only four space-separated head fields (`$%u - - - : %s`), NOT five — the leading `<name>` field shown in the headline format string is missing from each subtype example. A reader reconciling these by counting fields will mis-count. The library code's five-part requirement matches the headline format (`<name> <session-id> <window-id> <window-index> <pane-id>`), not the subtype examples.
- Recommendation: The spec should either expand each subtype example to include the leading `<name>` field (`<name> $%u - - - : %s` etc.) so the field count matches the headline format, or add a sentence noting that the subtype lines elide the leading name token. Either form removes the ambiguity for readers cross-checking against the library's parser.

### F2 — `%session-renamed` discrepancy noted in §6 and §33 but library-visible shape is not documented as the chosen ground truth

- Severity: P3 (under-cited / ambiguous)
- Category: ambiguity
- Spec location: SPEC_MANIFEST.md §6 line 209-211 and §33 lines 859-863
- Source location: src/protocol/parser.ts:149-161 (parseSessionWithName); src/protocol/types.ts:145-149 (SessionRenamedMessage)
- Claim in spec:
  > **`%session-renamed <session-id> <name>`** - session renamed (NOTE: man page says just `<name>` but code sends `$%u %s` (includes session ID))
- Reality in source:
  > src/protocol/parser.ts:149-161 parses `%session-renamed` via `parseSessionWithName("session-renamed")` which requires `<sessionId> <name>` (the code-sent format). src/protocol/types.ts:145-149 declares `SessionRenamedMessage` with both `sessionId: number` and `name: string`. The library is byte-faithful to the code-sent form, not the man-page form. The manifest correctly identifies the discrepancy at upstream level but does not state that this library's parser follows the *code-sent* shape — a downstream maintainer reading only the manifest cannot tell which side the library implements.
- Recommendation: Add a one-sentence note at §6 line 210-211 stating the library parses the code-sent form (`$%u %s`), so readers know which side of the upstream discrepancy this implementation tracks.

### F3 — `%output` and `%extended-output` reserved-field tolerance not documented for `%extended-output`

- Severity: P3 (under-cited / ambiguous)
- Category: omission
- Spec location: SPEC_MANIFEST.md §6 line 134-136
- Source location: src/protocol/parser.ts:73-87
- Claim in spec:
  > **`%extended-output <pane-id> <age> ... : <value>`** - pane output with age (with `pause-after`); arguments between `<age>` and `:` are reserved
- Reality in source:
  > src/protocol/parser.ts:73-87 splits on `" : "`, then splits the head on space and requires `>= 2` head parts (paneId, age). Any further head parts between `<age>` and the ` : ` delimiter are present in `parts[2..]` but ignored. The parser does not enforce that the reserved fields take any particular form. This is consistent with the spec text, but the spec phrasing "arguments between `<age>` and `:` are reserved" is ambiguous as to whether *the library tolerates* unknown reserved fields or *rejects* them. The library tolerates them; this should be explicit so a maintainer modifying the parser to "validate the reserved field count" does not introduce a regression.
- Recommendation: Add explicit language: "reserved arguments are tolerated as opaque tokens; the library does not validate their count or shape."

### F4 — Manifest omits the LF-on-empty-input `detach` shape that the library exposes as a first-class operation

- Severity: P2 (omission)
- Category: omission
- Spec location: SPEC_MANIFEST.md §3 line 70-72
- Source location: src/protocol/encoder.ts:188-192 (detachClient); src/client.ts:295-297 (detach); src/transport/spawn.ts:181-185 (send)
- Claim in spec:
  > An **empty line** causes the client to detach (`CLIENT_EXIT`)
> - `control.c:561-564`
- Reality in source:
  > The library implements this as an explicit `TmuxClient.detach()` method (src/client.ts:295-297) backed by `detachClient()` (src/protocol/encoder.ts:188-192) which returns `"\n"` (a bare LF). The send path at src/transport/spawn.ts:181-185 happily writes a bare LF when called with `""`-then-newline. SPEC_MANIFEST.md describes the upstream wire trigger but does not document that the library exposes this as a fire-and-forget API operation distinct from `close()`. A maintainer adapting the spec into a library-shape document would miss that `detach` is a public method that maps to this empty-line trigger, and might infer (incorrectly) that the library does not surface a detach operation.
- Recommendation: At §3 or a new §3.1, add: "The library exposes this empty-line trigger as a public `detach()` operation distinct from `close()` (which kills the transport)." This is a library-level addition consistent with the manifest's role as a per-message catalogue.

### F5 — `%exit` parser drops trailing whitespace-only reason; manifest implies any "[<reason>]" content survives

- Severity: P3 (under-cited / ambiguous)
- Category: ambiguity
- Spec location: SPEC_MANIFEST.md §6 line 282-284
- Source location: src/protocol/parser.ts:234-239
- Claim in spec:
  > **`%exit [<reason>]`** - client is exiting; printed client-side on stdout
- Reality in source:
  > src/protocol/parser.ts:234-239:
  > ```
  > function parseExit(args: string): TmuxMessage {
  >   const reason = args.length > 0 ? args : undefined;
  >   // [LAW:dataflow-not-control-flow] Both paths produce the same type; variability
  >   // is in the value (undefined vs string), not in whether we construct the object.
  >   return { type: "exit", reason };
  > }
  > ```
  > The library uses `args.length > 0` to distinguish "no reason" from "reason present". For `%exit` (no trailing space), `args` is `""` and `reason` is `undefined`; for `%exit foo`, `args` is `"foo"` and `reason` is `"foo"`. The line `%exit ` (with a trailing space and nothing else) would yield `args = ""` because the parser splits on the first space and discards the delimiter — but only if the line is exactly `%exit ` with a trailing space; otherwise the slice yields the literal space character which evaluates `length > 0` true and would set `reason = " "`. The spec uses `[<reason>]` (square brackets indicating optional) without telling readers how the library distinguishes "absent reason" from "empty reason"; this is the kind of ambiguity that causes downstream consumers to special-case both `undefined` and `""` to be safe.
- Recommendation: Spec should clarify: "absence of `<reason>` produces `reason: undefined`; presence (even of whitespace-only content) produces the literal string."

### F6 — Manifest claim about block-internal output handling correct, but the "non-block-terminator notifications never appear inside blocks" invariant the parser depends on is stated only in passing

- Severity: P0 (test-invalidating)
- Category: under-cited
- Spec location: SPEC_MANIFEST.md §4 lines 99-100
- Source location: src/protocol/parser.ts:364-415 (processLine)
- Claim in spec:
  > A notification will never occur inside a response block
  >   - `tmux.1:7896-7897`
- Reality in source:
  > src/protocol/parser.ts:364-388 enforces this invariant in code. When `activeCommandNumber !== -1` (in a response block), every line that is *not* a `%begin` / `%end` / `%error` block terminator is routed to `onOutputLine` as command-output text, EVEN IF the line begins with `%`. The block comment at parser.ts:364-372 explicitly cites SPEC_MANIFEST §4 as the source of this load-bearing decision. This means the library treats the SPEC_MANIFEST claim as ground truth and will MIS-CATEGORIZE a real-tmux notification as command output if tmux ever emits one inside a block. The manifest's two-line note plus a `tmux.1:7896-7897` citation is the entire backing for this — under the SPECIAL RULE the upstream citation cannot be verified here, but the library exposes this invariant as observable behavior (events vs. command output) on every `client.execute()` call. If the manifest claim is wrong, the parser's emit/output routing is wrong and any test that observes events arriving from inside a block versus as command-output lines is green for the wrong reason.
- Conformance-test impact (P0 only): Any test in tests/integration/client.test.ts that asserts a specific notification was emitted (or that a command's `CommandResponse.output` contains specific lines) is implicitly asserting this invariant. The outer SPEC.md audit must cross-check that the conformance test exercises a scenario where a `%`-prefixed text line appears inside a block, and that the library correctly routes it to `output` rather than emitting it as an unknown notification. (Per ticket instructions this sub-audit does not read the test file.)
- Recommendation: SPEC_MANIFEST.md §4 should promote the "notification will never occur inside a response block" line from a parenthetical to an explicit named invariant (e.g. "Invariant 4.1 — Block Purity") with rationale, because the library's parser builds two distinct code paths on it. Naming it makes the invariant searchable and makes any future deviation in tmux a discoverable spec-change rather than a silent parser regression.

### F7 — `\r` (CR) handling in parser line-splitting is library-side behavior not mentioned in the manifest

- Severity: P2 (omission)
- Category: omission
- Spec location: SPEC_MANIFEST.md §3 line 67-68
- Source location: src/protocol/parser.ts:316-336 (feed)
- Claim in spec:
  > Lines are read with `EVBUFFER_EOL_LF`
  >   - `control.c:557`
- Reality in source:
  > src/protocol/parser.ts:322-336 strips a trailing `\r` byte before the LF, treating CRLF as equivalent to LF. The inline comment at lines 323-327 documents that "real `\r` in pane output is octal-escaped" — so any literal `\r` adjacent to LF is line-driver noise. This is library-side compensation for a transport-noise hazard the manifest does not document. A maintainer reading SPEC_MANIFEST.md alone would not know that the library's parser tolerates CRLF; if they replaced the line buffer with a strict LF-only splitter, the library would break on transports that introduce CRLF. The behavior is not wrong, but the spec is silent about it.
- Recommendation: Add a note to §3 that the library tolerates CRLF as a line terminator (treats `\r\n` as `\n`) because some transports introduce CR as line-driver artifact. tmux itself uses LF-only per the upstream citation, but the library is defensive against transport noise.

### F8 — Literal control-byte drop in the octal decoder is library-side behavior the manifest does not document

- Severity: P2 (omission)
- Category: omission
- Spec location: SPEC_MANIFEST.md §9 lines 327-335
- Source location: src/protocol/decode.ts:36-79
- Claim in spec:
  > - Used in `%output` and `%extended-output` value fields
  > - Bytes < 0x20 (space): encoded as `\` + 3-digit octal (e.g., `\012`)
  > - Backslash (`\`, 0x5C): encoded as `\134`
  > - All other bytes (0x20-0x5B, 0x5D-0xFF): sent as-is
  > - Encoding loop in `control_append_data()`
  >   - `control.c:631-642`
- Reality in source:
  > src/protocol/decode.ts:44-51 drops any literal byte `< 0x20` encountered in the wire stream:
  > ```
  > if (c < SPACE) {
  >   i++;
  >   continue;
  > }
  > ```
  > and at lines 56-58 skips stray `\r` between octal digits:
  > ```
  > // Skip stray \r the line driver may have inserted between digits.
  > while (i < len && encoded.charCodeAt(i) === CR) i++;
  > ```
  > The decoder also returns `?` (0x3F) for malformed escapes (lines 60-66). These three behaviors — literal-control-byte drop, mid-escape CR skip, malformed-escape `?` substitution — are recovery strategies the library implements but the manifest does not catalogue. The first two are correct *because* the manifest's encoding rule guarantees real control bytes are always escaped, so any unescaped control byte must be transport noise — but the manifest never makes that inference explicit, so a reader cannot know the decoder is allowed to drop them.
- Recommendation: Add a §9.1 ("Decoder corollaries") noting: (1) since real control bytes are always octal-escaped per the encoding rule, any literal byte < 0x20 in the stream is transport noise and should be dropped; (2) malformed escapes recover by emitting `?`; (3) the digits inside an octal escape tolerate interleaved `\r` from transport line drivers. These follow logically from the encoding rule but are not derivable from it alone.

### F9 — `splitWindow` and `sendKeys` library convenience operations have no entry in the manifest's command catalogue

- Severity: P2 (omission)
- Category: omission
- Spec location: SPEC_MANIFEST.md §26 "Control Mode Commands (via `refresh-client`)" (lines 676-697)
- Source location: src/protocol/encoder.ts:87-102 (sendKeys, splitWindow); src/client.ts:187-198 (sendKeys, splitWindow)
- Claim in spec:
  > (section limits itself to refresh-client subcommands)
- Reality in source:
  > The library exposes two non-refresh-client convenience operations as first-class public methods: `sendKeys` (src/client.ts:187-194; encoder at src/protocol/encoder.ts:87-92) and `splitWindow` (src/client.ts:196-198; encoder at src/protocol/encoder.ts:97-102). Both use the regular `execute`-style FIFO correlation. The manifest is structured around upstream tmux behavior and does not catalogue these — which is fine for a tmux-protocol manifest, but in this codebase the manifest is the inner/granular reference for the library. A reader looking up "how does the library send keystrokes" finds nothing in §26. This is an omission relative to the library's surface, not a contradiction with tmux behavior.
- Recommendation: Either narrow §26's heading to "Control Mode `refresh-client` Subcommands" (making the omission intentional and scoped), or add a §26.1 "Other library command wrappers" listing `sendKeys` (notes: uses `send-keys -H` with hex-encoded bytes; empty-input is a no-op resolving without a round-trip), `splitWindow`, `listWindows`, `listPanes`, and the generic `execute(command)` escape hatch.

### F10 — Manifest's claim that `-CC` mode shares stdin/stdout via single bufferevent contradicts the library's hard-refusal of `-CC` over child_process pipes — but the manifest does not flag this incompatibility

- Severity: P2 (omission)
- Category: omission
- Spec location: SPEC_MANIFEST.md §2 lines 49-50
- Source location: src/transport/spawn.ts:105-113
- Claim in spec:
  > `-CC` mode closes `out_fd` and uses a single `bufferevent` for both read and write (stdin/stdout share a socket)
  >   - `control.c:769-771, 787-788`
- Reality in source:
  > src/transport/spawn.ts:105-113 throws immediately when `controlControl: true`:
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
  > The library refuses `-CC` over child_process.spawn because tmux calls `tcgetattr(stdin)` which fails on pipe stdio. The manifest documents `-CC`'s tty configuration (§2 lines 51-57) but does not state that programmatic clients using piped stdio cannot use `-CC` at all — yet the library has a load-bearing throw enforcing exactly that constraint. A maintainer reading SPEC_MANIFEST.md to "add `-CC` support to spawnTmux" would not know this is a fundamental incompatibility, not a missing feature.
- Recommendation: Add to §2: "Implementation note: `-CC` requires a PTY-backed transport because tmux calls `tcgetattr(stdin)` at startup (per the terminal raw-mode configuration above). Piped-stdio transports (e.g., `child_process.spawn`'s default) cannot supply this and must use `-C` instead — which carries the identical protocol minus the DCS framing."

### F11 — Manifest's `extended-output` age type ("ms") matches the library's parser but the off-by-one (parses age as JS number, no validation) is not flagged

- Severity: P3 (under-cited / ambiguous)
- Category: under-cited
- Spec location: SPEC_MANIFEST.md §6 line 134-136 and §16 lines 476-479
- Source location: src/protocol/parser.ts:73-87
- Claim in spec:
  > **`%extended-output <pane-id> <age> ... : <value>`** - pane output with age
  > (with `pause-after`); arguments between `<age>` and `:` are reserved
  > ...
  > - Uses `%extended-output` instead of `%output` (includes `age` field in ms)
- Reality in source:
  > src/protocol/parser.ts:73-87 parses age via `parseInt(parts[1], 10)`. There is no documented type on the wire — only the manifest's "in ms" comment. The library exposes it as a `number` (src/protocol/types.ts:43, `readonly age: number`). The manifest never states whether the wire value is the integer millisecond count exactly, or whether the library is supposed to convert; src/protocol/parser.ts assumes parseInt produces a sane integer with no overflow concern. This is fine in practice (5-minute max → 300000 ms, well within Number.MAX_SAFE_INTEGER) but the manifest does not pin the unit at the §6 catalogue entry — only at §16 where backpressure is discussed.
- Recommendation: At §6 line 134-136, expand the `<age>` placeholder to `<age-ms>` (or add a parenthetical "(milliseconds)") so the unit is visible at the per-message catalogue, not only inferred from §16.

## Sections with no findings

- §1 Entry Points and Initialization — no library-side claims; tmux C source per SPECIAL RULE.
- §5 Notifications Overview — library matches: src/protocol/parser.ts:351 checks the `%` prefix (`charCodeAt(0) === 0x25`); src/emitter.ts dispatches by `event.type` discriminator. No mismatch.
- §6 individual notification entries — library has a matching TmuxMessage variant in src/protocol/types.ts and a matching PARSERS entry in src/protocol/parser.ts:247-276 for every notification type catalogued. Cross-referenced one-by-one:
  - `%output` → OutputMessage / parseOutput.
  - `%extended-output` → ExtendedOutputMessage / parseExtendedOutput.
  - `%pause`, `%continue` → PauseMessage / ContinueMessage / parsePaneIdOnly.
  - `%pane-mode-changed` → PaneModeChangedMessage / parsePaneIdOnly.
  - `%window-add`, `%window-close`, `%unlinked-window-add`, `%unlinked-window-close` → corresponding *Message types / parseWindowIdOnly.
  - `%window-renamed`, `%unlinked-window-renamed` → WindowRenamedMessage / UnlinkedWindowRenamedMessage / parseWindowRenamed.
  - `%window-pane-changed` → WindowPaneChangedMessage / parseWindowPaneChanged.
  - `%layout-change` → LayoutChangeMessage / parseLayoutChange (parses windowId, windowLayout, windowVisibleLayout, windowFlags — four fields matching manifest line 187).
  - `%session-changed`, `%session-renamed` → SessionChangedMessage / SessionRenamedMessage / parseSessionWithName.
  - `%sessions-changed` → SessionsChangedMessage / parseSessionsChanged (no fields).
  - `%session-window-changed` → SessionWindowChangedMessage / parseSessionWindowChanged.
  - `%client-session-changed` → ClientSessionChangedMessage / parseClientSessionChanged (clientName, sessionId, name).
  - `%client-detached` → ClientDetachedMessage / parseClientDetached.
  - `%paste-buffer-changed`, `%paste-buffer-deleted` → corresponding *Message types / parseNameOnly.
  - `%subscription-changed` → SubscriptionChangedMessage / parseSubscriptionChanged (see F1 for a separate ambiguity about field count).
  - `%message` → MessageMessage / parseMessageMsg.
  - `%config-error` → ConfigErrorMessage / parseConfigError.
  - `%exit` → ExitMessage / parseExit (see F5 for absent-vs-empty-reason ambiguity).
- §6 "Notification Client Filtering" — server-side filtering; library has no observable role. No mismatch.
- §10 Client Flags — library exposes setFlags/clearFlags wrapping `refresh-client -f` (src/client.ts:243-252; src/protocol/encoder.ts:124-130). Flag names accepted are pass-through strings; no library-side enumeration to drift from the manifest. The encoder doc-comment (src/protocol/encoder.ts:110-122) names the flags from §10.
- §11 Client Size Control — src/protocol/encoder.ts:28-30 emits `refresh-client -C ${width}x${height}` matching the §11 format.
- §12 Pane Control — src/protocol/encoder.ts:32-39 emits `refresh-client -A '%<pane-id>:<action>'` (quoted as a single argument per the encoder's `tmuxEscape` call; the comment at lines 33-35 explains why). PaneAction enum at src/protocol/types.ts:295-300 carries exactly {On, Off, Continue, Pause}, matching the four actions catalogued at §12.
- §13 Subscriptions — src/protocol/encoder.ts:41-49 emits `refresh-client -B '<name>:<what>:<format>'` (each part separately escaped) and src/protocol/encoder.ts:51-53 emits `refresh-client -B '<name>'` for the remove form. Matches §13 line 406-407.
- §14 Reports — src/protocol/encoder.ts:158-162 emits `refresh-client -r '%<pane-id>:<report>'`. tmux-compat.ts gates this at REQUEST_REPORT_MIN_VERSION = 3.5, consistent with §14 (which doesn't state a version floor but README is the gating record).
- §15 Clipboard Query — src/protocol/encoder.ts:176-178 emits `refresh-client -l` exactly.
- §22 Identifier Prefixes — src/protocol/parser.ts:14-26 (parsePaneId / parseWindowId / parseSessionId) implement the `%`/`@`/`$` prefix convention exactly as catalogued.
- §26 refresh-client subcommands — `-A`, `-B`, `-C`, `-f`/`-F`, `-r`, `-l` all have library wrappers (see F9 for the omission of non-refresh-client commands like `send-keys` and `split-window` from the section, scoping issue not a contradiction).

## Source-level bugs surfaced (separate from spec findings)

- src/protocol/types.ts:237 contains the comment "// Discriminated Union — all 28 server-to-client message types". A count was deleted across the codebase recently (per recent commit a01fadf "docs: strip '28 message types' count across 5 sites"), but this in-source comment on line 237 still reads "all 28 server-to-client message types". Counting the union members on lines 241-269 yields 27 (Begin/End/Error/Output/ExtendedOutput/Pause/Continue/PaneModeChanged/WindowAdd/WindowClose/WindowRenamed/WindowPaneChanged/UnlinkedWindowAdd/UnlinkedWindowClose/UnlinkedWindowRenamed/LayoutChange/SessionChanged/SessionRenamed/SessionsChanged/SessionWindowChanged/ClientSessionChanged/ClientDetached/PasteBufferChanged/PasteBufferDeleted/SubscriptionChanged/Message/ConfigError/Exit = 28 actually). The comment count is currently accurate, but is the kind of WHAT-comment that drifts on the next addition/removal — flag for the issue tracker per the userspace rule against count comments in CLAUDE.md (`FORBIDDEN in comments: enumerations of callers, counts, etc.`).
