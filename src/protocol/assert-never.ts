// src/protocol/assert-never.ts
// Shared exhaustiveness-check helper for discriminated-union switches.
//
// [LAW:types-are-the-program] A switch that reaches its `default` with a
// `never`-typed value is exhaustive by construction: adding a new union
// member without a matching `case` makes the call site fail to compile,
// rather than relying on a reviewer to notice a silently-unhandled variant.
// [LAW:one-source-of-truth] One shared helper for this idiom, so every
// exhaustive switch across the codebase states the same contract instead of
// each switch inventing its own throw message shape. Lives in protocol/
// (the foundational layer every other layer already depends on) so both
// protocol-internal switches and connector-level dispatch can reach it.

export function assertNever(value: never, context: string): never {
  throw new Error(`${context}: unhandled variant ${JSON.stringify(value)}`);
}
