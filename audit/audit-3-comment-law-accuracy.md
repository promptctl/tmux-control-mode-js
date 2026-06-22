# Audit 3/4 — Comment & `[LAW:]` marker accuracy report

**Ticket:** `tmux-audit-0si`
**Date:** 2026-06-22
**Branch:** `tmux-audit-0si`
**Scope:** In-code comments and JSDoc under `src/**/*.ts`, `packages/pane-terminal/src/**/*.ts`, plus the `[LAW:]` markers and code-block comments in `tsconfig*.json` (JSONC). 65 source files; ~442 `[LAW:]` markers.
**Out of scope:** Markdown prose (audit 1/4 → `tmux-docs-ay0`); SPEC.md / SPEC_MANIFEST.md (audit 2/4 → `tmux-audit-q17`); code structure / god modules (audit 4/4 → `tmux-audit-p5y`).

This is a **read-only** report. No source edits were made during the audit. Findings feed the remediation epic `tmux-audit-comments-*` — one child ticket per P0/P1 finding, batched per-subsystem tickets for P2 mechanical removals, all ranked to the top of the backlog.

> **Methodology note.** The ticket names `/vet-comments` as the tool. That skill does not exist in this environment (same gap the prior handoff flagged for `/recap`). The ticket's methodology is fully self-describing, so it was executed directly: nine parallel auditor subagents sharded by subsystem, each reading whole files and verifying every comment/marker against the code. Every **P0** and **P1** finding below was then **independently re-verified against source by the synthesizing agent** before being catalogued — several subagent "lying-law" P0s were dropped or downgraded on that pass (see *Adjudication* below). A finding minted from an unverified subagent claim would commit the very drift this audit hunts; `[LAW:verifiable-goals]` applies to the audit's own output.

---

## Severity scheme (per ticket spec)

- **P0** — a lying or non-canonical `[LAW:]` marker. Blast radius is **non-local**: downstream agents trust markers as architectural ground truth and may make destructive edits based on a false one. A marker is P0 when it cites a non-canonical token, OR cites a law the code's decision does not make, OR states a reason the code factually contradicts.
- **P1** — a non-`[LAW:]` comment that is **false and load-bearing**: a reader would act on it (hunt for a named symbol, trust a stated contract/enforcement that does not exist).
- **P2** — **stale** (once true, source moved), **what-not-why** (restates the code; forbidden by CLAUDE.md), **drift-prone** (forbidden enumeration: counts, caller/function/file lists, line/issue refs), or **token-precision** (a marker whose reason is true but whose token is a defensible-but-imprecise cousin — not actively misleading). Batched per subsystem; mechanical.

## The 19 canonical `[LAW:]` tokens

`decomposition · types-are-the-program · composability · carrying-cost · no-ambient-temporal-coupling · effects-at-boundaries · one-source-of-truth · single-enforcer · comments-explain-why-only · dataflow-not-control-flow · one-type-per-behavior · no-mode-explosion · no-defensive-null-guards · locality-or-seam · one-way-deps · no-shared-mutable-globals · verifiable-goals · behavior-not-structure · no-silent-failure`

Coining a new token is forbidden by the citation protocol. Any other string in a `[LAW:...]` marker is a P0 by construction.

---

## P0 — Lying / non-canonical `[LAW:]` markers

### P0-1 — `src/line-sink.ts:26` cites the non-canonical token `[LAW:make-it-impossible]`
- **Verbatim:** `// [LAW:make-it-impossible] Line consumers receive `{ line: string; paneId }``
- **Divergence:** `make-it-impossible` is not one of the 19 canonical tokens. The identical decision — the shared `TextDecoder` is unreachable from the value the consumer holds, so a downstream cannot misdecode by reaching through — is correctly tagged `[LAW:types-are-the-program]` at the twin site `src/sinks/text-stream.ts:16`.
- **Fix:** Replace `[LAW:make-it-impossible]` with `[LAW:types-are-the-program]`. Keep the reason text.

