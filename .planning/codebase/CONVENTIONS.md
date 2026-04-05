# Coding Conventions

**Analysis Date:** 2026-04-05

## Naming Patterns

**Files:**
- Classes/types: PascalCase with descriptive noun (e.g., `TmuxParser`, `TmuxClient`, `TypedEmitter`)
- Utility functions: camelCase verb phrases (e.g., `decodeOctalEscapes`, `tmuxEscape`, `buildCommand`)
- Message/event types: PascalCase ending with `Message` suffix (e.g., `BeginMessage`, `OutputMessage`)
- Data type files: `types.ts`, `decode.ts`, `parser.ts`, `encoder.ts` — modular by function
- Test files: `*.test.ts` matching source module (e.g., `parser.ts` → `parser.test.ts`)

**Functions:**
- Private internal helpers: camelCase, prefixed with underscore (`_` indicates private intent)
- Public API methods: camelCase verb phrases (e.g., `execute()`, `listWindows()`, `sendKeys()`, `splitWindow()`)
- Parser helper functions: descriptive verb nouns (e.g., `parsePaneId()`, `parseGuard()`, `parseOutput()`)
- Type guard functions: `parse*` prefix (e.g., `parseWindowIdOnly()`, `parseSessionWithName()`)

**Variables:**
- Constants: UPPER_SNAKE_CASE (e.g., `BACKSLASH`, `PARSERS`)
- Local variables: camelCase (e.g., `messageNumber`, `outputLines`, `spaceIdx`)
- Internal state: camelCase with descriptive suffix (e.g., `buffer`, `activeCommandNumber`, `wildcardHandlers`)
- Boolean variables: clear descriptive names (e.g., `inResponseBlock`, `isNotification`)

**Types:**
- Interfaces: PascalCase, descriptive noun (e.g., `TmuxEventMap`, `TmuxMessage`, `CommandResponse`)
- Generic type parameters: Single uppercase letter or descriptive (e.g., `K extends keyof TmuxEventMap`)
- Message discriminated unions: Type literal strings in kebab-case (e.g., `"window-add"`, `"client-session-changed"`)
- Options objects: PascalCase with `Options` suffix (e.g., `SplitOptions`, `SpawnOptions`)

## Code Style

**Formatting:**
- Tool: Prettier
- Semicolons: Required (semi: true)
- Quotes: Double quotes for JS/TS strings (singleQuote: false)
- Indentation: 2 spaces (tabWidth: 2)
- Trailing commas: All contexts (trailingComma: "all")
- Line width: 80 characters (printWidth: 80)

**Linting:**
- Tool: ESLint with TypeScript support
- Config: `eslint.config.ts` (new flat config format)
- Extends: ESLint recommended + TypeScript strict + TypeScript stylistic
- Key rules enforced:
  - `@typescript-eslint/consistent-type-imports`: error — import types with `type` keyword
  - `@typescript-eslint/no-unused-vars`: error — variables prefixed with `_` are exempt
- No conflicting rules — ESLint config prettier ensures Prettier takes precedence

## Import Organization

**Order:**
1. Node.js standard library imports (`import { ... } from "node:..."`)
2. Third-party library imports (`import { ... } from "package-name"`)
3. Internal relative imports (`import { ... } from "./relative/path.js"`)
4. Type imports (`import type { ... } from "..."`)

**Path Aliases:**
- Not used — all imports are relative paths with explicit `./` or `../`
- All imports use `.js` file extension (ESM module resolution)

**Example pattern from `src/client.ts`:**
```typescript
import { TmuxParser } from "./protocol/parser.js";
import { buildCommand, refreshClientSubscribe, tmuxEscape } from "./protocol/encoder.js";
import type { CommandResponse, PaneAction, TmuxMessage } from "./protocol/types.js";
import { TypedEmitter } from "./emitter.js";
import type { TmuxEventMap } from "./emitter.js";
import type { TmuxTransport } from "./transport/types.js";
```

## Error Handling

