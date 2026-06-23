# Audit 4/4 — Architectural complexity report

**Ticket:** `tmux-audit-p5y`
**Date:** 2026-06-22
**Branch:** `tmux-audit-p5y`
**Base:** `251c770`
**Scope:** `src/**`, `packages/pane-terminal/src/**`, `examples/web-multiplexer/**` (showcase; lower priority but in scope).
**Out of scope:** prose drift (audit 1/4 → `tmux-docs-ay0`); spec drift (audit 2/4 → `tmux-audit-q17`); comment/`[LAW:]` accuracy (audit 3/4 → `tmux-audit-0si`).

This is a **read-only** report. No source was edited during the audit. Findings feed the remediation epic `tmux-complexity-*` — a dedicated dead-code removal sub-epic plus structural tickets, all ranked to the top of the backlog (library findings above showcase findings at each tier).

> **Methodology.** Two deterministic mechanical checks (dead-export, orphaned-output) were run by the synthesizing agent against a *true* clean build; then six parallel `Explore` subagents sharded the source by subsystem, each reading whole files and grep-verifying every dead-code claim across the whole repo. **Every dead-code finding promoted to a deletion ticket was then independently re-verified against source by the synthesizing agent** — and several subagent "dead" P0/P3 claims were corrected on that pass (see *Adjudication*). A deletion ticket minted from an unverified claim could delete a load-bearing protocol method; `[LAW:verifiable-goals]` and `[LAW:no-silent-failure]` apply to the audit's own output.

---

## Severity scheme

- **P0** — dead **export** (an `exports` target with no producing source), orphaned **output** (a `dist/` file no source emits), a **release-integrity** hazard of that class, or a structural-law violation that makes an illegal state representable across a published seam. Non-local blast radius.
- **P1** — **god module**: one file/closure fusing multiple change-reasons. Blocks v1.0 feature work because every change re-reads the whole unit.
- **P2** — **scattered concern / duplicated state**: one concept enforced at multiple callsites, or one logical value held in two structures that drift.
- **P3** — **dead internal code**, type-weakness, special-case, or incomplete-refactoring residue. Bounded, mostly quick wins.

## The 19 canonical `[LAW:]` tokens

`decomposition · types-are-the-program · composability · carrying-cost · no-ambient-temporal-coupling · effects-at-boundaries · one-source-of-truth · single-enforcer · comments-explain-why-only · dataflow-not-control-flow · one-type-per-behavior · no-mode-explosion · no-defensive-null-guards · locality-or-seam · one-way-deps · no-shared-mutable-globals · verifiable-goals · behavior-not-structure · no-silent-failure`

---

## Mechanical checks (the PR #39 class)

### M0 — `tsc --build` + `rm -rf dist` silently no-ops → release-integrity hazard — **P0**
- **Where:** `package.json` `scripts.build` (`tsc --build`), `scripts.prepublishOnly` (`check:deps && build`); `scripts/check-no-deps.mjs` (the only publish guard).
- **What:** The ticket's own methodology command — `rm -rf dist && build` — produces an **empty `dist/`** and still exits 0. `tsc --build` consults `*.tsbuildinfo` to decide what to emit; deleting `dist/` without deleting the buildinfo leaves tsc convinced the outputs are current, so it emits nothing. A *true* clean build requires `tsc --build --clean` **and** removing the `*.tsbuildinfo` files. Reproduced this session: `rm -rf dist && pnpm build` → 0 `.js` files; `pnpm clean && rm -rf dist && find . -name '*.tsbuildinfo' -delete && pnpm build` → 46 `.js` files.
- **[LAW:one-source-of-truth]** — the buildinfo cache and the actual `dist/` can disagree, and nothing enforces their agreement. This is exactly the PR #39 incident class: a dead/incomplete `dist/` shipping because the build's emit decision trusted stale local state.
- **Blast radius:** the published package. `prepublishOnly` runs `tsc --build` with whatever buildinfo is on disk; a partial/stale `dist/` could publish. There is **no guard** that every `exports` target exists in the emitted `dist/`, and no dist-completeness check.
- **Constraint that would make it unrepresentable:** a `prepublishOnly` step that (a) forces a clean emit (`--clean` + buildinfo removal, or build into a fresh temp dir) and (b) asserts every `package.json` `exports` target file exists after build. A dangling export then fails the publish loudly instead of shipping.
- **Fix shape:** add `scripts/check-exports.mjs` (assert each `exports` target exists post-build) + make the publish build clean; wire both into `prepublishOnly`. → ticket **BUILD1**.

