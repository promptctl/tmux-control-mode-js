# Audit 1/4 — Doc & plan drift report

**Ticket:** `tmux-audit-zg8`
**Date:** 2026-05-23
**Branch:** `tmux-audit-zg8`
**Scope:** Repo prose (README, AGENTS, CLAUDE, IMPL, KEYMAP, CHANGELOG, PROMPT-ONE-SHOT, examples/SHOWCASE, design-docs/, .planning/) versus canonical source-of-truth (package.json, src/, tsconfig*, workflows, lockfile).
**Out of scope:** SPEC.md / SPEC_MANIFEST.md (audit 2/4), in-code comments + `[LAW:]` markers (audit 3/4), code structure (audit 4/4).

This is a read-only report. No prose edits were made during the audit. Findings feed into the remediation epic `tmux-audit-drift-{slug}` — one child ticket per actionable finding, ranked.

---

## Canonical truth bundle used for cross-check

| Source | What it is the source of |
|---|---|
| `package.json` (root) | name `@promptctl/tmux-control-mode-js`, version `0.1.0`, `type: module`, exports map (12 entries), scripts, devDeps, `engines: node >=20`, no `dependencies` field |
| `package.json` (examples/web-multiplexer) | demo `dev/dev:bridge/dev:web/build/build:electron/demo:electron/typecheck` scripts; deps incl. mantine, mobx, react, ws |
| `package.json` (packages/pane-terminal) | `@promptctl/pane-terminal` 0.1.0 with 5 exports `./stream`, `./sink`, `./xterm-sink`, `./react`, `./vanilla`; peer-deps on xterm/react |
| `pnpm-lock.yaml` | canonical lockfile; `package-lock.json` gitignored — package manager is **pnpm** |
| `tsconfig.json` | project refs: protocol, transport, src, keymap, connectors, packages/pane-terminal (**6**) |
| `src/index.ts` | root public API: TmuxClient, TmuxCommandError, PaneAction, ConnectionState, TmuxEventMap, spawnTmux, tmuxSocketDir, listTmuxSocketNames, isTmuxServerAlive, types |
| `src/protocol/index.ts` | protocol subpath: 27 message types + TmuxMessage union + CommandResponse + PaneAction/emptyKeysResponse + TmuxParser + decodeOctalEscapes + 7 encoder fns |
| `src/keymap/index.ts` | keymap subpath: Action/KeyEvent/Keymap/etc + INITIAL_STATE/handleKey/defaultTmuxKeymap/bindKeymap/dispatchAction |
| `src/client.ts` | `subscribeRaw` and `unsubscribe` both return `Promise<CommandResponse>`. No `subscribe`, `listWindows`, `listPanes`, `splitWindow` methods |
| `src/protocol/decode.ts` | actual filename — there is NO `src/protocol/decoder.ts` |
| `src/connectors/`, `src/keymap/` | exist as real subtrees; `src/model/` and `src/terminal/` do NOT exist |
| `packages/pane-terminal/src/` | stream, sink, xterm-sink, react, vanilla, bench subdirs |
| `examples/web-multiplexer/shared/config.ts` | `WEB_PORT = 44173`, `BRIDGE_PORT = 44174` |
| `examples/web-multiplexer/web/` | actual files: App.tsx, bridge.ts, demo-ipc.ts, electron-bridge.ts, fonts.css, format-bytes.ts, heatmap-store.ts, inspector-store.ts, main-electron.tsx, main.tsx, pane-stream-bridge.ts, store.ts, ui-store.ts, ws-client.ts + components/, fonts/ |
| `tests/` | unit/ (16 test files), integration/ (5), e2e/ (5), fixtures/ (17) — **32 test files total** |
| `.github/workflows/ci.yml` | pnpm + node 20 + tmux apt-get; runs lint/format:check/typecheck/build/test/test:integration + pane-terminal bench:gate (continue-on-error) |
| `.github/workflows/publish.yml` | publishes `@promptctl/tmux-control-mode-js` with `--provenance` on GitHub Release published |
| `justfile` | exposes `just demo` → `npm run demo` → `pnpm --filter ... run dev` |

Rank tiers, per ticket spec:
- **P0** — broken contract: following the doc breaks code/build/install/import/link.
- **P1** — wrong: claim contradicts current source.
- **P2** — stale: claim was true once, source moved.
- **P3** — drift-prone-by-construction: claim is currently accurate but structurally fragile.

