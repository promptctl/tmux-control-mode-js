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
    ],
  },
});
