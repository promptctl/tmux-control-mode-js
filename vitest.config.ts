import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Reap leaked ephemeral tmux test sockets before and after the run so a
    // previously-killed run can't pile up servers that corrupt this run.
    globalSetup: ["./tests/helpers/global-socket-reaper.ts"],
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
