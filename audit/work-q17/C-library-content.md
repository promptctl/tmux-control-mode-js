# Audit shard: C — library-content-in-spec (SPEC.md + SPEC_MANIFEST.md)

## Scope
- Spec section(s) / source under audit: SPEC.md (1274 lines, all 25 sections) and SPEC_MANIFEST.md (971 lines, all 33 sections) — every passage that describes LIBRARY behavior (its method names, types, source files, synthetic events, defensive decoding, packaging) rather than tmux WIRE PROTOCOL behavior.
- tmux source of truth: /Users/bmf/code/tmux_tmux (next-3.7 == tmux 3.7) + man page /opt/homebrew/share/man/man1/tmux.1
- Audit axis: C (library-content-in-spec)

## Coverage notes
- Read end-to-end: SPEC.md lines 1–1274 (full file), SPEC_MANIFEST.md lines 1–971 (full file).
- Grep-sampled (then read around every hit, in addition to the full read): both files grepped for `library`, `TmuxClient`, `TmuxParser`, `requestReport`, `queryTmuxVersion`, `setSize`, `src/`, `.ts`, `OutputMessage`, `ExtendedOutputMessage`, `UnsupportedTmuxVersion`, `JSDoc`, `TypeScript`, `npm`, `this.`, `decodeOctalEscapes`, `reconnect`, `emitter`, `TypedEmitter`, `attachBytesSink`, `ConnectionState`, `node-pty`, `child_process`, `detach()`, `close()`, `execute(`, `listWindows`, `listPanes`, `sendKeys`, `splitWindow`, `setPaneAction`, `subscribeRaw`, `setFlags`, `onOutputLine`, `processLine`, `[LAW:` — with tmux C symbols (`control_*`, `cmdq_*`, `cmd_*`, `server_*`, `notify_*`, `window_pane_offset`, etc.) filtered out so only TS-side hits remained.
- Destination check: IMPL.md **does not currently exist** in the repo (`ls` returns "No such file or directory"). The CLAUDE.md framing and several in-spec notes assume IMPL.md as the relocation target; that file must be created (or another existing home — README.md / source JSDoc — chosen) for any relocation to land. This is noted in each finding's recommendation.
- Not examined for "is this library content": tmux C source itself and the man page (out of axis — those are the source of truth the protocol prose is checked *against*, not candidates for relocation).

## Findings

### F1 — SPEC.md §10.1 "Decoder behavior (library)" is a whole library subsection
- Severity: P2 (tagged `(library)` block pending relocation)
- Category: library-content-in-spec
- Axis: C
- Spec location: SPEC.md:740–761 (§10.1, heading + body)
- Source location: src/protocol/decode.ts (`decodeOctalEscapes`)
- Claim under audit:
  > ### 10.1 Decoder behavior (library)
  >
  > The "scan for `\` + 3 octal digits" instruction above is the rule for *clean* streams. The library's decoder (`src/protocol/decode.ts`, `decodeOctalEscapes`) applies three additional recovery rules so it stays byte-faithful to the canonical iTerm2 reference (`TmuxGateway -decodeEscapedOutput`) on noisy transports. These rules resolve audit finding SPEC.md F11: ... 1. **Literal control-byte drop.** ... 2. **Mid-escape `\r` skip.** ... 3. **Malformed-escape recovery.** ...
- Reality in source of truth: tmux's wire encoding rule is fully and correctly stated in §10 (`control.c:631-642`, `control_append_data`). The three "recovery rules" describe what `src/protocol/decode.ts` does on noisy transports — library behavior derived from, but not part of, the protocol. The text says so itself: "These corollaries follow from the encoding rule ... plus the assumption that transports may introduce noise. They are not derivable from the encoding rule alone."
- Fix direction: relocate-to-IMPL/JSDoc
- Recommendation: Move the whole subsection to IMPL.md (decoder-tolerance section) or to JSDoc on `decodeOctalEscapes` in src/protocol/decode.ts; leave §10 (the tmux encoding rule) intact. SPEC_MANIFEST §9.1 is the mirror copy — see F12; the two should relocate together. Do not change.
- Test impact: n/a (P2)