### Dead-export check — **CLEAN (against true clean build)**
All **26** `exports` targets (13 subpaths × types+default) resolve to a file in a true clean `dist/`. The PR #39 `./terminal` dangling export is gone. *Caveat:* this is only true after a clean build — see M0.

### Orphaned-output check — **CLEAN**
All **46** emitted `dist/**/*.js` trace back to a `src/**` or `packages/**` source. No orphans.

---

## Adjudication — corrected / resolved / cross-referenced (recorded for honesty)

These were claimed by a subagent or by a prior ticket but were **downgraded, corrected, or found already-resolved** on independent re-verification. They are **not** turned into deletion tickets as-stated.

| Item | Prior claim | Verified reality | Disposition |
|------|-------------|------------------|-------------|
| `line-sink.ts` `PaneOutputMessage`/`ChunkPayload` bivariance | OPEN (ticket comment, ex-`t4c.6`) | **Already remediated.** `PaneOutputMessage` appears nowhere in `line-sink.ts`; the byte path is `ChunkPayload` end-to-end (`client.ts:240` → `pane-output.ts:362/514` → sink `write(msg: ChunkPayload)`). A `PaneOutputMessage` mismatch would now compile-error. | **No ticket.** Closed-by-verification. |
| `WEBSOCKET_CLOSING` / `WEBSOCKET_CLOSED` | "zero call sites — dead" | **Test-used** (`tests/unit/websocket-sink.test.ts` via `setReadyState`) and public `exports`. Unused in *production* only. | **Evaluate**, not delete → folded into ticket **DC4** as a public-API retention decision, not a deletion. |
| Showcase `detach` bridge method | "invoked by nobody — delete" | **Functionally wired:** `ws-client.ts:219` sends `{kind:"detach"}`, `server/bridge.ts:174` handles it via `client.detach()`. No *UI* trigger, but it is a live protocol path. | **Evaluate** → noted in **DC6**, not a blind deletion. |
| `sendKeysToPane` (showcase) | "never called — dead" | Orphaned (no caller); but the e2e spec comment (`web-multiplexer-electron.spec.ts:209`) **falsely** claims `PaneTerminal calls store.sendKeysToPane`. Keystrokes actually route through the xterm sink `onData`. | **Delete the method AND fix the stale e2e comment** → **DC6**. |
| z31.9 BytesSink-redesign residue (connectors + pane-terminal byte path) | Suspected wider class after `rjh` (#97) | **No net-new residue.** All 5 Electron IPC channels have both ends; both surviving sinks document "no exclusivity registry"; pane-stream's old per-pane guard is confirmed removed. Only the `rjh` instance existed (already removed). | **Class closed.** The fake's dead `injectExtendedOutput` arm (DC5) is test scaffolding, not production residue. |
| S1 — WebSocketTmuxClient dual state machine | New finding (agent 3) | **Already tracked** as backlog ticket `tmux-simplify-wwo.5.1` ("Collapse … onto unified ConnectionState when @deprecated state/onState drops"). | **Cross-ref**, no duplicate. **GM2** depends on it. |

---

## P0 — Dead code (verified, library)

### DC1 — `-CC` / DCS-stripper machinery is unreachable
- **Where:** `src/transport/spawn.ts` — `createDcsStripper`/`DcsStripperResult` (~25-65), the stripper install + branch (~137-174), DCS write in `close()` (~206-210), `DCS_INTRODUCER`/`DCS_TERMINATOR` (~15-16), `buildArgv` `-CC` arm (~74), and the `controlControl` throw guard (~109-117).
- **What:** `spawnTmux` throws unconditionally when `controlControl` is true, so downstream `controlControl` is provably `false`: `stripper` is always `null`, the `stripper !== null` arm never runs, the DCS terminator write never runs. **Grep:** `createDcsStripper` has no callers outside `spawn.ts` (the dead line) and `tests/unit/transport.test.ts` — a unit test exercising provably-dead production code (`[LAW:behavior-not-structure]`).
- **[LAW:dataflow-not-control-flow]**, **[LAW:carrying-cost]** — a value-driven branch whose value has only one possibility.
- **Constraint:** remove `controlControl` from `SpawnOptions`; with no value to branch on, the dead paths are uninstantiable. If `-CC` is ever needed it belongs in a separate transport constructor, not a boolean that exists only to be rejected.
- **Fix:** deletion (+ delete its unit test). Quick win.

### DC2 — dead protocol/encoder exports: `asPaneOutput`, `buildCommand`
- **Where:** `src/protocol/types.ts` `asPaneOutput` (~359-363); `src/protocol/encoder.ts` `buildCommand` (~104-106) + barrel re-export `src/protocol/index.ts:51`.
- **What:** `asPaneOutput` — **zero callers anywhere** (only its own definition; not even a test). `buildCommand` — **test-only** (`tests/unit/encoder.test.ts`); its own comment admits it is "kept for backward-compat." The newline terminator is really owned by `spawnTmux.send()` — `buildCommand` is a second, unused source of that rule (`[LAW:one-source-of-truth]`).
- **[LAW:carrying-cost]**, **[LAW:one-source-of-truth]**.
- **Fix:** deletion (+ delete the `buildCommand` test block). Quick win. *Note:* both are published-surface exports → semver-minor surface change.

### DC3 — `tmux-compat.ts` is test-only; `CONFIG_ERROR_MIN_VERSION` is dead
- **Where:** `src/tmux-compat.ts` (whole module); `CONFIG_ERROR_MIN_VERSION` (~32).
- **What:** the module is **not re-exported** from `src/index.ts` or `src/browser.ts`; every consumer is a test importing the source path directly. `CONFIG_ERROR_MIN_VERSION` is referenced only by a self-equality assertion in its own test (`expect(...).toEqual({major:3,minor:4})`) — it gates nothing. The version predicate (`meetsTmuxVersion`) is never called before `requestReport()` sends `refresh-client -r`, so the 3.5 floor is unit-tested but not enforced — a producer/consumer split where the consumer was stranded.
- **[LAW:carrying-cost]**; the broader wiring gap is **[LAW:single-enforcer]** (the version gate has no real enforcer).
- **Fix:** delete `CONFIG_ERROR_MIN_VERSION` (quick win); **separately decide** whether to wire `meetsTmuxVersion` into the client's `requestReport` path (give the floor a real enforcer) or relocate the module under `tests/`. The decision half is **not** a quick win.

---

## P3 — Dead code (verified, library)

### DC4 — dead connector type-surface members
- **Where:** `src/connectors/websocket/types.ts` `ServerWebSocketLike.off?` (~105); `src/connectors/electron/types.ts` `IpcRendererEventLike.sender?: unknown` (~108-123); `src/connectors/electron/main.ts` `forwardState` pass-through (~362-366). **Plus** the *evaluate* item: `WEBSOCKET_CLOSING`/`WEBSOCKET_CLOSED` (public + test, prod-unused).
- **What:** `off?` — never invoked on the socket (the `.off(` sites are `EmitterImpl`/`TmuxClient`). `sender` — an `unknown` optional the JSDoc itself says "the bridge does not currently use"; never read. `forwardState` — a pure alias for `broadcast` that exists only to give `on`/`off` a stable reference; register `broadcast` directly.
- **[LAW:carrying-cost]**; `sender: unknown` is also **[LAW:types-are-the-program]** (a meaningless representable field on the public surface).
- **Fix:** delete the three dead members; for `WEBSOCKET_CLOSING/_CLOSED` make an explicit keep-as-public-API vs remove decision (do not blind-delete — they're tested).

### DC5 — dead pane-terminal surface
- **Where:** `packages/pane-terminal/src/sink/index.ts` `TerminalSink.clear` (~88) + impls; `packages/pane-terminal/src/bench/fake-tmux-client.ts` `injectExtendedOutput` (~261), `seedTopology`, and `FakeExtendedOutputMessage`/`FakeConnectionStateMessage`/`FakeReconnectedMessage` re-exports (`bench/index.ts`).
- **What:** `TerminalSink.clear()` — called only by tests; no production producer (`PaneStream`/vanilla/React) invokes it, and its own comment concedes "NOT called on detach()." It is dead **seam** surface every impl must carry. `injectExtendedOutput` — zero test callers; `seedTopology` likewise (it exists only to serve the dead extended-output path, dragging a `PaneTopologyManager`/`serverScope` import into the fake).
- **[LAW:carrying-cost]**.
- **Fix:** drop `TerminalSink.clear` from the seam (keep concrete `clear` on impls if tests want it); delete the fake's unexercised injection methods + the three unused message re-exports. Verify the `extended-output` discriminant arm before pruning the union.

### DC6 — dead showcase methods (rank below library)
- **Where:** `examples/web-multiplexer/web/store.ts` `resizePane` (~704), `sendKeysToPane` (~745); `examples/web-multiplexer/electron/wrapper-tracker.ts` `size` (~68); **evaluate:** `detach` bridge method (see Adjudication).
- **What:** `resizePane` — zero callers. `sendKeysToPane` — zero callers; the e2e comment claiming it is the keystroke path is **stale and must be fixed**. `WrapperTracker.size` — exported, zero callers.
- **[LAW:carrying-cost]**.
- **Fix:** delete the three dead methods + fix the stale e2e comment; evaluate (not blind-delete) the `detach` method.

---

## P1 — God modules

Library:

### GM1 — `websocket/server.ts` `Connection` fuses nine concerns (~304-1046, 1100 LOC)
State machine, WS ingress, handshake/auth, call-dispatch+timeout race, authorization, rate-limiting, event/byte fan-out+backpressure, heartbeat, observability — all on one class sharing private mutable fields (`inflight`, `rateWindow`, `pongDeadline`, `state`). **[LAW:decomposition]**, **[LAW:single-enforcer]**. **Split:** extract `RateLimiter`, `Heartbeat`, `CallPump` (owns `inflight` + timeout race), `Handshake`; leave `Connection` as the wiring shell.

### GM2 — `websocket/client.ts` `WebSocketTmuxClient` fuses nine concerns (~144-858, 887 LOC)
Socket/reconnect lifecycle, **dual** state machine (→ `wwo.5.1`), RPC proxy, call correlation+timeout, outbox/transmit, frame ingress+dispatch, heartbeat, event emission+topology, error mapping. `finalizeConnection` alone does reconnect-decision + timer teardown + pending rejection + state mapping. **[LAW:decomposition]**, **[LAW:no-mode-explosion]** (7-state enum × N flags). **Split:** mirror GM1 (`Heartbeat`, `Outbox`/`CallPump`, `ReconnectController`); **depends on `wwo.5.1`** collapsing the dual state machine first (removes ~70 LOC / one concern).

### GM3 — `electron/main.ts` `createMainBridge` is a 363-line god-closure (~236-599, 703 LOC)
ipcMain registration guard, `SenderState` lifecycle, event fan-out, per-renderer BytesSink wiring, register/unregister/ack handlers, parse→dispatch→encode pipeline, handler-call drain — all sharing closure state. **[LAW:decomposition]**. **Split:** `SenderRegistry`, `InvokePipeline` as module factories; move `WebContentsSink`/`attachWebContentsSink` (~601-691) to `electron/sink.ts` (mirroring `websocket/sink.ts`; **[LAW:locality-or-seam]**).

### GM4 — `bridge-connection.ts` `createBridgeConnection` fuses two ledgers (~203-490, 490 LOC)
Subscription ownership+refcount (with intricate `inflight`-promise race handling) and per-pane outstanding-byte watermark accounting share only the `peers` map and have zero overlapping invariants. **[LAW:decomposition]**. **Split:** `SubscriptionLedger` + `BackpressureLedger`, composed by a thin façade indexing on the shared `Peer` token.

### GM5 — pane-terminal `xterm-sink/index.ts` is two products in one file (~86-551, 551 LOC)
The file header itself says "Two exports." `XtermSink` (heavyweight `TerminalSink`: ResizeObserver/IntersectionObserver/rAF/font-cache/seed buffering) vs `XtermBytesSink`/`attachXtermSink` (12-line `BytesSink`, no shared code, *different* import roots — the smell is a second import block buried at ~473). **[LAW:decomposition]**, **[LAW:one-way-deps]**. **Split:** move the bytes sink to `xterm-sink/bytes-sink.ts`; further extract `XtermSink`'s first-resize/seed buffer as a `FirstResizeGate` collaborator and visibility tracking as a `VisibilityTracker` (see SD2/SD3).

### GM6 — pane-terminal `stream/pane-stream.ts` leaks a tmux seed-grid algorithm (786 LOC)
~140 lines (`seed()` ~523-661) + pure helpers `parseSeedState`/`mode`/`latin1ToBytes` (~700-786) are a tmux-specific capture-grid reconstruction (flag selection, blank-row padding, DEC private-mode escape synthesis, Latin-1→bytes) — a different change-reason than the lifecycle state machine the file owns. **[LAW:decomposition]**, **[LAW:locality-or-seam]**. **Split:** extract a pure `stream/seed-builder.ts` `buildSeed(captureOutput, stateLine, historyLines)` — unit-testable with no client/async.

Showcase (rank below library):

### GM7 — showcase `web/store.ts` `DemoStore` is six stores in one class (~184-815, 815 LOC)
Snapshot wire-codec, model assembly, connection lifecycle, event routing+fast-path refresh, keymap+confirm-modal, UI actions+getters, event/error ring buffers. **[LAW:decomposition]**. **Split:** `snapshot-codec.ts`, `TmuxModel`, `ConnectionController`, `RefreshPolicy`, `KeymapController`, `LogStore` (the last duplicates InspectorStore — see SD5).

### GM8 — showcase `components/InspectorView.tsx` mixes view + presentation + a duplicate summarizer (~43-575, 576 LOC)
Toolbar/timeline/detail JSX + `presentFor`/`renderPayload`/`badgeColor` policy + a full `summarizeEvent` that is an explicit copy of DebugPanel's `summarize`. **[LAW:decomposition]**. **Split:** extract shared `event-summary.ts` (→ SD5) and `inspector-presentation.ts`; leave the file as pure JSX.

---

## P2 — Scattered concerns / duplicated state

Library:

### SD1 — wire-error→`BridgeError` mapping duplicated ×3-4 (`websocket/client.ts` ~475-523 + `server.ts` ~428)
The "normalize a thrown decode/parse error into `BRIDGE_PROTOCOL_ERROR`" block appears verbatim in `onMessage`/`onBinary`/`onText` and again server-side. **[LAW:single-enforcer]**. **Fix:** one `toBridgeProtocolError(err)` helper (or have the decoders only ever throw `BridgeProtocolError`).

### SD2 — seed / first-resize / write-ordering buffered twice across the seam (`pane-stream.ts` ~136-159/523-661 + `xterm-sink` ~118-128/208-308)
The invariant "seed precedes trailing live bytes" is enforced twice against two different timers (capture-resolution vs first-render-tick); the two files' comments cross-reference each other — the tell of a split owner. **[LAW:one-source-of-truth]**, **[LAW:no-ambient-temporal-coupling]**. **Fix:** retype `TerminalSink.seed` to carry the trailing bytes (or add a `whenReady()` the stream awaits) so one layer owns ordering — ordering becomes one function's argument order, not a two-scheduler handshake.

### SD3 — per-stream seed-cycle state split across three mechanisms (`pane-stream.ts` `pendingSeed`+`seedStaleMidFlight` + `reseed-scheduler.ts` `currentRun`)
"Is a capture in flight, and is a fresh one owed?" lives in two booleans plus the scheduler's implicit await position; on reconnect-mid-sweep three mechanisms decide who recaptures next. **[LAW:one-source-of-truth]**. **Fix:** one discriminated `seedCycle: idle | capturing | capturing-stale` field both `reseed()` and the scheduler branch on.

### SD4 — `electron/main.ts` `SenderState` tracks in-flight invokes in two parallel registries (~142-177 + 536-557)
Per-sender `Set<PendingDispatch>` (carries `aborted`) and a module-level `Set<Promise<…>>` (carries the await target) record the same "an invoke is in flight" with two lifecycles — the code comment concedes it. **[LAW:one-source-of-truth]**. **Fix:** one `InflightDispatch` record `{aborted, promise}` in one per-sender set.

Showcase (rank below library):

### SD5 — showcase event-log triplication: dual ring + dual filter + triplicated summarizer
`DemoStore.events` (cap 200) vs `InspectorStore.entries` (cap 1000) buffer the same wire events twice (**[LAW:one-source-of-truth]**); `UiStore.hiddenEventTypes` vs `InspectorStore.hiddenEventTypes` are two mute-lists that drift (**[LAW:one-source-of-truth]**); `summarizeEvent` (InspectorView) / `summarize` (DebugPanel) / `eventSearchTail` (inspector-store) are three hand-maintained switches over `TmuxMessage` with no exhaustive `never` (**[LAW:single-enforcer]**). **Fix:** one `WireLog` store fed by `onWire`, one filter source, one shared `summarizeEvent(ev, labels)` ending in `assertNever`.

---

## P3 — Type-weakness / special-case / residue

Library:

### TW1 — `ConnectionIdentity = unknown` is not actually parameterized (`websocket/types.ts` ~132)
The identity an app attaches in `authenticate()` arrives at `authorize()`/`createClient()` as `unknown`, forcing casts. The comment promises "type-parameterized so apps can carry their own shape," but no `<Identity>` param exists. **[LAW:types-are-the-program]**. **Fix:** make it a real generic `WebSocketBridgeOptions<Identity>` / `createWebSocketBridge<Identity>` defaulting to `unknown`.

### TW2 — `IPC.event` is an untyped union channel narrowed by runtime control-flow (`electron/renderer.ts` ~130-157; producers `main.ts` ~358/412/656)
One channel carries three payload shapes; the renderer recovers type via `args[0] as EmitterMessage | PaneOutputMessage` then an `isPaneOutput`/`type==="connection-state"`/else ladder, force-casting the `else` to `TmuxMessage` (silent misroute). The producer side is unchecked against the union. **[LAW:types-are-the-program]**, **[LAW:dataflow-not-control-flow]**. **Fix:** type the `event`-channel payload as the explicit union at the structural `*Like` interface seam so both ends are checked and the cast disappears.

### TW3 — `pane-stream.ts` `listenerSet` launders three Sets through `as unknown` (~681-689, cast ~360-364)
`listenerSet<E>` triple-casts each of three named Sets; `on()` does `set.add(handler as never)`. The event-name→correct-set mapping is asserted, not proven; a swapped branch type-checks. **[LAW:types-are-the-program]**. **Fix:** one mapped-type record `{ "state-changed": Set<…>, … }` indexed by event name — no cast.

### TW4 — extended pane-output decode has no encode (`websocket/protocol.ts` ~193/196/239-255)
`decodePaneOutput` parses an "extended" frame variant `encodePaneOutput` can never produce (it hard-writes flag byte `0`). The encode/decode pair is asymmetric: the decoder models a richer protocol than the encoder speaks. **[LAW:one-source-of-truth]**. **Fix:** delete the extended branch + `FLAG_EXTENDED`/`HEADER_EXTENDED` (narrow the return to always `{type:"output"}`), **or** add a symmetric encode path + round-trip test if forward-compat is intended.

Showcase (rank below library):

### TW5 — showcase `appMode` re-narrowed by hand (`App.tsx` ~179-187) + bytes-as-events residue (`electron-bridge.ts` ~135-147 → `pane-stream-bridge.ts` ~104)
`appMode` is recovered via nested ternary that silently coerces unknowns to `"multiplexer"`, duplicating `ui-store.ts`'s validator — **[LAW:types-are-the-program]**; fix with one `parseAppMode(v): AppMode | null`. Separately (I1): the Electron/WS bridges re-wrap dedicated-`BytesSink` pane bytes back into synthetic `{type:"output"}` events so HeatmapStore/InspectorStore can consume them via `onEvent` — reversing the z31.9 sink-channel separation at the showcase seam — **[LAW:dataflow-not-control-flow]**; fix by routing meters/wire-taps off the sink registry. Both P3, showcase, low.

---

## Subsystems with no findings
`src/keymap/**` (table-driven, exhaustive `never` dispatch, single enforcer); `src/protocol/{parser,decode,byte-codec}.ts`; `src/transport/{sockets,types}.ts`; `src/{client,pane-output,topology-router,line-sink,emitter,connection-state,idle-pane-suppressor,errors}.ts` (core data path — `pane-output.ts` at 735 LOC is one cohesive scope-routing concern, **not** a god module); `src/connectors/{rpc,errors,bridge-dispatch,rpc-dispatch,streams/*}.ts`; pane-terminal `font-cache.ts`/`buffering-sink.ts`/`reseed-scheduler.ts`; most showcase components.

---

## Remediation epic map

Epic `tmux-complexity-*` (ranked to top; library above showcase at each tier):

- **BUILD1** (P0) — release-integrity: clean-build + export-completeness guard (M0).
- **Dead-code removal sub-epic** (P0/P3, parallelizable, can land before structural): DC1–DC6.
- **God-module splits** (P1): GM1–GM6 (library), GM7–GM8 (showcase). GM2 depends on `wwo.5.1`.
- **Scattered/duplicated** (P2): SD1–SD4 (library), SD5 (showcase).
- **Type-weakness/residue** (P3): TW1–TW4 (library), TW5 (showcase).

Cross-refs (no new tickets): `wwo.5.1` (dual state machine, S1); `line-sink` bivariance (resolved). 
