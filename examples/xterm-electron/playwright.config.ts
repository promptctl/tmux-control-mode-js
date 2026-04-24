import { defineConfig } from "@playwright/test";

// Electron e2e — no chromium/firefox/webkit projects needed. The tests
// launch Electron directly via `_electron.launch()`.
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : [["list"]],
});
