# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); version numbers follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Breaking Changes

- **`attachPaneSink` and `attachAllPanesSink` removed** (replaced by
  `attachBytesSink` with scope options).
- **`PaneByteSink` and `PaneByteMultiplexer` removed** (both collapsed into the
  new `BytesSink` interface — `{ write(msg: PaneOutputMessage): void; end?(): void }`).
- **`PaneSinkRegistry` removed** (internal; replaced by `SinkRegistry` + `PaneTopologyManager`).

### Added

- **`attachBytesSink(sink, options?)`** on every `TmuxClientLike`. Replaces the
  old per-pane / all-panes split with a single entry point and a scope
  discriminator. Default scope is `serverScope` (all panes, equivalent to the
  old `attachAllPanesSink`).
- **`BytesSink`** — the unified byte-consumer contract exported from the package
  root. `write(msg: PaneOutputMessage): void; end?(): void`.
- **`PaneScope`** — discriminated union with four arms: `serverScope`,
  `sessionScope(id)`, `windowScope(id)`, `paneScope(id)`. Exported as value
  factory functions and as a type from the package root.
- **`PaneTopologyManager`** — internal paneId→{sessionId,windowId} table, seeded
  at connect time and kept up-to-date by `window-add`, `window-close`,
  `layout-change`, and `sessions-changed` notifications.
- **`SinkRegistry`** — scope-bifurcated dispatch: one bucket per scope kind.
  Snapshot-before-write prevents re-entrant attach/detach from skipping or
  double-delivering a chunk.
- Topology bootstrap is lazy: fires only when a session- or window-scoped sink
  is attached, so server-scope and pane-scope consumers pay zero extra cost.
- 9 new integration tests in `tests/integration/pane-scope.test.ts` covering
  all four scope kinds, dynamic membership (window-add), multi-scope dispatch
  without duplication, bootstrap correctness, and the no-consumer fast path.

Full design: `design-docs/pane-output-architecture.md`.

## [0.1.0]

Initial public release. Implements the tmux control mode protocol as documented
in [`SPEC.md`](./SPEC.md), targeting tmux 3.2 or later.

### Added

- `TmuxClient` with FIFO command/response correlation and a typed event emitter
  for every server→client message type the parser emits — see the `TmuxMessage`
  union in `src/protocol/types.ts` for the authoritative list (`src/client.ts`,
  `src/emitter.ts`).
- Streaming line-oriented parser with full response-block tracking
  (`src/protocol/parser.ts`).
- Wire-format encoder as the single source of truth for every client→server
  command (`src/protocol/encoder.ts`). Argument escaping via `tmuxEscape`.
- Octal escape decoder for `%output` data (`src/protocol/decode.ts`).
- Node.js `child_process` spawn transport with DCS framing primitives for a
  future PTY-backed `-CC` transport (`src/transport/spawn.ts`).
- Typed public API for every `refresh-client` surface the library supports:
  `setSize`, `setPaneAction`, `subscribe`/`unsubscribe`, `setFlags`/`clearFlags`,
  `requestReport`, `queryClipboard`, plus `detach` and `close`.
- 157 unit tests and 19 integration tests. The integration suite runs against a
  real tmux process and is gated by `TMUX_INTEGRATION=1`.
- Subpath imports take the form `@promptctl/tmux-control-mode-js/<subpath>`
  where `<subpath>` is one of: `protocol`, `keymap`, `electron/main`,
  `electron/renderer`, `websocket`, `websocket/server`, `websocket/client`,
  `websocket/protocol`, `websocket/transport`, `streams/web`, `streams/node` —
  see the `exports` map in `package.json` for the authoritative list.
- Reference `examples/web-multiplexer/` demo with three modes: a full pane
  multiplexer, a protocol inspector (Wireshark for control mode), and an
  activity heatmap across every pane in every session.

### Requirements

- Node.js ≥ 20.
- tmux ≥ 3.2. The 3.2 floor is load-bearing; see the Compatibility section of
  [`README.md`](./README.md) for details.

[Unreleased]: https://github.com/promptctl/tmux-control-mode-js/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/promptctl/tmux-control-mode-js/releases/tag/v0.1.0