### P0-2 — `src/keymap/engine.ts:64` (+ guard at :87) — `[LAW:dataflow-not-control-flow]` reason is factually false
- **Verbatim (64–68):** `[LAW:dataflow-not-control-flow] The function always executes the same sequence: compute (isPrefix, matchedBinding, isInPrefixMode), then pick the result. There is no early-return optimization that would cause one branch to do less work than another; control flow is the same shape per call and the returned *value* encodes the outcome.`
- **Divergence:** Lines 91–93 are an early return — `if (BARE_MODIFIER_KEYS.has(event.key)) { return { state, actions: [], handled: false }; }` — that skips computing `isPrefix`, `matched`, and `inPrefixMode`. The marker's "There is no early-return optimization" is directly contradicted by the code below it. The companion marker at `:87` concedes "we're not skipping the function, we're returning early-out data," but the construct *is* a control-flow early return, which is exactly what the cited law forbids.
- **Fix:** Either fold the bare-modifier case into the value/table path so the no-branch claim holds, or correct both markers to stop claiming branch-freedom. Implementer's choice (the table-driven body at 99–134 is genuinely correct `dataflow-not-control-flow` and should stay).

### P0-3 — `src/transport/spawn.ts:82` & `:133` — two `[LAW:dataflow-not-control-flow]` reasons contradicted by the stdout handler
- **Verbatim (82–83):** `[LAW:dataflow-not-control-flow] Callback arrays always exist; they may be empty. Every registration pushes; every dispatch iterates. No conditional execution paths.`
- **Verbatim (133–136):** `[LAW:dataflow-not-control-flow] The data pipeline runs on every chunk. In -C mode the stripper is null and the chunk forwards unchanged. In -CC mode the stripper applies the DCS framing rules. The pipeline shape is identical; only the values differ.`
- **Divergence:** The `child.stdout.on("data", …)` handler (lines 158–171) branches three ways: `if (stripper === null) { …forEach…; return; }`, `if (result.error !== undefined) { …forEach…; return; }`, `if (result.forward.length > 0) { …forEach… }`. Whether `dataCallbacks` fire is conditional — directly contradicting both "No conditional execution paths" and "The pipeline shape is identical; only the values differ." (Aside: the `-CC` branch is effectively dead — `spawnTmux` throws on `controlControl` at 105–113, so `stripper` is always `null`.)
- **Fix:** Correct the marker reasons to describe the real branching, or refactor the handler into a branch-free value pipeline. One ticket covers both markers (shared root cause).

### P0-4 — `src/connectors/rpc.ts:370` — `[LAW:single-enforcer]` cited to justify violating it
- **Verbatim:** `// [LAW:single-enforcer] Non-empty string check for subscription names.` / `// The WS frame parser already rejects empty IDs; the RPC layer must be` / `// symmetric — empty subscription names are meaningless to tmux.`
- **Divergence:** `single-enforcer` mandates one enforcement boundary — *"if enforcement already exists, remove the duplicate, never add another."* This reason justifies **adding a second, "symmetric" check** because the WS frame parser already rejects empties — the precise inverse of the law.
- **Fix:** If frame-ID rejection and subscription-name rejection are the same invariant, consolidate to one enforcer. If they are different invariants (frame correlation ID vs. RPC argument), rewrite the reason to drop the "symmetric with the WS parser" framing — it is then ordinary boundary input-validation, not single-enforcer, and likely wants a different token or none.