**Patterns:**
- Robust degradation: Return `null` from parsers for malformed input — upstream handles gracefully
- Example from `src/protocol/parser.ts`: Parser functions return `TmuxMessage | null`; `null` indicates malformed line, which is skipped silently (not an error case in a streaming context)
- Trust boundaries: Validate input at the trust boundary only (external data, network responses)
- No defensive null guards for internal state — if null occurs inside, it's an architecture bug, not a runtime error

**On Errors at Trust Boundaries:**
- When a message fails to parse (malformed), continue processing; unknown message types are skipped
- When correlation state is missing during a response (e.g., orphaned `%end` without matching `%begin`), use optional chaining (`entry?.resolve()`) — the missing entry is a protocol violation, not a crash condition

## Logging

**Framework:** None — console methods only

**Patterns:**
- No logging in library code — TmuxClient, TmuxParser, etc. are side-effect-free
- Logging is consumer responsibility (user code can hook events to log)
- Integration tests may print diagnostic info for manual inspection

## Comments

**When to Comment:**
- Header comments on every file (one-line summary of purpose)
- Section headers for logical groupings within files (e.g., `// ---------------------------------------------------------------------------`)
- Law citations: Mark architectural decisions with `// [LAW:<token>]` followed by reason
- Exception marks: When violating a law, mark as `// [LAW:<token>] exception: reason`
- Algorithm explanation: Complex parsing logic (e.g., octal escape decoding) includes inline comments explaining the bounds checks and state transitions

**JSDoc/TSDoc:**
- Public API methods: JSDoc comments (e.g., `TmuxClient.execute()`, `TmuxParser.feed()`)
- Public interfaces: JSDoc describing purpose, semantics, and invariants
- Type definitions: Inline comments explaining constraints (e.g., `readonly paneId: number; // %NNN format`)
- Private methods: Comments are optional; code clarity is preferred

**Example from `src/protocol/parser.ts`:**
```typescript
/**
 * Streaming, push-based parser for the tmux control mode protocol.
 *
 * Accepts arbitrary text chunks via `feed()` and emits parsed `TmuxMessage`
 * objects through the `onMessage` callback. Handles line buffering for chunks
 * that split across line boundaries.
 */
export class TmuxParser {
  // ...
}
```

## Function Design

**Size:**
- Average function: 10–30 lines
- Helper functions: 3–15 lines (focused on single responsibility)
- Complex parsers: 5–20 lines with clear separation of concerns
- Example: `parseWindowPaneChanged()` is 7 lines — parse args, validate, return typed result

**Parameters:**
- Minimize parameter count (max 3–4 for public methods)
- Use object parameters for optional args (e.g., `SplitOptions` with optional fields)
- Example: `splitWindow(options: SplitOptions = {})` — all fields optional, defaults clear

**Return Values:**
- Typed returns: Always explicit (no implicit `undefined`)
- Union returns: Discriminated unions for variants (e.g., `TmuxMessage` union of specific message types)
- Nullable returns: Only at parsing boundaries (e.g., `TmuxMessage | null` from parser functions)
- Promise returns: All async operations return `Promise<T>` with explicit type

## Module Design

**Exports:**
- Files export functions, classes, or types that are named and descriptive
- Example from `src/protocol/encoder.ts`: Exports individual builder functions (`tmuxEscape`, `buildCommand`, etc.) not a namespace
- All public exports are re-exported from `src/index.ts` (single entry point)

**Barrel Files:**
- `src/protocol/index.ts`: Exports all protocol types and functions
- `src/transport/index.ts`: Exports transport types and spawn function
- `src/index.ts`: Main entry point, re-exports public API only
- Barrel files follow `export { X } from "./file.js"` pattern, not local re-exports

**Visibility:**
- Private fields use `private readonly` (immutable where possible)
- Internal state: Private with no direct access; behavior controlled via public methods
- Example from `TmuxClient`: `pending` queue and `inflight` entry are private; correlation state transitions only via `handleMessage()`

**Module Seams:**
- Transport layer (`src/transport/`) is an interface (`TmuxTransport`), not hardcoded to Node.js `child_process`
- Protocol layer (`src/protocol/`) has zero Node.js dependencies — portable to browser/Deno/Bun
- Parser is push-based (`feed()` method), not pull-based — consumer controls data flow
- Emitter is custom typed event emitter, not Node.js `EventEmitter` — portable and type-safe