### F2 — SPEC.md §11.1 "Library mapping (library)" is a whole library subsection
- Severity: P2 (tagged `(library)` block pending relocation)
- Category: library-content-in-spec
- Axis: C
- Spec location: SPEC.md:781–787 (§11.1, heading + body)
- Source location: src/protocol/encoder.ts (`refreshClientSize`); TmuxClient.setSize
- Claim under audit:
  > ### 11.1 Library mapping (library)
  >
  > Form 1 (`-C <width>x<height>`) is wrapped as `TmuxClient.setSize(cols, rows)` — it calls `refreshClientSize(width, height)` in `src/protocol/encoder.ts`. Forms 2 and 3 (per-window size and per-window size clear) have no typed wrapper and require `client.execute("refresh-client -C @<id>:<w>x<h>")` or `client.execute("refresh-client -C @<id>:")` directly.
- Reality in source of truth: §11 already documents the tmux `refresh-client -C` protocol forms with citation (`cmd-refresh-client.c:82-131`, `tmux.1:1427-1438`). This subsection only maps those wire forms onto library method names (`setSize`, `execute`) and a library source file — pure API-surface documentation.
- Fix direction: relocate-to-IMPL/JSDoc
- Recommendation: Move to IMPL.md (size-control mapping) or JSDoc on `TmuxClient.setSize`. Leave §11 intact. Do not change.
- Test impact: n/a (P2)

### F3 — SPEC.md §12.1 "spawnTmux refusal (library)" is a whole library subsection
- Severity: P2 (tagged `(library)` block pending relocation)
- Category: library-content-in-spec
- Axis: C
- Spec location: SPEC.md:811–829 (§12.1, heading + both paragraphs)
- Source location: src/transport/spawn.ts (`spawnTmux`)
- Claim under audit:
  > ### 12.1 spawnTmux refusal (library)
  >
  > §12's raw-mode terminal configuration is the upstream contract for `-CC` mode. ... The library's default transport `spawnTmux` (`src/transport/spawn.ts`) uses `child_process.spawn`, which supplies pipe stdio; `tcgetattr` would fail and tmux would exit before the control-mode protocol begins. `spawnTmux` therefore emits `-C` only and exposes no option to request `-CC` ... This resolves audit finding SPEC.md F4. ... For terminal-emulator use cases that genuinely require `-CC` framing, supply a PTY-backed `TmuxTransport` (e.g., built on `node-pty`) ...
- Reality in source of truth: The upstream fact (tmux `-CC` calls `tcgetattr(stdin)` and needs a tty; `tmux.c:343-362`) is protocol and is already covered by §12 / §2.2. Everything specific to `spawnTmux`, `child_process.spawn`, `node-pty`, and `TmuxTransport` is library transport behavior — a design decision of this package, not a tmux wire fact.
- Fix direction: relocate-to-IMPL/JSDoc
- Recommendation: Move to IMPL.md (transport/`-CC` rationale) or JSDoc on `spawnTmux`. The bare upstream `tcgetattr`-needs-a-tty fact, if not already in §12, can stay in §12 as a one-line protocol note with its `tmux.c:343-362` citation. SPEC_MANIFEST §2.1 is the mirror copy — see F11; relocate together. Do not change.
- Test impact: n/a (P2)

### F4 — SPEC.md §15.1 "Library note (library)" is a whole library subsection (version-gating policy)
- Severity: P2 (tagged `(library)` block pending relocation)
- Category: library-content-in-spec
- Axis: C
- Spec location: SPEC.md:909–922 (§15.1, heading + both paragraphs)
- Source location: src/tmux-compat.ts (`REQUEST_REPORT_MIN_VERSION`); `requestReport`, `queryTmuxVersion`, `UnsupportedTmuxVersionError`
- Claim under audit:
  > ### 15.1 Library note (library)
  >
  > `requestReport()` requires tmux 3.5+. ... The minimum version is encoded in `src/tmux-compat.ts` as `REQUEST_REPORT_MIN_VERSION = { major: 3, minor: 5 }`. The library supports tmux 3.2+, so `requestReport()` enforces this per-command floor itself rather than leaking tmux's raw "unknown flag" `%error`: it probes the running version in-protocol (`display-message -p "#{version}"` ...) via `queryTmuxVersion()`, and on tmux 3.2–3.4 rejects with a typed `UnsupportedTmuxVersionError` ... The README compatibility table reflects this constraint.
