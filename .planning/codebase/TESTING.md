# Testing Patterns

**Analysis Date:** 2026-04-05

## Test Framework

**Runner:**
- Vitest 4.1.0
- Config: `vitest.config.ts`
- Global test APIs enabled (describe, it, expect, beforeEach, afterEach available without imports)

**Assertion Library:**
- Vitest's built-in expect (chai-compatible)
- Methods: `.toMatchObject()`, `.toEqual()`, `.toHaveLength()`, `.toBe()`, `.toBeGreaterThan()`, `.then()/.catch()` promise chains

**Run Commands:**
```bash
npm test                # Run all tests once
npm run test:watch      # Watch mode (rerun on file changes)
# Note: No separate coverage command configured yet
```

## Test File Organization

**Location:**
- Unit tests: `tests/unit/**/*.test.ts`
- Integration tests: `tests/integration/**/*.test.ts`
- Fixtures: `tests/fixtures/**/*.txt` (protocol trace files, not code)
- Source code tests: `src/**/*.test.ts` (not currently used; files can be added here)

**Naming:**
- Test files: Match source module name with `.test.ts` suffix
  - `src/protocol/parser.ts` → `tests/unit/parser.test.ts`
  - `src/protocol/encoder.ts` → `tests/unit/encoder.test.ts`
  - `src/client.ts` → `tests/integration/client.test.ts`

**Structure:**
```
tests/
├── fixtures/          # Protocol trace files (*.txt)
│   ├── startup.txt    # Fixture content — tmux protocol examples
│   ├── basic-command-response.txt
│   ├── error-response.txt
│   └── ... (16+ more)
├── unit/              # Isolated unit tests
│   ├── parser.test.ts
│   ├── encoder.test.ts
│   └── decoder.test.ts
└── integration/       # Tests requiring real tmux process
    └── client.test.ts
```

## Test Structure

**Suite Organization:**
```typescript
// tests/unit/parser.test.ts — fixture-driven unit tests

import { TmuxParser } from "../../src/protocol/parser.js";
import type { TmuxMessage } from "../../src/protocol/types.js";

// Helper: Load fixture file
function fixtureContent(name: string): string {
  return readFileSync(join(__dirname, "../fixtures", name), "utf8");
}

// Helper: Parse and collect messages
function collect(content: string): {
  messages: TmuxMessage[];
  outputLines: Array<{ commandNumber: number; line: string }>;
} {
  const messages: TmuxMessage[] = [];
  const outputLines: Array<{ commandNumber: number; line: string }> = [];
  const parser = new TmuxParser((msg) => messages.push(msg));
  parser.onOutputLine = (commandNumber, line) =>
    outputLines.push({ commandNumber, line });
  parser.feed(content);
  return { messages, outputLines };
}

// Test suite
describe("fixture: startup.txt", () => {
  it("emits expected messages in order", () => {
    const { messages } = collect(fixtureContent("startup.txt"));
    expect(messages[0]).toMatchObject({
      type: "begin",
      timestamp: 1699900000,
      commandNumber: 0,
      flags: 0,
    });
    expect(messages).toHaveLength(8);
  });
});
```

**Patterns:**
- Helper functions: Test utilities (e.g., `collect()`, `fixtureContent()`) at top of file before describe blocks
- Fixtures first: Each describe block tests one fixture or concept
- Nested assertions: Use `.toMatchObject()` for partial object matching, exact fields for full checks
- Collection testing: Test both message count and field values

## Mocking

**Framework:** None — no mocking library

**Patterns:**
- Mocking is done manually via closures and callbacks
- Example from `tests/unit/parser.test.ts`:
  ```typescript
  const messages: TmuxMessage[] = [];
  const parser = new TmuxParser((msg) => messages.push(msg));
  parser.onOutputLine = (commandNumber, line) =>
    outputLines.push({ commandNumber, line });
  ```
  - Parser callback is replaced with a test function that captures messages
  - Output callback is replaced with a test function that captures output lines

**What to Mock:**
- Transport layer: Integration tests create real tmux process; unit tests don't need transport mocking
- File I/O: Fixture files are read once per test suite (no mocking needed — fixtures are static test data)
- Time: Not mocked in tests; timestamps are captured from parser output and asserted as numbers

**What NOT to Mock:**
- Parser/encoder/decoder: These are tested directly with real protocol data (fixtures)
- Message types: Don't mock message creation; construct real typed messages via parser
- Promises: Don't mock Promise.resolve/reject; integration tests use real async/await with timeouts

## Fixtures and Factories

**Test Data:**
- Fixtures are static `.txt` files containing tmux control mode protocol traces
- Each fixture represents a complete scenario (e.g., startup handshake, command response, error response)
- Fixtures are loaded and fed to the parser; output is compared to expectations