### P0-5 — `src/protocol/byte-codec.ts:26` — `[LAW:single-enforcer]` on a performance chunk-loop
- **Verbatim:** `// [LAW:single-enforcer] Chunked to avoid call-stack overflow on large inputs.`
- **Divergence:** Chunking the `String.fromCharCode(...bytes.subarray(...))` loop is a stack-overflow mitigation for argument spread; it enforces no cross-cutting invariant. The file's genuine `single-enforcer` marker is at lines 4–6 ("All bytes<->string conversion in this library flows through these two functions"). This inline citation mislabels a perf technique as enforcement, and a downstream agent could read the chunk loop as load-bearing for the conversion single-enforcement invariant.
- **Fix:** Drop the `[LAW:single-enforcer]` token at :26; keep the WHY as a plain comment.

### P0-6 — `src/line-sink.ts` (76–80, 172, 179–182) — `[LAW:single-enforcer]` reason and types name the wrong type
- **Verbatim (179–182):** `// [LAW:single-enforcer] Decode-and-split runs at most once per chunk.` / `//   `SinkRegistry` dispatches the same `PaneOutputMessage` reference to` / `//   every admitting byte sink; the identity check makes the second-and-` / `//   subsequent calls no-ops for decode.`
- **Divergence:** `BytesSink.write(msg: ChunkPayload)` (`src/pane-output.ts:60`); `ChunkPayload` is `{ paneId, data }` and its JSDoc states the wire `type` and `age` fields *"never reach the sink"*. `SinkRegistry` therefore dispatches a `ChunkPayload`, **not** a `PaneOutputMessage`. Yet `line-sink.ts` names the wrong type at the field `lastMsg: PaneOutputMessage` (80), the param `write(msg: PaneOutputMessage)` (172), and the comments (76–79, 180). A reader accessing `msg.type` / `msg.age` gets `undefined`. This only type-checks because TypeScript method-parameter bivariance accepts a wider-typed `write`.
- **Fix:** Replace `PaneOutputMessage` with `ChunkPayload` throughout `line-sink.ts` (import from `./pane-output.js`). The `single-enforcer` decision itself (decode once per chunk, keyed on object identity) is correct — only the type name drifted.

---

## P1 — Load-bearing-false comments

### P1-1 — `src/errors.ts:22` — phantom `sendRaw` and "methods"
- **Verbatim:** `* tmux command (i.e. anything backed by sendRaw — `execute`, `sendKeys`,` (continues `splitWindow`, `setSize`, `setPaneAction`, `subscribe`, `unsubscribe`, `setFlags`, `clearFlags`, `requestReport`, `queryClipboard`).
- **Divergence:** No `sendRaw` exists (grep: comment-only; `src/client.ts:139` explicitly states *"No sendRaw escape hatch for callers"*). The listed operations are free functions in `src/commands/index.ts`, not `TmuxClient` methods — a reader hunts for nonexistent `client.sendRaw()` / `client.sendKeys()`. The list is also already stale: it names `subscribe`, but the real export is `subscribeRaw`.
- **Fix:** Rewrite without the `sendRaw` reference and without the function enumeration; describe what the error *means* and delegate the command list to `src/commands/index.ts`.

### P1-2 — exclusivity-registry false story: `src/connectors/errors.ts:65,68` + `src/connectors/electron/renderer.ts:419`
- **Verbatim (errors.ts:65):** `* A second `attachWebContentsSink`, `createPaneBytesReceiver`, or` / `* `attachWebSocketSink` was constructed for a `(target, paneId)` pair` / `* that already has an active attachment.`
- **Verbatim (renderer.ts:419):** `// Symmetric to the main-side `ACTIVE_PANE_SINK_ATTACHMENTS` in `main.ts`,`
- **Divergence:** `BRIDGE_PANE_SINK_ALREADY_ATTACHED` is thrown **only** by `createPaneBytesReceiver` (`renderer.ts:487`). `attachWebContentsSink` (main.ts) and `attachWebSocketSink` (websocket/sink.ts) both explicitly document "no exclusivity registry" and never throw it. No `ACTIVE_PANE_SINK_ATTACHMENTS` symbol exists anywhere (grep: comment-only). A downstream agent could "implement" the supposedly-missing main-side registry, or trust enforcement that is not there.
- **Fix:** Correct `errors.ts` to name only the renderer receiver as the thrower; remove the false "symmetric main-side `ACTIVE_PANE_SINK_ATTACHMENTS`" claim in `renderer.ts`. One ticket — the two sites tell one false story and must be fixed coherently.

