// vitest globalSetup: reap leaked test sockets before AND after the whole run.
//
// `setup()` clears stale sockets a *previous* killed run left behind (so this
// run starts on a clean machine); `teardown()` clears anything *this* run leaks
// if it is killed before per-test afterEach hooks complete. Registered via
// `test.globalSetup` in vitest.config.ts. Safe for the unit-only `pnpm test`
// path too: with no socket dir or no tmux, the reaper finds nothing and no-ops.

import { reapTestSockets } from "./reap-test-sockets.js";

function reap(phase: "pre-run" | "post-run"): void {
  const reaped = reapTestSockets();
  // Loud only when it actually reaped — a recurring nonzero count is the signal
  // that some run is being killed and leaking. [LAW:no-silent-failure]
  if (reaped.length > 0) {
    console.log(
      `[reap-test-sockets] ${phase}: reaped ${reaped.length} leaked test socket(s)`,
    );
  }
}

export function setup(): void {
  reap("pre-run");
}

export function teardown(): void {
  reap("post-run");
}
