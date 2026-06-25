// examples/web-multiplexer/web/console-types.ts
// Value types for the Console tab, shared by the store (behavior), the
// UiStore (persistence validation), and the view components (rendering).
//
// This module is types + constants only — no behavior, no imports — so
// both `ConsoleStore` and `UiStore` can depend on it without a cycle.
// [LAW:one-way-deps] console-store → console-types ← ui-store.

/**
 * One REPL row, discriminated by `status`. Each variant carries only the
 * fields it can populate — a pending command has no output or latency yet;
 * a resolved one has exactly one of `output` (ok) or `message` (error).
 *
 * State transitions *replace* the entry in the ring rather than mutating
 * it: the variant's shape changes, so in-place field assignment would
 * leave a half-populated bag. TypeScript narrows on `status` alone.
 * [LAW:dataflow-not-control-flow] Outcome is data on the entry, not a
 * branch that decides whether a field exists.
 */
interface ReplEntryCommon {
  readonly id: number;
  readonly command: string;
  readonly submittedAt: number;
}

export type ReplEntry =
  | (ReplEntryCommon & { readonly status: "pending" })
  | (ReplEntryCommon & {
      readonly status: "ok";
      readonly output: readonly string[];
      readonly latencyMs: number;
    })
  | (ReplEntryCommon & {
      readonly status: "error";
      readonly message: string;
      readonly latencyMs: number;
    });

/** Playground evaluation channel: one-shot request vs. live subscription. */
export type PlaygroundMode = "one-shot" | "subscribed";

/**
 * Format-evaluation target. `active` is a synthetic entry resolved at
 * request time (whatever pane is current); `explicit` carries a concrete
 * tmux target token (e.g. `%3`, `@2`, `$0`). Only the token is persisted —
 * the human label is derived from `demoStore` at render time so it stays
 * one-source-of-truth and survives sessions/windows/panes coming and going.
 */
export type PlaygroundTarget =
  | { readonly kind: "active" }
  | { readonly kind: "explicit"; readonly target: string };

/**
 * Playground result, discriminated by `status`. `idle` = nothing evaluated
 * yet (distinct from an evaluated-to-empty value, which the view renders as
 * `(empty)`). `value` carries the latest snapshot plus an update counter for
 * subscription mode; previous values are not retained.
 */
export type PlaygroundResult =
  | { readonly status: "idle" }
  | { readonly status: "value"; readonly value: string; readonly updateCount: number }
  | { readonly status: "error"; readonly message: string };

/** Live REPL ring cap. Holds full response bodies; never persisted. */
export const REPL_RING_CAP = 200;
/** Persisted recall-command cap. Strings only — recall across reloads. */
export const CONSOLE_HISTORY_CAP = 50;

export const DEFAULT_FORMAT = "#{session_name}: #{window_name}";
export const DEFAULT_TARGET: PlaygroundTarget = { kind: "active" };
export const DEFAULT_MODE: PlaygroundMode = "one-shot";

/**
 * The persisted slice of Console state. The live REPL ring and the
 * playground result are intentionally absent — response bodies can be huge,
 * and recall only needs the command strings. `UiStore` is the single
 * authority for these; `ConsoleStore` reads them back through getters.
 */
export interface ConsolePersist {
  readonly commandHistory: readonly string[];
  readonly lastFormat: string;
  readonly lastTarget: PlaygroundTarget;
  readonly lastMode: PlaygroundMode;
}

export const DEFAULT_CONSOLE: ConsolePersist = {
  commandHistory: [],
  lastFormat: DEFAULT_FORMAT,
  lastTarget: DEFAULT_TARGET,
  lastMode: DEFAULT_MODE,
};

/**
 * Validate an untrusted persisted blob into a `ConsolePersist`. This is the
 * single trust boundary for Console persistence — `UiStore.loadFromStorage`
 * is the only caller, and every field falls back to its default rather than
 * propagating a malformed value. [LAW:single-enforcer]
 */
export function parseConsole(raw: unknown): ConsolePersist {
  if (typeof raw !== "object" || raw === null) return DEFAULT_CONSOLE;
  const bag = raw as Record<string, unknown>;
  return {
    commandHistory: Array.isArray(bag.commandHistory)
      ? bag.commandHistory
          .filter((x): x is string => typeof x === "string")
          .slice(-CONSOLE_HISTORY_CAP)
      : DEFAULT_CONSOLE.commandHistory,
    lastFormat:
      typeof bag.lastFormat === "string" ? bag.lastFormat : DEFAULT_CONSOLE.lastFormat,
    lastTarget: parseTarget(bag.lastTarget),
    lastMode:
      bag.lastMode === "one-shot" || bag.lastMode === "subscribed"
        ? bag.lastMode
        : DEFAULT_CONSOLE.lastMode,
  };
}

function parseTarget(raw: unknown): PlaygroundTarget {
  if (typeof raw !== "object" || raw === null) return DEFAULT_TARGET;
  const bag = raw as Record<string, unknown>;
  if (bag.kind === "active") return { kind: "active" };
  if (bag.kind === "explicit" && typeof bag.target === "string") {
    return { kind: "explicit", target: bag.target };
  }
  return DEFAULT_TARGET;
}