### P1-3 — `src/connectors/bridge-connection.ts:32` — phantom `subscriptionRefcount`
- **Verbatim:** `// the bookkeeping. A grep for `subscriptionRefcount` should turn up exactly` / `// one definition site.`
- **Divergence:** `subscriptionRefcount` exists nowhere (grep: comment-only). The refcount is `SubscriptionRecord.owners` (a `Set`), counted via `rec.owners.size`. Following the grep instruction yields zero hits.
- **Fix:** Rewrite to reference the real `owners` Set, or drop the grep instruction.

### P1-4 — `src/connectors/websocket/server.ts:793` — phantom `attachAllPanesSink`
- **Verbatim:** `//     `client.attachAllPanesSink`, not through `client.on('*', …)`,`
- **Divergence:** No `attachAllPanesSink` method exists. The byte channel is wired via `client.attachBytesSink(this.byteForwarder)` (`server.ts:563`; the disposer comment at `:318` names it correctly).
- **Fix:** Correct `attachAllPanesSink` → `attachBytesSink`.

### P1-5 — `packages/pane-terminal/src/bench/index.ts:6` — "land in later steps" describes shipped code
- **Verbatim:** `// Real implementation surfaces (PaneStream, TerminalSink, XtermSink) land in` / `// later steps of the tmux-pane-terminal-8w9 epic. This module hosts the` / `// deterministic FakeTmuxClient that gates can use without a live tmux.`
- **Divergence:** `PaneStream` (`stream/pane-stream.ts`), `TerminalSink` (`sink/index.ts`), and `XtermSink` (`xterm-sink/index.ts`) all already exist and ship in this package. A reader believes these surfaces are not yet implemented.
- **Fix:** Remove the "land in later steps" framing; describe what `bench/` provides today.

### P1-6 — `src/keymap/engine.ts:49–56` — contract table omits and contradicts the bare-modifier path
- **Verbatim (row 56):** `* - `prefix` + unbound non-prefix chord         → state=root,   actions=[],       handled=true`
- **Divergence:** A bare modifier (`Shift`/`Control`/`Alt`/`Meta`) pressed in prefix mode *is* an "unbound non-prefix chord," but the guard at 91–93 returns `handled=false` with state **unchanged** (stays `prefix`). The contract table neither lists the bare-modifier case nor matches its actual behavior — the documented row says such a key returns `handled=true` and resets to `root`.
- **Fix:** Add a bare-modifier row to the contract table (state preserved, `actions=[]`, `handled=false`). Pairs naturally with P0-2 (same code region).

---

## P2 — Batched per-subsystem (stale / what-not-why / drift-prone / token-precision)

> Batched by subsystem rather than strictly per-file: each ticket is a single focused cleanup pass over one subsystem's comments. Mechanical; no behavior change.

### P2-1 — transport comments (`src/transport/spawn.ts`, `src/transport/index.ts`)
- `index.ts:2` what-not-why: `// Barrel export for the transport layer.` (the exports show this).
- `index.ts:5` token-precision: `[LAW:one-source-of-truth] Re-exports only; no logic lives here.` — reason is a decomposition/no-logic statement; OSOT is not the decision a barrel makes.
- `spawn.ts:14` (×2) what-not-why: the trailing `// 7 bytes: ESC P 1 0 0 0 p` / `// 2 bytes: ESC backslash` enumerate the literal the code already encodes (byte counts are accurate).
- `spawn.ts:13` token-precision: `[LAW:one-source-of-truth] DCS frame bytes live here only` — the introducer literal is restated in `createDcsStripper`'s JSDoc, weakening "live here only."
- `spawn.ts:66` token-precision: `[LAW:one-source-of-truth] Single function builds the full argv` — "single function builds it" is single-enforcer/decomposition flavor; no derived second representation is being synchronized.