**Example fixture: `tests/fixtures/basic-command-response.txt`**
```
%begin 1699900000 1 0
0: bash* (1 panes) [220x50] [layout 4b5a,220x50,0,0,%1] @1 (active)
%end 1699900000 1 0
%begin 1699900000 2 0
0: [220x50] [history 1000/50000, 204800 bytes] %1 (active)
%end 1699900000 2 0
%begin 1699900000 3 0
%end 1699900000 3 0
```

**Fixture Locations:**
- `tests/fixtures/`: All `.txt` files are protocol traces
- Current fixtures: 16 files covering startup, commands, errors, events, subscriptions

**Test Data Creation:**
- No factory functions — fixtures are static files
- Integration tests create real tmux sessions dynamically:
  ```typescript
  function createSession(sessionName: string): Promise<TmuxClient> {
    execSync(`tmux new-session -d -s ${sessionName}`);
    const transport = spawnTmux(["attach-session", "-t", sessionName]);
    const client = new TmuxClient(transport);
    return new Promise<TmuxClient>((resolve) => {
      const handler = () => {
        client.off("session-changed", handler);
        resolve(client);
      };
      client.on("session-changed", handler);
    });
  }
  ```

## Coverage

**Requirements:** None enforced

**View Coverage:** Not configured

**Status:** No automated coverage measurement in place. Manual review of test files shows:
- Unit tests: Parser, encoder, decoder have comprehensive fixture-driven tests
- Integration tests: Client command correlation and lifecycle are tested against real tmux
- Gaps: Transport spawn layer is not explicitly tested; relies on integration tests with real tmux

## Test Types

**Unit Tests:**
- **Location:** `tests/unit/**/*.test.ts`
- **Scope:** Parser, encoder, decoder — protocol primitives
- **Approach:** Fixture-driven (load protocol trace, feed to parser, assert output)
- **Example:** `tests/unit/parser.test.ts` — 30+ describe blocks, each testing one fixture or edge case
- **Isolation:** Zero dependencies on external systems; all tests pass without tmux installed

**Integration Tests:**
- **Location:** `tests/integration/**/*.test.ts`
- **Scope:** TmuxClient against real tmux process
- **Approach:** Spawn actual tmux session, execute commands, assert responses
- **Example:** `tests/integration/client.test.ts` — tests command correlation, lifecycle events
- **Gating:** Tests are skipped unless `TMUX_INTEGRATION=1` environment variable is set
- **Cleanup:** `afterEach()` hook kills sessions to prevent leaks

**E2E Tests:**
- Not used — integration tests serve as E2E tests (real tmux, real protocol)

## Common Patterns

**Async Testing:**
```typescript
// Timeout parameter passed to it()
it("execute(list-windows) resolves with output", async () => {
  const response = await client.execute("list-windows");
  expect(response.success).toBe(true);
}, 15000);  // 15 second timeout

// Promise chains for error handling
const response = await client
  .execute("invalid-command")
  .then(
    (r) => r,  // Success case
    (r: CommandResponse) => r,  // Error case (rejection caught as value)
  );
expect(response.success).toBe(false);
```

**Error Testing:**
```typescript
// Errors are treated as resolved CommandResponse objects with success: false
const response = await client
  .execute("invalid-command-xyz")
  .then(
    (r) => r,
    (r: CommandResponse) => r,  // Rejection is caught and inspected
  );
expect(response.success).toBe(false);
expect(response.output.length).toBeGreaterThan(0);  // Error message is in output
```

**Fixture-Driven Testing:**
```typescript
describe("fixture: error-response.txt", () => {
  it("emits begin/error guards", () => {
    const { messages } = collect(fixtureContent("error-response.txt"));
    const types = messages.map((m) => m.type);
    expect(types).toEqual([
      "begin", "error",
      "begin", "error",
      "begin", "error",
    ]);
  });

  it("routes error output lines", () => {
    const { outputLines } = collect(fixtureContent("error-response.txt"));
    expect(outputLines[0]).toEqual({
      commandNumber: 4,
      line: "unknown command: bad-command",
    });
  });
});
```

**Conditional Test Gating:**
```typescript
const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

describe.skipIf(!RUN_INTEGRATION)("Command Correlation", () => {
  // Integration tests skipped unless env var is set
  // ...
});
```

**Cleanup Patterns:**
```typescript
describe("integration", () => {
  let sessionName: string;
  let client: TmuxClient;

  afterEach(() => {
    client?.close();
    killSession(sessionName);  // Best-effort cleanup
  });

  it("test", async () => {
    sessionName = uniqueSession("test-prefix");
    client = await createSession(sessionName);
    // test code
  });
});

// Helper: Unique session name per test invocation
function uniqueSession(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// Helper: Kill session, ignoring errors
function killSession(name: string): void {
  try {
    execSync(`tmux kill-session -t ${name}`, { stdio: "ignore" });
  } catch {
    // Session may already be gone — not an error
  }
}
```

---

*Testing analysis: 2026-04-05*