- Reality in source of truth: The protocol-relevant fact is that the `refresh-client -r` flag was added after tmux 3.4 (a tmux version fact). Everything about `requestReport()`, `REQUEST_REPORT_MIN_VERSION`, `queryTmuxVersion()`, `UnsupportedTmuxVersionError`, the in-protocol probe, and the README table is this library's version-gating policy and API surface — IMPL/JSDoc material.
- Fix direction: relocate-to-IMPL/JSDoc
- Recommendation: Move to IMPL.md (version-compat policy) or JSDoc on `requestReport`. A single protocol sentence — "`refresh-client -r` is unrecognized before tmux 3.5" — may remain in §15 if anchored to a tmux source/version citation; the man page at `tmux.1:1490-1494` and §15's existing cites cover the feature itself. Do not change.
- Test impact: n/a (P2)

### F5 — SPEC.md §23.1 "Synthetic Events (library)" is a whole library subsection
- Severity: P2 (tagged `(library)` block pending relocation)
- Category: library-content-in-spec
- Axis: C
- Spec location: SPEC.md:1219–1233 (§23.1, heading + table + trailing paragraph)
- Source location: src/connection-state.ts; TmuxClient / `TmuxEventMap` / `attachBytesSink`
- Claim under audit:
  > ### 23.1 Synthetic Events (library)
  >
  > The following events are emitted by `TmuxClient` itself and are NOT parsed from tmux wire output. ... See `src/connection-state.ts` for type declarations. | `connection-state` | `ConnectionStateMessage` ... | `reconnected` | `ReconnectedMessage` ... These events are present in `TmuxEventMap` ... `output` and `extended-output` are intentionally absent from `TmuxEventMap`; pane bytes route exclusively through `attachBytesSink`.
- Reality in source of truth: This subsection states outright "NOT parsed from tmux wire output." `connection-state`, `reconnected`, `ConnectionStateMessage`, `ReconnectedMessage`, `TmuxEventMap`, `attachBytesSink` are entirely library constructs — there is no tmux wire fact here at all. This is the most purely-library subsection of the lot, sitting inside §23 "Complete Message Reference" which otherwise enumerates real wire messages.
- Fix direction: relocate-to-IMPL/JSDoc
- Recommendation: Move wholesale to IMPL.md (synthetic events / connection lifecycle) or JSDoc on the relevant `src/connection-state.ts` types and `TmuxEventMap`. Nothing in it belongs in a wire-protocol §23. Do not change.
- Test impact: n/a (P2)

### F6 — SPEC.md §4.3.1 "Library parser note: CRLF tolerance" is a whole library subsection
- Severity: P2 (tagged-by-title `(library)` block pending relocation)
- Category: library-content-in-spec
- Axis: C
- Spec location: SPEC.md:127–140 (§4.3.1, heading + body)
- Source location: src/protocol/parser.ts (`TmuxParser.feed()`)
- Claim under audit:
  > #### 4.3.1 Library parser note: CRLF tolerance
  >
  > §4.3 above documents tmux's *input* side ... The library's parser sits on tmux's *output* side and goes the opposite direction: `TmuxParser.feed()` (`src/protocol/parser.ts`) strips a trailing `\r` before each `\n`, so transports that introduce CRLF between tmux and the parser are tolerated and parse identically to LF-only ones. ... The behavior is library-side defensive code, not a tmux rule. SPEC_MANIFEST §3.1 carries the mirror statement on the inner-spec side. Resolves audit finding SPEC.md F6.
- Reality in source of truth: The tmux input-side fact (lines read `EVBUFFER_EOL_LF`, no CR stripping; `control.c:557`) is already in §4.3 and is correct. §4.3.1 describes `TmuxParser.feed()`'s CR-stripping on the *output* side — explicitly self-labeled "library-side defensive code, not a tmux rule." Title is not the canonical `(library)` suffix but the heading word "Library" plus the body make the classification unambiguous.
- Fix direction: relocate-to-IMPL/JSDoc
- Recommendation: Move to IMPL.md (parser CRLF tolerance) or JSDoc on `TmuxParser.feed()`. SPEC_MANIFEST §3.1 is the mirror — see F10; relocate together. Do not change.
- Test impact: n/a (P2)