Across the audit, prefer structural fixes that **delegate to canonical source** over per-claim corrections (same shape as PR #39's `see package.json exports` pattern). Where a structural fix is available, that is noted in the finding.

---

## P0 — Broken contracts

### P0-1 — PROMPT-ONE-SHOT.md is for a different project entirely
- **File:** `PROMPT-ONE-SHOT.md:1-110` (whole file)
- **Claim:** Describes "prompt-eval project" — a React + OpenAI + Mantine + GitHub Pages app. Lists files `src/App.tsx`, `src/openai.ts`, `src/components/PromptPanel.tsx`, `src/components/MarkdownOutput.tsx`, calls SDK `OpenAI` with `dangerouslyAllowBrowser`, refers to `npm run build` to "deploy to GitHub Pages."
- **Reality:** None of those files exist in this repo. This is a Node.js library for tmux control mode protocol — zero browser/OpenAI/GitHub-Pages content. The entire file is a copy-paste from an unrelated project that was never adapted.
- **Suggested fix:** Delete the file, OR replace its body with the actual one-shot worker prompt for tmux-control-mode-js (mirror current `/next` skill semantics: pull from `lit ready`, work on tmux-control-mode-js, use `pnpm` not `npm`, `lit done` to close).
- **Structural opportunity:** None; this is a hand-curated artifact. Decide first whether a one-shot worker prompt belongs in the repo at all (the `/next` skill in `~/.claude/skills/next` already serves this role).

### P0-2 — KEYMAP.md imports use the wrong package name (unscoped)
- **File:** `KEYMAP.md:7-13, 217-218, 385, 399, 420-421, 442, 521, 588`
- **Claim:** All example imports use bare name, e.g. `import { … } from "tmux-control-mode-js/keymap"` and `import { spawnTmux, TmuxClient } from "tmux-control-mode-js"`.
- **Reality:** Published package name is `@promptctl/tmux-control-mode-js` (per `package.json:2` and verified by the v0.1.0 publish smoke test). Following any of these examples produces `ERR_MODULE_NOT_FOUND` at install or import time.
- **Suggested fix:** Global search-and-replace `"tmux-control-mode-js"` → `"@promptctl/tmux-control-mode-js"` across KEYMAP.md.
- **Structural opportunity:** Sole canonical source for the package name is `package.json:2`. KEYMAP.md (and any doc) restating it is `one-source-of-truth` drift. A small build-time check (script that greps docs for the unscoped name and fails) would prevent regression — track as a separate follow-up if appetite exists.

### P0-3 — CHANGELOG.md compare/tag URLs point to wrong GitHub org
- **File:** `CHANGELOG.md:42-43`
- **Claim:** `[Unreleased]: https://github.com/brandon-fryslie/tmux-control-mode-js/compare/v0.1.0...HEAD` and `[0.1.0]: https://github.com/brandon-fryslie/tmux-control-mode-js/releases/tag/v0.1.0`
- **Reality:** `package.json:5-8` declares the canonical repo URL `git+https://github.com/promptctl/tmux-control-mode-js.git`. The `brandon-fryslie` org URLs 404 (this is the pattern PR #39 fixed elsewhere; CHANGELOG was missed).
- **Suggested fix:** Replace `brandon-fryslie` → `promptctl` in both URLs.
- **Structural opportunity:** Same `one-source-of-truth` shape as `./terminal` in IMPL.md — restating the repo URL in prose. The compare-tag link template *must* be a URL (not a back-reference to package.json), so structural delegation isn't available; keep the link but make sure the next changelog entry uses the right org by convention.

### P0-4 — IMPL.md §3 import example uses a name that does not exist
- **File:** `IMPL.md:99-101`
- **Claim:** `import { TmuxParser, decode } from "@promptctl/tmux-control-mode-js/protocol";`
- **Reality:** `src/protocol/index.ts:45` exports `decodeOctalEscapes`, not `decode`. Following this snippet yields "no exported member 'decode'" at compile time and `undefined` at runtime.
- **Suggested fix:** Change `decode` → `decodeOctalEscapes`. (Optionally: remove the example since IMPL.md is a design doc, not consumer docs — KEYMAP/README cover consumer-facing imports.)

### P0-5 — IMPL.md §5 declares TmuxClient methods that do not exist
- **File:** `IMPL.md:261-263`
- **Claim:** `listWindows(): Promise<CommandResponse>; listPanes(): Promise<CommandResponse>; splitWindow(options?: SplitOptions): Promise<CommandResponse>;`
- **Reality:** None of `listWindows`, `listPanes`, `splitWindow` exist on `TmuxClient` (`grep -nE 'splitWindow|listWindows|listPanes' src/client.ts` returns nothing). The library uses `execute("list-windows")`, etc. `SplitOptions` is exported from `src/index.ts:5` but no method consumes it.
- **Suggested fix:** Replace the convenience-method block with the actual public surface (`execute`, `sendKeys`, `setSize`, `setPaneAction`, `subscribeRaw`, `unsubscribe`, `setFlags`, `clearFlags`, `requestReport`, `queryClipboard`, `detach`, `close`), OR delete those lines and link to the source. Note: `SplitOptions` is exported but unused — either route it through a real `splitWindow` method or remove the export; that decision belongs to audit 4/4 (dead-export check).
- **Structural opportunity:** The Rejection contract paragraph immediately below already enumerates the methods correctly. The two lists in the same section should agree by construction — pick one and have the other point to it.

### P0-6 — STACK.md says "Package manager: npm" — repo migrated to pnpm
- **File:** `.planning/codebase/STACK.md:18-21`
- **Claim:** "Package Manager: npm (lockfile: `package-lock.json` present)"
- **Reality:** `pnpm-lock.yaml` is canonical (commit 4d380df migrated to pnpm; `package-lock.json` is gitignored, see `.gitignore:9`). CLAUDE.md and CI both use `pnpm`. An onboarding contributor who follows STACK.md will create `package-lock.json` drift and run the wrong commands.
- **Suggested fix:** Replace npm → pnpm throughout STACK.md, point lockfile entry at `pnpm-lock.yaml`, fix all `npm test` / `npm run …` commands (lines 97, 102-105, 116, 211 of STACK.md).
- **Structural opportunity:** None for the package-manager statement (it must live in prose), but the command list in STACK.md duplicates `package.json:scripts` — replace the enumeration with a "see `package.json` scripts" delegation.

### P0-7 — STRUCTURE.md cites file `decoder.ts` which does not exist
- **File:** `.planning/codebase/STRUCTURE.md:18, 80, 127`
- **Claim:** "`decoder.ts` — Octal escape decoder (Uint8Array)" listed in tree at line 18, prose at line 80, "Core Logic" at line 127.
- **Reality:** File is `src/protocol/decode.ts` (singular). `grep -l decoder src/` returns nothing under `src/protocol/`. CONCERNS.md correctly uses `decode.ts:46-56` (line 67); STRUCTURE.md is alone in saying `decoder.ts`.
- **Suggested fix:** Rename every `decoder.ts` reference in STRUCTURE.md to `decode.ts`.
- **Cross-cuts:** Also fix PROJECT.md (see P1-9) which has the same typo.

---

## P1 — Wrong (claim contradicts source)

### P1-1 — IMPL.md §2 lists `model/` as an existing subtree
- **File:** `IMPL.md:55-57`
- **Claim:** `(additional subtrees — keymap/, connectors/, model/ — exist in the repo but are not enumerated here; …)`
- **Reality:** `src/keymap/` and `src/connectors/` exist; `src/model/` **does not** (`ls src/model` errors). The hedge is honest about not enumerating, but the named list is incorrect.
- **Suggested fix:** Drop `model/`. Two options: (a) list the actually-existing subtrees `keymap/`, `connectors/`, `transport/`, OR (b) delete the entire `(additional subtrees …)` parenthetical, since the next sentence "see the source for the current layout" already does the structural delegation.
- **Structural opportunity:** Option (b) is the `one-source-of-truth` fix — prose stops enumerating directory names that the filesystem already enumerates.

### P1-2 — IMPL.md §9 PaneManager / TerminalEmulator are wholesale fiction
- **File:** `IMPL.md:594-786` (entire Section 9)
- **Claim:** Detailed prose about a `PaneManager` class with `getTerminal`, `attach`, `detach`, `start`, `stop`, and a `TerminalEmulator` interface that xterm.js satisfies out of the box. Example code shows `paneManager.getActiveTerminal()` from the renderer.
- **Reality:** Neither class nor interface exists. `grep -rnE 'PaneManager|TerminalEmulator' src/ packages/` returns zero hits. The xterm.js integration is now `@promptctl/pane-terminal` (a separate workspace package) with a different shape: `PaneStream`, `TerminalSink`, `XtermSink`, `<PaneTerminal>` React component. The design-docs/pane-session-v2.md captures the actual design.
- **Suggested fix:** Replace Section 9 with a 5-10 line summary that points at `packages/pane-terminal/` and `design-docs/pane-session-v2.md`. Treat the historical `PaneManager` design as superseded; do not preserve it as "future state" because that's how the next reader gets confused again.
- **Structural opportunity:** Section 9 is now duplicated truth — the real design lives in `design-docs/pane-session-v2.md` and the real API in `packages/pane-terminal/src/`. Prose in IMPL.md should delegate to those, not re-tell the story.

### P1-3 — IMPL.md §6 says "the relay server is intentionally NOT part of this package"
- **File:** `IMPL.md:336-341`
- **Claim:** "The relay server is intentionally **not** part of this package. It's a simple bridge … A reference implementation or example could live in an `examples/` directory."
- **Reality:** The relay server **is** part of the package. `package.json:42-44` exports `./websocket/server` which resolves to `dist/connectors/websocket/server.js`. `src/connectors/websocket/server.js:createWebSocketBridge` is the relay. Verified by v0.1.0 publish smoke test.
- **Suggested fix:** Replace with a short description of `createWebSocketBridge` (one paragraph), pointing at `src/connectors/websocket/server.ts` and `./websocket/server` export. The "could live in examples/" sentence is the obsolete bit — the relay was promoted into the library.

### P1-4 — IMPL.md §10.1 example tree omits / misnames demo files
- **File:** `IMPL.md:800-821`
- **Claim:** Lists `web/main.tsx, main-electron.tsx, App.tsx, store.ts, pane-terminal.ts, ws-client.ts, electron-bridge.ts, components/` and `server/bridge.ts`, `electron/main.ts, preload.ts, build.mjs`, plus a top-level `shared/`.
- **Reality (per `ls examples/web-multiplexer/web/`):** there is no `pane-terminal.ts`; actual extras are `bridge.ts`, `demo-ipc.ts`, `heatmap-store.ts`, `inspector-store.ts`, `pane-stream-bridge.ts`, `ui-store.ts`, `fonts.css`, `format-bytes.ts`. `electron/` does not have a `preload.ts` (verify via `ls examples/web-multiplexer/electron`). The top-level also has `tests/`, `index.html`, `dist/`, `dist-electron/`, `vite.config.ts`.
- **Suggested fix:** Either (a) regenerate the tree from `ls`, OR (b) replace the file-by-file tree with one sentence — "See `examples/web-multiplexer/` for the actual layout." This is the structural fix: enumeration of a directory in prose is a self-replicating drift source.
- **Structural opportunity:** Option (b). The filesystem is the source of truth; trees in prose are copies that always drift.

### P1-5 — README.md uses `npm` commands; repo is pnpm-only
- **File:** `README.md:43-47, 63-66`
- **Claim:** Testing block uses `npm test`, `npm run test:integration`, `npm run test:all`. Setup says `npm install`. The Demo block says "`npm install   # once at the repo root`".
- **Reality:** Repo is pnpm — `pnpm-lock.yaml` is canonical, `package-lock.json` is gitignored, CLAUDE.md mandates pnpm, CI uses pnpm. Running `npm install` may resolve packages differently from the lockfile contract and won't honor `pnpm.onlyBuiltDependencies` (root `package.json:97-99`).
- **Suggested fix:** Swap `npm` → `pnpm` (or `pnpm run`) throughout the README's developer-facing blocks. **Keep** `npm install @promptctl/tmux-control-mode-js` in the **consumer install** block (line 8) — consumers use their own package manager; that line is pm-agnostic and correct.
- **Note:** `just demo` (README:65) is valid — `justfile:demo` runs `npm run demo` which in turn invokes the package's `pnpm --filter …` script. It works but routes through two PMs; consider replacing `just demo` body with `pnpm run demo` for one-PM hygiene (small follow-up).

### P1-6 — INTEGRATIONS.md describes subscribe/unsubscribe as fire-and-forget
- **File:** `.planning/codebase/INTEGRATIONS.md:94-98`
- **Claim:** "Fire-and-forget subscriptions (no state tracking) — `client.subscribe(name, what, format)` → sends `%refresh-client-subscribe` command; `client.unsubscribe(name)` → sends `%refresh-client-unsubscribe` command"
- **Reality:** Method is `subscribeRaw` (not `subscribe`); both `subscribeRaw` and `unsubscribe` return `Promise<CommandResponse>` (`src/client.ts:222, 230`). The wire command names shown have a leading `%` (`%refresh-client-subscribe`) which is the *notification* prefix in the protocol, not a command name — actual encoder emits `refresh-client -B '<name>':'<what>':'<format>'`. REQUIREMENTS.md SUB-01/02 confirm the awaitable shape.
- **Suggested fix:** Rewrite the bullet to: "Subscriptions are awaitable. `client.subscribeRaw(name, what, format): Promise<CommandResponse>` sends `refresh-client -B '<name>':'<what>':'<format>'` and resolves with the response. `client.unsubscribe(name): Promise<CommandResponse>` mirrors. `%subscription-changed` events arrive independently."
- **Structural opportunity:** INTEGRATIONS.md is duplicating the typed signatures in `src/client.ts` and the wire format in `src/protocol/encoder.ts`. Better: link to those rather than restate.

### P1-7 — TESTING.md error-handling pattern uses obsolete rejection shape
- **File:** `.planning/codebase/TESTING.md:209-218, 220-231`
- **Claim:** Example test catches command rejection as a raw `CommandResponse` object: `.then((r) => r, (r: CommandResponse) => r)` and inspects `r.success`.
- **Reality:** `src/errors.ts:TmuxCommandError` is now the rejection type. Per IMPL.md §5:296-302 (which is correct), callers must `instanceof TmuxCommandError` and read `.response`. The pre-0.2 raw-CommandResponse rejection is explicitly called out as a breaking change in IMPL.md:304-306. TESTING.md still shows the deprecated pattern, so any reader copying from it produces tests that catch the wrong type.
- **Suggested fix:** Update the example to `.catch((e) => e instanceof TmuxCommandError ? e.response : (() => { throw e })())` (or use try/catch). Or strip the rejection-as-value pattern entirely and link to IMPL.md §5.

### P1-8 — CONCERNS.md "No Handler Unsubscription Mechanism" claims subscribe/unsubscribe are fire-and-forget
- **File:** `.planning/codebase/CONCERNS.md:44-51`
- **Claim:** "The `subscribe()` and `unsubscribe()` methods in `TmuxClient` are fire-and-forget with no confirmation. … `unsubscribe()` sends a command but does not wait for or verify the response."
- **Reality:** Resolved. `subscribeRaw` and `unsubscribe` both return `Promise<CommandResponse>` (`src/client.ts:222, 230`). REQUIREMENTS.md SUB-01/02 mark this resolved; this concern entry should be moved to a "Resolved" section (matching the pattern of the "Missing Terminal Export — RESOLVED" entry at the top of the same file).
- **Suggested fix:** Move under a "Resolved" header with the same date-tagged format used for the terminal export.

### P1-9 — PROJECT.md cites `src/protocol/decoder.ts` (file does not exist)
- **File:** `.planning/PROJECT.md:19`
- **Claim:** "✓ Octal escape decoder for `%output` data (`src/protocol/decoder.ts`) — existing"
- **Reality:** File is `src/protocol/decode.ts`.
- **Suggested fix:** Same as P0-7 — single-character fix.

### P1-10 — STRUCTURE.md tree omits keymap/, connectors/, connection-state, errors, etc.
- **File:** `.planning/codebase/STRUCTURE.md:8-63`
- **Claim:** ASCII tree shows `src/` with only `index.ts`, `client.ts`, `emitter.ts`, `protocol/`, `transport/`.
- **Reality:** `src/` also contains `keymap/`, `connectors/`, `connection-state.ts`, `errors.ts`. Six TS project references, not three. The `dist/` block listed is similarly partial.
- **Suggested fix:** Either (a) regenerate from `ls -R src/`, OR (b) replace the tree with the briefest possible structural delegation: "See `tsconfig.json` for project references and `src/index.ts` for the curated public surface."
- **Structural opportunity:** Option (b). Trees enumerating files always drift; tsconfig references list `protocol`, `transport`, `src`, `keymap`, `connectors`, `packages/pane-terminal` and stays authoritative by the build.

### P1-11 — STACK.md says project references are protocol, transport, src (only 3)
- **File:** `.planning/codebase/STACK.md:56-60`
- **Claim:** "Project references in root tsconfig.json: src/protocol, src/transport, src"
- **Reality:** `tsconfig.json:2-9` declares 6 references: protocol, transport, src, keymap, connectors, packages/pane-terminal.
- **Suggested fix:** Either enumerate all six OR replace with "see `tsconfig.json` for the full reference list." Prefer the delegation.

### P1-12 — CLAUDE.md build command comment omits half the project references
- **File:** `CLAUDE.md:12`
- **Claim:** `pnpm run build        # tsc --build across protocol, transport, src`
- **Reality:** Build covers six references (protocol, transport, src, keymap, connectors, packages/pane-terminal). The comment is structurally drift-prone — every time a project ref is added, this comment is silently wrong.
- **Suggested fix:** Replace the trailing comment with `# tsc --build — see tsconfig.json for refs`, OR drop the comment entirely (the command name is self-descriptive).

### P1-13 — CLAUDE.md `pnpm run lint` says "eslint src/"
- **File:** `CLAUDE.md:34`
- **Claim:** `pnpm run lint           # eslint src/`
- **Reality:** `package.json:88` runs `eslint src/ packages/pane-terminal/src/` — two paths, not one. Same drift pattern as P1-12.
- **Suggested fix:** Drop the comment, OR delegate ("# see package.json scripts").

### P1-14 — CLAUDE.md "Three layers" overview understates structure
- **File:** `CLAUDE.md:49`
- **Claim:** "Three layers, built as TS project references and shipped as subpath exports …"
- **Reality:** Six project references (protocol, transport, src, keymap, connectors, packages/pane-terminal) shipped across 12 subpath exports. The "three layers" framing was true at v0; current is six packages worth of code.
- **Suggested fix:** Soften to "Layered architecture, built as TS project references and shipped as subpath exports — `tsconfig.json` lists the references; the `exports` map in `package.json` is the source of truth for what ships." Keep the protocol/transport/client bullet description that follows — those *are* the canonical three layers conceptually, they just no longer match the full ref count.

### P1-15 — REQUIREMENTS.md DEMO-10 cites wrong port and wrong package manager
- **File:** `.planning/REQUIREMENTS.md:103-104`
- **Claim:** "`npm run demo` from repo root runs `npm --prefix examples/web-multiplexer run dev` … Open http://localhost:5173 in a browser. `npm run demo:install` is provided as a one-time install helper."
- **Reality:** Script is `pnpm --filter tmux-control-mode-js-demo-web-multiplexer run dev` (`package.json:87`). Port is **44173** (`examples/web-multiplexer/shared/config.ts:WEB_PORT`). README correctly cites 44173. There is no `demo:install` script anymore.
- **Suggested fix:** Update to pnpm + filter syntax + port 44173 and drop the `demo:install` reference. REQUIREMENTS.md is a frozen-in-time artifact, but this is a specific factual error worth fixing because it appears in audit context.

### P1-16 — IMPL.md §11.3 integration test list does not match `tests/integration/`
- **File:** `IMPL.md:886-897`
- **Claim:** Lists 11 test files: `connection.test.ts`, `output-rendering.test.ts`, `input.test.ts`, `pane-lifecycle.test.ts`, `window-lifecycle.test.ts`, `resize.test.ts`, `layout.test.ts`, `session.test.ts`, `backpressure.test.ts`, `initial-sync.test.ts`, `escape-sequences.test.ts`.
- **Reality:** `tests/integration/` actually contains: `client.test.ts`, `connection-state.test.ts`, `keymap.test.ts`, `pane-stream.test.ts`, `websocket-bridge.test.ts`. The Playwright/Electron e2e suite lives in `tests/e2e/` with 2 spec files.
- **Suggested fix:** Replace the example test list with one paragraph: "See `tests/integration/` (real-tmux suite, gated by `TMUX_INTEGRATION=1`) and `tests/e2e/` (Playwright + Electron)." The exhaustive list will always drift.

### P1-17 — IMPL.md §11.4 testing-pyramid counts are speculative and stale
- **File:** `IMPL.md:948-960`
- **Claim:** "(10-15 tests, slow, full stack)" Playwright; "(20-30 tests, medium speed)" integration; "(100+ tests, fast, pure)" unit.
- **Reality:** Current totals (per `pnpm run test:all`): 451 tests across 22 files. Unit-only is the bulk. The pyramid shape is correct in spirit; the numbers were design-time estimates that were never updated.
- **Suggested fix:** Either drop the numeric annotations (keep the pyramid concept) or replace with "see CI test counts." Numeric drift is structural — pick the form that doesn't lie.

---

## P2 — Stale (was true once, source moved)

### P2-1 — README.md `just demo` valid but routes through `npm`
- **File:** `README.md:65`, `justfile:demo`
- **Claim:** "`just demo     # starts bridge + Vite dev server`"
- **Reality:** `justfile:demo` body is `npm run demo`. Works (it ultimately invokes `pnpm --filter …` per package.json), but routes through npm in the middle for no reason. Not broken, just architecturally inconsistent with pnpm-only stance.
- **Suggested fix:** Change `justfile:demo` body to `pnpm run demo`. README itself is fine.

### P2-2 — STATE.md says Integration Test Pass shipped "(19/19 against real tmux 3.6a)"
- **File:** `.planning/STATE.md:23`
- **Claim:** "Phase 4 | Integration Test Pass | ✓ Shipped (19/19 against real tmux 3.6a)"
- **Reality:** Number was accurate at end of Phase 4; current `pnpm run test:all` runs 451 tests across all suites, with 5 integration test files. Counts always drift.
- **Suggested fix:** Drop the count: "Phase 4 | Integration Test Pass | ✓ Shipped" — the rest of the phase rollup is structural, not numeric.

### P2-3 — ROADMAP.md uses `npm` throughout
- **File:** `.planning/ROADMAP.md:31-32, 34, 91-95, 127-128, 138, 170`
- **Claim:** `npm run test`, `npm run build`, `TMUX_INTEGRATION=1 npm test`, `npm pack`, `npm install tmux-control-mode-js`, `npm run demo`.
- **Reality:** Repo is pnpm; package name is `@promptctl/tmux-control-mode-js`. ROADMAP.md is a frozen-in-time artifact ("Roadmap created: 2026-04-05") so the verb-tense is also off (most phases marked "Pending" in the doc are actually shipped, per STATE.md).
- **Suggested fix:** Two options — (a) full update of commands + status, OR (b) add a single banner at the top: "**Historical** — this roadmap is preserved as-of 2026-04-05. Current state lives in `.planning/STATE.md` and `lit ls`. Commands shown here use pre-pnpm-migration `npm`." Option (b) is the structural fix: stop pretending the doc is live.

### P2-4 — TESTING.md uses `npm test` etc.
- **File:** `.planning/codebase/TESTING.md:17-21, 105, 211`
- **Claim:** `npm test`, `npm run test:watch`, `npm test`.
- **Reality:** pnpm.
- **Suggested fix:** s/npm/pnpm/ in commands. Same banner approach if marked historical.

### P2-5 — STRUCTURE.md test counts and fixture counts
- **File:** `.planning/codebase/STRUCTURE.md:38, 96, 132-135, 215-219`
- **Claim:** "(15 total)" fixtures (line 38), "17 protocol replay files" (line 96), test files list at 132-135 shows 4 (parser, decoder, encoder, client), and "16+ more" fixtures at line 44.
- **Reality:** 17 fixtures (`ls tests/fixtures/ | wc -l = 17`); 32 test files (`find tests -name '*.test.ts' | wc -l`); the listed 4-test inventory is missing keymap/, connection-state, transport, streams, websocket-*, bridge-connection, etc.
- **Suggested fix:** Drop the counts (drift-prone) and the file list; replace with "See `tests/`." Same structural delegation as P1-10.

### P2-6 — STRUCTURE.md "RUN_INTEGRATION" environment variable name is wrong
- **File:** `.planning/codebase/STRUCTURE.md:191`
- **Claim:** "Full integration: Add to `tests/integration/client.test.ts` (gated by `RUN_INTEGRATION`)"
- **Reality:** The env var is `TMUX_INTEGRATION` (per README, CLAUDE.md, CI, `package.json:test:integration`). `RUN_INTEGRATION` is mentioned nowhere in the codebase.
- **Suggested fix:** Rename to `TMUX_INTEGRATION`.

### P2-7 — STACK.md `prepublishOnly` description is wrong
- **File:** `.planning/codebase/STACK.md:97`
- **Claim:** "Pre-publish: `npm run build` executed automatically before publishing"
- **Reality:** `package.json:95` runs `pnpm run check:deps && pnpm run build` — the deps-guard is the load-bearing part (catches runtime dep leaks) and is missing from this description.
- **Suggested fix:** Update to mention `check:deps`, OR delegate ("see `prepublishOnly` in package.json scripts").

### P2-8 — INTEGRATIONS.md wire command names have a stray `%` prefix
- **File:** `.planning/codebase/INTEGRATIONS.md:96-97`
- **Claim:** Mentions `%refresh-client-subscribe` and `%refresh-client-unsubscribe`.
- **Reality:** `%` is the *notification* prefix in the protocol. Commands sent client→server are bare names (e.g. `refresh-client -B …`). This is a small but consistent error — a reader who learns the protocol from this doc will build malformed commands.
- **Suggested fix:** Drop the `%` (and ideally rewrite to show the actual wire-form, since `-B` is what's sent, not "subscribe").

### P2-9 — examples/SHOWCASE.md lists already-implemented demos as "new ideas"
- **File:** `examples/SHOWCASE.md:44, 45`
- **Claim:** Under "New ideas → Observability / introspection": "**Live 'tmux protocol inspector'**…" and "**Pane activity heatmap**…" listed as ideas to build.
- **Reality:** Both are shipped in `examples/web-multiplexer/` per README.md:90-98 and CHANGELOG.md:32-34 (the "three modes: multiplexer, protocol inspector, activity heatmap"). They're real, working demos, not ideas.
- **Suggested fix:** Move both bullets under a new "Already on the table" sub-section, or strike them from "New ideas." The doc's purpose (idea pool for future demos) survives the move.

### P2-10 — CHANGELOG.md "Subpath exports" sentence is incomplete and unscoped
- **File:** `CHANGELOG.md:30-31`
- **Claim:** "Subpath exports: `tmux-control-mode-js/protocol` for consumers that manage their own transport."
- **Reality:** Package is `@promptctl/tmux-control-mode-js` (unscoped name is the same P0-2 issue) and there are 12 subpath exports, not one (`.`, `./protocol`, `./keymap`, `./electron/main`, `./electron/renderer`, `./websocket`, `./websocket/server`, `./websocket/client`, `./websocket/protocol`, `./websocket/transport`, `./streams/web`, `./streams/node`).
- **Suggested fix:** Replace with "Subpath exports: `./protocol`, `./keymap`, `./electron/{main,renderer}`, `./websocket/{server,client,protocol,transport}`, `./streams/{web,node}` (see `package.json` exports map)." For future entries, prefer the structural-delegation form.

### P2-11 — ARCHITECTURE.md cites stale line numbers
- **File:** `.planning/codebase/ARCHITECTURE.md:91, 120, 175`
- **Claim:** `Location: src/protocol/types.ts (lines 230–258)`, `src/client.ts (lines 56–57, correlation state; lines 165–202, transitions)`, "guard against empty pending queue with `if (entry !== undefined)`" (no current line ref).
- **Reality:** Line numbers drift instantly with any edit. ARCHITECTURE.md was written 2026-04-05; client.ts has been edited extensively since then. Spot-check: `src/client.ts` is now 15079 bytes (much larger than original); the original line ranges no longer apply.
- **Suggested fix:** Drop line ranges, keep file references. This pattern is forbidden by CLAUDE.md (`comments-explain-why-only`: "References to particular lines"); the same constraint should apply to docs about code.
- **Structural opportunity:** All line-number citations in `.planning/codebase/` should be stripped (`grep -nE 'lines? [0-9]+' .planning/codebase/`).

### P2-12 — CONCERNS.md cites stale line numbers throughout
- **File:** `.planning/codebase/CONCERNS.md:17, 30, 38, 47, 56, 65, 74, 84, 88, 100, 105, 114, 119, 130`
- **Claim:** Every concern entry cites `lines NN-NN` of source files.
- **Reality:** Source files have moved since 2026-04-05; the citations are unlikely to land on the claimed code now.
- **Suggested fix:** Strip line numbers, keep file references. Same structural fix as P2-11.

### P2-13 — STACK.md project-reference list omits keymap, connectors, pane-terminal
- **File:** `.planning/codebase/STACK.md:56-60`
- See P1-11 — same drift, classified P1 because it directly contradicts source. This entry is a placeholder cross-reference.

### P2-14 — PROJECT.md "Active" requirements list is fully resolved
- **File:** `.planning/PROJECT.md:25-40`
- **Claim:** Eight requirements listed under "### Active" as `[ ]` unchecked.
- **Reality:** Per STATE.md and REQUIREMENTS.md, every one of those items shipped in Phases 1-5. PROJECT.md was last updated 2026-04-05.
- **Suggested fix:** Either mark them shipped + dated (matching the REQUIREMENTS.md `[x]` convention) OR add the same "historical artifact, see STATE.md" banner as P2-3.

---

## P3 — Drift-prone-by-construction (currently accurate but structurally fragile)

### P3-1 — README.md compatibility table enumerates tmux version requirements per feature
- **File:** `README.md:18-39`
- **Shape:** Prose enumerates each feature with the tmux version it requires (3.2 for subscriptions / flow control / `%client-detached`, 3.4+ for `%config-error`, 3.5+ for `requestReport`). Verbatim release-notes quotes are embedded.
- **Why drift-prone:** Version numbers live in three places — README, CHANGELOG, IMPL — and there's no canonical machine-readable source. When tmux moves the floor, every prose copy must be updated; one will be missed.
- **Suggested fix:** Establish one source — either an inline table in SPEC.md (audit 2/4 may already do this) or a TS constant `MIN_TMUX_VERSION` in source — and have other docs link/quote it. Until then, this audit accepts the current state as accurate.

### P3-2 — README.md "three views" description duplicates demo UI structure
- **File:** `README.md:86-98`
- **Shape:** Prose enumerates "Multiplexer / Protocol Inspector / Activity Heatmap" with one paragraph each.
- **Why drift-prone:** When a fourth tab lands (per `design-docs/console-tab.md`, the Console tab is in flight as `tmux-showcase-bhx.25`), this list will be partial. Plus the descriptions duplicate what `examples/web-multiplexer/web/App.tsx` already encodes.
- **Suggested fix:** Either link to the demo's README (none today; could add one), or accept the duplication and add a maintenance note. Probably fine for now — README user-facing prose can be more verbose than the source.

### P3-3 — Comments in CLAUDE.md restate script bodies
- **File:** `CLAUDE.md:12-15, 21-26, 32-39`
- **Shape:** Each `pnpm run X` line has a trailing comment restating what the script does.
- **Why drift-prone:** Same shape as a WHAT-comment in code (forbidden by `comments-explain-why-only` per CLAUDE.md itself). When `package.json:scripts` changes, the comment is silently stale.
- **Suggested fix:** Drop the trailing-comment per-line bodies; keep one prose sentence at the top of each block explaining *why* (e.g., "agents must run `test:all` because…"). The script names themselves carry the *what*. Saves about 12 lines and removes 12 drift sources.

### P3-4 — IMPL.md §3.1 lists `// ... all 28 message types` in a code block
- **File:** `IMPL.md:133`
- **Shape:** Code snippet truncates the discriminated union with a count comment ("all 28 message types").
- **Why drift-prone:** The number 28 is asserted in three places (README/CHANGELOG/IMPL/CONCERNS/INTEGRATIONS) — if a notification is added the count drifts in N-1 places. Need to verify the count is even correct today (PROTOCOL audit 2/4 may catch it).
- **Suggested fix:** Drop the count in the inline comment; use "// …remaining variants in src/protocol/types.ts" or similar count-free phrasing.

### P3-5 — Multiple .planning/ documents enumerate file paths in `src/`
- **Files:** `.planning/codebase/{ARCHITECTURE,STRUCTURE,CONVENTIONS,INTEGRATIONS,TESTING}.md`
- **Shape:** Each enumerates the subset of `src/` it cares about. Each was written 2026-04-05 and has not been refreshed since.
- **Why drift-prone:** Every new file in `src/` requires N coordinated edits across N planning docs. None has happened.
- **Suggested fix:** Add a single header banner at the top of each `.planning/codebase/*.md` declaring "Historical snapshot — last regenerated 2026-04-05. Treat as design rationale, not current state. Authoritative: `src/`, `tests/`, `package.json`, `tsconfig.json`." Combined with the per-finding fixes above, this prevents future readers from treating these as live docs.

### P3-6 — PROMPT-ONE-SHOT.md (if retained) will need to enumerate "key files"
- **File:** `PROMPT-ONE-SHOT.md` (post-rewrite, if kept)
- **Shape:** The original (wrong-project) version listed six "key files to read." Any rewrite for tmux-control-mode-js would be tempted to do the same and drift again.
- **Suggested fix (deferred to P0-1's fix):** Whatever replaces PROMPT-ONE-SHOT.md, it should NOT enumerate filenames — either point at `src/index.ts` (single curated public surface) and `CLAUDE.md` (project guidance), or skip the orientation block entirely.

---

## Cosmetic / typo bucket (single batched ticket)

These are not worth individual tickets but should be captured in one cleanup ticket per the audit ticket's rules:

- **README.md:65** — `npm install   # once at the repo root — workspaces install demo deps too,\n              # still zero runtime deps on this library's package.json` — wrapped comment is hard to read; consider a single line.
- **README.md:97-98** — "Filter by direction, message type, or substring; click any row to see decoded payload and jump to its response." — verify "jump to its response" link is wired in demo (low-impact, audit 4/4 may catch).
- **IMPL.md:65** — `tests/ ├── unit/ ├── integration/ └── e2e/` accurate, but the tree style is inconsistent with the rest of the file's `│ │` form.
- **AGENTS.md:1-11** — file is a single one-line stanza. Fine, but the surrounding `<!-- BEGIN/END LINKS INTEGRATION -->` HTML comments imply tooling-generated content that may not exist anymore (`lit` integrates here?). Verify whether the marker comments still serve a purpose, drop if not.
- **CHANGELOG.md:13** — "Implements the tmux control mode protocol as documented in `SPEC.md`, targeting tmux 3.2 or later." — fine. "Initial public release." — fine.
- **CHANGELOG.md:30** — see P2-10; included here as a cosmetic also (unscoped name in addition to incomplete export list).

---

## Cross-audit notes (for sibling audit owners)

- **For audit 2/4 (specs):** This audit found that README, CHANGELOG, and IMPL all assert the number `28` message types. Verify against `src/protocol/types.ts` and SPEC.md §23 — if the number disagrees, P3-4 above becomes a P1.
- **For audit 3/4 (comments + [LAW:] markers):** CLAUDE.md (and probably IMPL.md) tag prose with `[LAW:]` markers (e.g. `[LAW:one-source-of-truth] dist/ should contain ONLY shippable output`). These prose-level markers are not in source, but if any in-code `[LAW:]` marker repeats a claim from a prose doc, the prose copy is the drift source — flag it back here.
- **For audit 4/4 (code structure):** `SplitOptions` is exported from `src/index.ts:5` but no method takes it (P0-5 above) — likely a dead-export candidate.
- **For audit 4/4 (dead-export check):** All 12 entries in the exports map were verified to import + type-resolve from a throwaway-dir install during `tmux-release-nhn` audit (PR #39 + close note). The dead-export check should re-run on the next clean build; nothing is dead today.

---

## Tally

- **P0 broken contract:** 7
- **P1 wrong:** 17
- **P2 stale:** 14
- **P3 drift-prone:** 6
- **Cosmetic bucket:** 1 batched ticket covering ~5 small items
- **Total actionable tickets in remediation epic:** ~45 (P0+P1+P2+P3+cosmetic-batch)

A meaningful share of the wrong/stale findings (P1-10/11/14/16/17, P2-3/4/5/11/12/14, P3-3/5) collapse into a single structural fix: stop enumerating source-derived facts in prose and start delegating to the canonical file. Tickets are still written individually because removing the enumeration is one ticket per file — they share a shape but not a touch site.
