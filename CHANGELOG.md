# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); version numbers follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0]

Initial public release. Implements the tmux control mode protocol as documented
in [`SPEC.md`](./SPEC.md), targeting tmux 3.2 or later.

### Added

- `TmuxClient` with FIFO command/response correlation and a typed event emitter
  for all 28 server→client message types (`src/client.ts`, `src/emitter.ts`).
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
- Subpath exports: `tmux-control-mode-js/protocol` for consumers that manage
  their own transport.
- Reference `examples/web-multiplexer/` demo with three modes: a full pane
  multiplexer, a protocol inspector (Wireshark for control mode), and an
  activity heatmap across every pane in every session.

### Requirements

- Node.js ≥ 20.
- tmux ≥ 3.2. The 3.2 floor is load-bearing; see the Compatibility section of
  [`README.md`](./README.md) for details.

[Unreleased]: https://github.com/brandon-fryslie/tmux-control-mode-js/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/brandon-fryslie/tmux-control-mode-js/releases/tag/v0.1.0
