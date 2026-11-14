import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

// `bench:gate` — the window-terminal perf gates (tests/bench/*.bench.ts): slow
// real-tmux + --expose-gc contracts kept off the default `test:all` path.
// Everything else (globals, the socket-reaper globalSetup, the worker cap) is
// inherited from the base config.
//
// [LAW:one-source-of-truth] `include` is replaced, not merged: mergeConfig
// concatenates arrays, which would collect the whole unit suite into this run.
// No passWithNoTests: a glob that collects zero files fails loudly.
// [LAW:no-silent-failure]
export default mergeConfig(
  { ...base, test: { ...base.test, include: [] } },
  defineConfig({ test: { include: ["tests/bench/**/*.bench.ts"] } }),
);
