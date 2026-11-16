import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Reap leaked ephemeral tmux test sockets before and after the run so a
    // previously-killed run can't pile up servers that corrupt this run.
    globalSetup: ["./tests/helpers/global-socket-reaper.ts"],
    // [LAW:no-ambient-temporal-coupling] Integration tests each spawn a real
    // tmux daemon. Without a concurrency cap, all 10 integration files start
    // simultaneously, creating OS-level contention (CPU, pipe buffers, fd
    // limits) that surfaces as transport-write/timeout flakes unrelated to any
    // code under test. 4 workers keeps peak concurrent servers at 4 (vs 10+),
    // which eliminates the contention while staying well under serial speed.
    maxWorkers: 4,
    // [LAW:one-source-of-truth] The integration helpers' own deadlines
    // (readUntil 8s, waitForEvent 12s) fail with a message naming what they
    // last saw; the test's deadline must outlast them or vitest's generic
    // timeout fires first and that message never appears.
    testTimeout: 15_000,
    include: [
      "src/**/*.test.ts",
      // window-terminal unit tests live under tests/unit/window-terminal. Node
      // is the default env; the DOM-needing files opt in per-file via
      // `// @vitest-environment happy-dom`, so no project split is needed.
      "tests/unit/**/*.test.ts",
      "tests/unit/**/*.test.tsx",
      "tests/integration/**/*.test.ts",
      // Demo logic, run under the same node test env so `test:all` stays the
      // single canonical command. Files that import the package resolve it
      // through its exports map to the built dist/, as the demo does — build
      // first; cases that drive real tmux sit behind TMUX_INTEGRATION=1.
      "examples/web-multiplexer/web/*.test.ts",
      // tests/bench (*.bench.ts) is not collected here: those are slow
      // real-tmux + --expose-gc perf gates run by `bench:gate`
      // (vitest.bench.config.ts), deliberately kept off the default local path.
    ],
  },
});
