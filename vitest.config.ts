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
    include: [
      "src/**/*.test.ts",
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
      // Pure, package-independent demo logic (trigram index, ANSI→text).
      // These import no browser/DOM/React deps, so they run under the same
      // node test env and keep `test:all` the single canonical command.
      "examples/web-multiplexer/web/*.test.ts",
      // @promptctl/pane-terminal correctness UNIT tests, folded into the one
      // canonical run so breaking package source reddens `test:all`.
      // [LAW:verifiable-goals] a gate that can't see a suite can't fail on it.
      // Node is the default env here; the DOM-needing files opt in per-file
      // via `// @vitest-environment happy-dom`, so no project split is needed.
      // Only tests/unit is canonical: tests/bench are slow real-tmux +
      // --expose-gc perf gates, invoked explicitly via the package's
      // `bench:gate` script, deliberately kept off the default local path.
      "packages/pane-terminal/tests/unit/**/*.test.ts",
      "packages/pane-terminal/tests/unit/**/*.test.tsx",
    ],
  },
});