### P2-2 — client-core comments (`src/connection-state.ts`)
- `connection-state.ts:37` drift-prone: JSDoc enumerates the concrete client classes `(`TmuxClient`, `WebSocketTmuxClient`, `TmuxClientProxy`)` — a caller list to be hand-maintained.

### P2-3 — pane-io / routing comments (`src/pane-output.ts`, `src/topology-router.ts`)
- `pane-output.ts:135,140` drift-prone: the `Callers:` / method-name enumeration (`seed`, `updateWindow`, `removeWindow`, `get`) is a forbidden caller list.
- `topology-router.ts:5` drift-prone: `~240` line count of code that "was duplicated" — a count CLAUDE.md forbids and that cannot be kept current.

### P2-4 — connectors comments (`src/connectors/bridge-connection.ts`, `bridge-dispatch.ts`, `electron/main.ts`)
- `bridge-connection.ts:18` drift-prone: enumerates external issue IDs `H7 + C4 … C2/C3` — unverifiable from code, drifts with the tracker.
- `bridge-dispatch.ts:24` drift-prone: names prior code sites `websocket/server.ts + electron/main.ts` describing history; the WHY stands without the file list.
- `electron/main.ts:700` stale: re-exports `PaneBytesEnvelope` / `PaneEndEnvelope`, but the file header's "owns ONLY electron-specific" inventory never mentions a pane-bytes channel (`WebContentsSink.write` sends on `IPC.event`), making the header incomplete.

