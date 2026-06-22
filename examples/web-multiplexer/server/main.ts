// examples/web-multiplexer/server/main.ts
// Process entry for the demo bridge: start the server and own the signal
// handlers. All wiring lives in ./bridge.ts; this file is the boundary where
// the listen + lifecycle effects happen. [LAW:effects-at-boundaries]

import { startBridge } from "./bridge.js";

const bridge = startBridge();

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  bridge.close();
  setImmediate(() => {
    process.exit(0);
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