### F7 — SPEC.md §7.1 inline "Library note (resolves audit finding SPEC.md F2)" embedded in protocol prose
- Severity: P1 (untagged-in-TOC library claim embedded directly under a wire-message definition, where a reader scanning the `%output` / `%extended-output` definitions meets library type names presented inline with protocol facts)
- Category: library-content-in-spec
- Axis: C
- Spec location: SPEC.md:316 (single paragraph, immediately after the `%extended-output` field table and its `**Source:**` line, before the §7.2 divider)
- Source location: src/protocol (OutputMessage / ExtendedOutputMessage `data` fields); src/protocol/decode.ts
- Claim under audit:
  > **Library note (resolves audit finding SPEC.md F2):** The parsed `OutputMessage.data` and `ExtendedOutputMessage.data` fields are `Uint8Array` carrying the *decoded* bytes — not the raw octal-escaped wire string. The decoder also tolerates transport noise (literal control bytes, mid-escape `\r`, malformed escapes); see [§10.1 Decoder behavior (library)](#101-decoder-behavior-library).
- Reality in source of truth: `OutputMessage` and `ExtendedOutputMessage` are this library's parsed types; their `.data: Uint8Array` representation is a library decoding decision. The tmux wire fact (the value is octal-escaped output) is already in §7.1's body and §10. This is a parenthetical bolted onto an otherwise-clean protocol section, and unlike the `### X.1 (library)` subsections it is not visually separated, so it reads as part of the `%extended-output` protocol definition — the more misleading kind.
- Fix direction: relocate-to-IMPL/JSDoc
- Recommendation: Move to IMPL.md (parsed message types) or JSDoc on `OutputMessage`/`ExtendedOutputMessage`. Delete from §7.1 once relocated; its forward link to §10.1 also disappears when F1 relocates §10.1. Do not change.
- Test impact: n/a

### F8 — SPEC_MANIFEST.md Invariant 4.1 "Library reliance" + "Why named" bullets embedded in a protocol invariant
- Severity: P1 (untagged library claim — `[LAW:...]`-tagged parser internals presented as part of a protocol invariant statement, the dangerous embedded-clause kind the brief calls out)
- Category: library-content-in-spec
- Axis: C
- Spec location: SPEC_MANIFEST.md:171–180 (the "Library reliance:" bullet at 171–175 and the "Why named:" bullet at 176–180, inside "### Invariant 4.1 — Block Purity")
- Source location: src/protocol/parser.ts (`processLine`, `onOutputLine`)
- Claim under audit:
  > - Library reliance: `src/protocol/parser.ts` (`processLine`) treats every non-terminator line inside an active response block as command output and forwards it to `onOutputLine`, regardless of its leading byte. That branch is annotated `[LAW:one-source-of-truth]` and names this invariant as its sole justification.
  > - Why named: any future tmux change that violated Invariant 4.1 would silently miscategorise output as events (or vice versa) in every control-mode consumer. Naming the invariant — rather than burying it in prose — makes such a change a discoverable spec edit instead of a silent parser regression.
- Reality in source of truth: The invariant itself (tmux never interleaves a notification into a `%begin`/`%end` block; `tmux.1:7896-7897`) is a genuine protocol fact and KEEPS — the "Upstream citation" and "Rationale" bullets (lines 163–170) are correct protocol prose. But the "Library reliance" bullet describes `src/protocol/parser.ts` (`processLine`, `onOutputLine`, a `[LAW:one-source-of-truth]` annotation) — library internals — and "Why named" justifies a documentation choice about how the manifest tracks the invariant, not a tmux fact. These two bullets are the embedded library incursion.
- Fix direction: relocate-to-IMPL/JSDoc
- Recommendation: Keep Invariant 4.1's statement, upstream citation, and rationale in the manifest. Move the "Library reliance" detail to JSDoc on `processLine` (where the `[LAW:one-source-of-truth]` annotation already lives) or to IMPL.md. The "Why named" meta-justification can be deleted as process commentary or trimmed to a one-line pointer. Do not change.
- Test impact: n/a

### F9 — SPEC_MANIFEST.md §3.2 "Library detach note (library)" is a whole library subsection
- Severity: P2 (tagged `(library)` block pending relocation)
- Category: library-content-in-spec
- Axis: C
- Spec location: SPEC_MANIFEST.md:119–126 (§3.2, heading + body)
- Source location: src/client.ts (`TmuxClient.detach()`, `TmuxClient.close()`); `detachClient()` encoder
- Claim under audit:
  > ### 3.2 Library detach note (library)
  >
  > The §3 bullet above states that an empty line causes the client to detach. `TmuxClient.detach()` (`src/client.ts`) is the typed first-class operation for sending this empty-line signal — it encodes and writes a bare `\n` via the `detachClient()` protocol encoder. This is semantically distinct from `TmuxClient.close()`, which tears down the underlying transport without sending any protocol signal to tmux. Resolves audit finding MANIFEST F4.
- Reality in source of truth: The protocol fact (empty line `\n` causes detach; `control.c:561-564`) is already in §3 (the "empty line causes the client to detach" bullet). This subsection only maps it to `TmuxClient.detach()` / `TmuxClient.close()` / `detachClient()` — library API surface.
- Fix direction: relocate-to-IMPL/JSDoc
- Recommendation: Move to IMPL.md (lifecycle / detach-vs-close) or JSDoc on `TmuxClient.detach`/`close`. Leave §3 intact. Do not change. (Note: this subsection has no SPEC.md mirror; SPEC.md §4.1 carries only the protocol fact, which is correct.)
- Test impact: n/a (P2)

### F10 — SPEC_MANIFEST.md §3.1 "Library parser note: CRLF tolerance" is a whole library subsection (mirror of F6)
- Severity: P2 (tagged-by-title `(library)` block pending relocation)
- Category: library-content-in-spec
- Axis: C
- Spec location: SPEC_MANIFEST.md:104–117 (§3.1, heading + body)
- Source location: src/protocol/parser.ts (`TmuxParser.feed()`)
- Claim under audit:
  > ### 3.1 Library parser note: CRLF tolerance
  >
  > §3 above describes tmux's *input* side ... The library's parser consumes tmux's *output* and goes the opposite direction: `TmuxParser.feed()` (`src/protocol/parser.ts`) strips a trailing `\r` before each `\n` ... The behavior is library-side defensive code, not a tmux rule. SPEC.md §4.3.1 carries the mirror statement on the outer-spec side. Resolves audit finding MANIFEST F7.
- Reality in source of truth: Identical situation to F6 on the manifest side — describes `TmuxParser.feed()`'s output-side CR stripping, self-labeled "library-side defensive code, not a tmux rule." The tmux input-side fact (`EVBUFFER_EOL_LF`; `control.c:557`) is in §3 and is correct.
- Fix direction: relocate-to-IMPL/JSDoc
- Recommendation: Relocate together with SPEC.md §4.3.1 (F6) to IMPL.md or JSDoc on `TmuxParser.feed()`. Do not change.
- Test impact: n/a (P2)

### F11 — SPEC_MANIFEST.md §2.1 "spawnTmux refusal (library)" is a whole library subsection (mirror of F3)
- Severity: P2 (tagged `(library)` block pending relocation)
- Category: library-content-in-spec
- Axis: C
- Spec location: SPEC_MANIFEST.md:62–80 (§2.1, heading + both paragraphs)
- Source location: src/transport/spawn.ts (`spawnTmux`)
- Claim under audit:
  > ### 2.1 spawnTmux refusal (library)
  >
  > The raw-mode configuration above is what tmux *applies* at `-CC` startup. ... The library's default transport `spawnTmux` (`src/transport/spawn.ts`) uses `child_process.spawn`, which supplies pipe stdio rather than a tty, so it cannot host `-CC`. `spawnTmux` therefore emits `-C` only and exposes no option to request `-CC` ... This resolves audit finding MANIFEST F10. ... Consumers that need `-CC` framing must supply a PTY-backed `TmuxTransport`; ... SPEC.md §12.1 carries the mirror statement on the library-spec side.
- Reality in source of truth: Mirror of SPEC.md §12.1 (F3). The tmux fact (`-CC` needs `tcgetattr(stdin)` on a tty; `tmux.c:343-362`) is protocol and is already in §2/§2.1's first sentence; everything about `spawnTmux`, `child_process.spawn`, `node-pty`, `TmuxTransport` is library transport policy.
- Fix direction: relocate-to-IMPL/JSDoc
- Recommendation: Relocate together with SPEC.md §12.1 (F3) to IMPL.md or JSDoc on `spawnTmux`. The bare upstream `tcgetattr`-needs-a-tty fact may remain in §2 with its citation. Do not change.
- Test impact: n/a (P2)

### F12 — SPEC_MANIFEST.md §9.1 "Decoder corollaries" is a whole library subsection (mirror of F1)
- Severity: P2 (tagged-by-content `(library)` block pending relocation)
- Category: library-content-in-spec
- Axis: C
- Spec location: SPEC_MANIFEST.md:405–425 (§9.1, heading + body)
- Source location: src/protocol/decode.ts (`decodeOctalEscapes`)
- Claim under audit:
  > ### 9.1 Decoder corollaries
  >
  > The encoding rule above describes what tmux *emits*. The library's decoder (`src/protocol/decode.ts`, `decodeOctalEscapes`) implements three additional recovery rules ... 1. **Literal control-byte drop.** ... 2. **Mid-escape `\r` skip.** ... 3. **Malformed-escape recovery.** ... SPEC.md §10.1 carries the mirror statement on the outer-spec side.
- Reality in source of truth: Mirror of SPEC.md §10.1 (F1). The tmux encoding rule is in §9 (`control.c:631-642`) and is correct. The three recovery rules are `src/protocol/decode.ts` behavior — the text itself says "A consumer who reads §9 alone cannot predict these behaviors."
- Fix direction: relocate-to-IMPL/JSDoc
- Recommendation: Relocate together with SPEC.md §10.1 (F1) to IMPL.md (decoder tolerance) or JSDoc on `decodeOctalEscapes`. Do not change.
- Test impact: n/a (P2)

### F13 — SPEC_MANIFEST.md §26.1 "Library typed operations (library)" is a whole library subsection
- Severity: P2 (tagged `(library)` block pending relocation)
- Category: library-content-in-spec
- Axis: C
- Spec location: SPEC_MANIFEST.md:791–804 (§26.1, heading + body + bullet list)
- Source location: src/client.ts (`TmuxClient` typed methods)
- Claim under audit:
  > ### 26.1 Library typed operations (library)
  >
  > Beyond the `refresh-client` wrappers enumerated above, `TmuxClient` (`src/client.ts`) exposes typed methods that send other tmux commands:
  > - `execute(command)` — raw tmux command passthrough ...
  > - `listWindows()` — wraps `list-windows`
  > - `listPanes()` — wraps `list-panes`
  > - `sendKeys(target, keys)` — wraps `send-keys`
  > - `splitWindow(options?)` — wraps `split-window`
  > The `refresh-client` variants (`setSize`, `setPaneAction`, `subscribeRaw`, `setFlags`, etc.) are the typed wrappers for the §26 commands listed above. Resolves audit finding MANIFEST F9.
- Reality in source of truth: §26 itself correctly enumerates the tmux `refresh-client` sub-commands with `cmd-refresh-client.c` citations. §26.1 is a catalogue of `TmuxClient` method names (`execute`, `listWindows`, `listPanes`, `sendKeys`, `splitWindow`, `setSize`, `setPaneAction`, `subscribeRaw`, `setFlags`) — pure library API surface, no wire fact added.
- Fix direction: relocate-to-IMPL/JSDoc
- Recommendation: Move to IMPL.md (API surface / typed-method mapping) or distribute as JSDoc on the respective `TmuxClient` methods. Leave §26 intact. Do not change.
- Test impact: n/a (P2)

### F14 — SPEC.md header framing block (lines 3–11): meta-framing — JUDGED keep-but-trim
- Severity: P3 (borderline meta-framing)
- Category: library-content-in-spec (meta)
- Axis: C
- Spec location: SPEC.md:3–11 (the leading blockquote: "PROTOCOL REFERENCE — DO NOT ADD LIBRARY CONTENT HERE." through "...Do not add new ones.")
- Source location: n/a (editorial framing, not a protocol or source claim)
- Claim under audit:
  > > **PROTOCOL REFERENCE — DO NOT ADD LIBRARY CONTENT HERE.**
  > > This file documents the tmux wire protocol ... The library implements this protocol and builds an ergonomic API on top of it. Those two things are separate.
  > > **"Not described in this spec" does not mean "should be removed from the library."** ... do not touch them on the basis that they are not here.
  > > The only valid reason to edit this file is to correct an inaccuracy in the tmux protocol description ... that belongs in `IMPL.md` or source JSDoc.
  > > Some sections contain legacy library notes (labeled `(library)`); these are tracked for migration out of this file by the spec conformance audit (`tmux-audit-q17`). Do not add new ones.
- Reality in source of truth: This is not a protocol claim and not library-behavior documentation; it is a usage contract telling future editors how to treat the file. It mentions "the library", "IMPL.md", "source JSDoc", and the audit ticket name, but as *guidance about the boundary*, not as a description of what the library does.
- Fix direction: relocate-to-IMPL/JSDoc (partial) — judgment: KEEP the boundary statement, TRIM the transient tracking sentence.
- Recommendation (JUDGMENT, as requested — do not assume): **Keep the first three paragraphs** (lines 3–9). They tell a reader/editor that the file is wire-protocol-only and that absence here is not a removal signal — this is exactly the framing that prevents future library incursions, so it earns its place and is appropriately meta rather than library-content. **Trim line 11** ("Some sections contain legacy library notes (labeled `(library)`) ... Do not add new ones.") once F1–F13 are relocated: it is a transient migration tracker referencing this audit ticket, and it becomes stale/false the moment the `(library)` blocks leave. After relocation, either delete it or reduce it to a single sentence: "Do not add library notes here; they belong in IMPL.md or JSDoc." Do not change anything now.
- Test impact: n/a (P3)

## Sections with no findings
Confirmed clean of library content (pure tmux wire-protocol prose, correctly cited to tmux C source / man page):

SPEC.md:
- §1 Overview, §2 Entering Control Mode (incl. §2.1 Variants, §2.2 Init Sequence, §2.3 Teardown) — all tmux C/man citations only.
- §3 Identifier Prefixes; §4 Command Input excluding §4.3.1 (§4.1, §4.2, §4.3, §4.4 are protocol).
- §5 Command Response Protocol (all of §5.1–§5.4) — `cmd-queue.c` / `control.c` only.
- §6 Notifications (§6.1–§6.3); §7 Notification Reference §7.2–§7.12 (only §7.1's inline note at line 316 is flagged, F7).
- §8 Exit Handling; §9 Client Flags; §10 Data Encoding body (only §10.1 flagged, F1).
- §11 Client Size Control body (only §11.1 flagged, F2); §12 DCS Wrapping body (only §12.1 flagged, F3).
- §13 Pane Control; §14 Subscriptions; §15 Reports body (only §15.1 flagged, F4).
- §16 Backpressure; §17 Internal Buffering; §18 Pane Output Integration; §19 Clipboard Query.
- §20 Data Structures (all C structs); §21 Format Variables; §22 Behavioral Differences.
- §23 Complete Message Reference tables (only §23.1 flagged, F5); §24 Source File Reference (tmux files); §25 Known Man Page vs Code Discrepancies.

SPEC_MANIFEST.md:
- §1 Entry Points; §2 DCS Wrapping body (only §2.1 flagged, F11); §3 Command Input body (only §3.1, §3.2 flagged, F10/F9).
- §4 Command Response Protocol incl. Invariant 4.1 statement/upstream-citation/rationale bullets (only the "Library reliance" + "Why named" bullets flagged, F8).
- §5 Notifications Overview; §6 All Notification Types; §7 Exit Reasons; §8 Exit Handling.
- §9 Data Encoding body (only §9.1 flagged, F12); §10 Client Flags; §11 Client Size Control; §12 Pane Control; §13 Subscriptions; §14 Reports; §15 Clipboard Query.
- §16 Backpressure; §17 Internal Buffering; §18 Pane State Flags; §19 Data Structures; §20 Client Struct Fields; §21 Flag Values; §22 Identifier Prefixes; §23 Format Variables; §24 Hooks/Dispatch; §25 Pane Output Integration.
- §26 Control Mode Commands body (only §26.1 flagged, F13); §27 detach-client -E; §28 Server-Side Exit Handling; §29 Behavioral Differences; §30 Internal Helper Functions; §31 Source Files; §32 Man Page Sections; §33 Man Page vs Code Discrepancies.

Note on `control_write` / other tmux C symbols: all `control_*`, `cmdq_*`, `cmd_*`, `server_*`, `window_*`, `notify_*` mentions throughout both files are tmux C source symbols (protocol, KEEP) and were NOT flagged — only `src/...ts` TypeScript symbols and library method/type names were treated as library content.