### P2-5 — keymap comments (`src/keymap/engine.ts`, `actions.ts`, `bind.ts`, `key-event.ts`)
- `engine.ts:70` token-precision: `[LAW:one-source-of-truth]` on `BARE_MODIFIER_KEYS` — defensible (the set is the canonical list); reason true, low harm. Reviewer may keep or retag.
- `engine.ts:17` token-precision + drift: `[LAW:one-type-per-behavior]` is cited to justify keeping two *different* types apart (the law is about merging *identical* behavior); also embeds the type-name references `Binding` / `KeymapBinding`.
- `engine.ts:99` drift-prone: the comment carries a `five rows` count enumeration.
- `actions.ts:3` drift-prone (filename/function refs); `actions.ts:8` what-not-why.
- `bind.ts:100` drift-prone (name refs); `bind.ts:124` what-not-why; `bind.ts:84` imprecise: `// Fire-and-forget: actions dispatch asynchronously` — the dispatch loop is synchronous (`void client.execute(...)` discards the promise; nothing is deferred here).
- `key-event.ts:20–27` internal contradiction (low blast radius): the implicit-shift block says uppercase letters get implicit-shift (don't-care), then offers `(a vs A)` as an example of *strict* comparison — but `shiftIsImplicit("A")` is `true`, so `A` is **not** compared strictly. The behavior is correct; the example is muddled.

### P2-6 — tsconfig JSONC include-dir enumerations
- `packages/pane-terminal/tsconfig.json:4` drift-prone **and stale**: `(./stream, ./sink)` duplicates the core `include` array and omits `./bench`, which `tsconfig.core.json` does compile.
- `packages/pane-terminal/tsconfig.core.json:3` drift-prone: `core (./stream, ./sink, ./bench)` duplicates the `include` array.
- `packages/pane-terminal/tsconfig.dom.json:4` drift-prone: `(./xterm-sink, ./react, ./vanilla)` duplicates the `include` array.

### P2-7 — pane-terminal "Gate N" enumeration + stale ticket-refs sweep (`packages/pane-terminal/src/**`)
- Pervasive drift-prone pattern: comments and two `[LAW:]` marker *reasons* tie prose to the external bench/test "Gate" numbering — `bench/fake-tmux-client.ts` (`Gate 4`, `Gates 1 and 7`, lines ~120/121/137 + `:19` method-name list), `sink/buffering-sink.ts` (`Gates 4 and 5`, `gate 5`, `gate 7` at :9/:73/:127), `stream/pane-stream.ts` (`gate #4` at :138/:140/:290/:317/:637, `Gate 3's 2MB/60s budget` at :483, `this single line`), `stream/reseed-scheduler.ts:74` (`Tests inspect this.`), `xterm-sink/index.ts` (`Gate 5` at :36/:250, `resize-storm test` at :444). These tie comments to a test-suite numbering that drifts on any renumber/removal.
- Stale: `sink/index.ts:1` (`XtermSink in 8w9.6`) and `stream/index.ts:4` (`BufferingSink in 8w9.5`, `XtermSink in 8w9.6`) frame already-shipped sinks as future tickets; `bench/fake-tmux-client.ts:121` "future gates may script the response payload" (already implemented at `:300`).
- what-not-why: `bench/fake-tmux-client.ts:304` restates the method body.
- `sink/index.ts:5` drift-prone tech-name list (`xterm, MobX, React, DOM`) — `MobX` is not referenced anywhere else here.
- **Fix:** Replace "Gate N" / test-name references with the *property* being protected (e.g. "exactly one capture on re-mount", "no decode on the byte path"); delete the stale ticket-ref framing. Largest single cleanup; ~22 comment sites, no behavior change.

---

## Adjudication — subagent P0 claims dropped or downgraded on re-verification

The synthesizing agent read the cited code for every P0 claim. These subagent "lying-law" P0s did **not** survive:

| Site | Subagent claim | Verdict | Why |
|---|---|---|---|
| `engine.ts:137` | `single-enforcer` "all chord comparisons route through keysEqual" bypassed by `handleKey` calling `keysEqual` directly | **Dropped** | The marker claims routing through *`keysEqual`*, and line 95 *does* call `keysEqual`. Accurate; agent misread the claim as "route through `findBinding`". |
| `engine.ts:99` | `dataflow-not-control-flow` violated by the nested-ternary index selector | **Dropped** | The `outcomes` array is built unconditionally; the ternary selects an *index value*. That is correct dataflow, not control flow. |
| `bind.ts:105` | `single-enforcer` is "really one-source-of-truth" | **Dropped** | "Sole canonical mapping from Action → tmux command" is exactly single-enforcer. |
| `key-event.ts:39` | `single-enforcer` undercut by the predicate being called twice | **Dropped** | single-enforcer is about the *definition* site, not the number of call sites. Accurate. |
| `engine.ts:70`, `engine.ts:17` | `one-source-of-truth` / `one-type-per-behavior` lying-law P0 | **Downgraded to P2** | Reasons are true; tokens are defensible-but-imprecise, not actively misleading. |
| `transport/index.ts:5`, `spawn.ts:66`, `spawn.ts:13` | `one-source-of-truth` lying-law P0 | **Downgraded to P2** | Token-precision; reasons true; a barrel/argv-builder mislabelled OSOT will not cause a destructive edit. |
| 5× tsconfig `one-source-of-truth` "keep build cache out of dist/" | (already not flagged by the tsconfig auditor) | **Confirmed accurate** | `dist` is the authoritative published artifact; the `tsbuildinfo` cache is derived and kept out of it — OSOT fits. |

The keymap auditor also self-retracted one finding (`key-event.ts:49` chord examples) on its own pass — correct; the examples are accurate.

---

## Coverage

All 65 in-scope files were read in full by the auditor pass; every `[LAW:]` marker was individually checked against the code decision. Totals across the nine shards: **6 P0**, **6 P1**, **7 P2 (batched)** actionable findings. The remaining ~400 markers and the bulk of comments verified as accurate WHY-comments and are not listed (only problems are catalogued).
</content>
</invoke>
