// examples/web-multiplexer/shared/config.ts
// Shared runtime configuration for the bridge server and the Vite dev server.
//
// [LAW:one-source-of-truth] Demo port ownership lives here. The bridge and
// Vite server import the same constants instead of each hard-coding a port.

export const WEB_PORT = 44173;
export const BRIDGE_PORT = 44174;
