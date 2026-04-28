// tests/e2e/playwright.config.ts
// Playwright config for the repository's end-to-end smoke suite.
//
// Tests live under tests/e2e/ and exercise the assembled examples/ apps.
// They DO NOT exercise the library in isolation — for that, see the
// integration suite under tests/integration/.

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // The Electron smoke spec spawns a real tmux server inside an Electron
  // child process. Cold launch + handshake fits comfortably in 30 s; we
  // give the whole test 60 s of room.
  timeout: 60_000,
  // Serial execution. Each test owns a per-PID tmux socket, so they can't
  // collide, but Electron is heavy enough that running two in parallel on
  // a developer's laptop is wasteful. Keep CI honest with `workers: 1`.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI === undefined ? 0 : 1,
  reporter: process.env.CI === undefined ? "list" : "github",
  use: {
    trace: "retain-on-failure",
  },
});
