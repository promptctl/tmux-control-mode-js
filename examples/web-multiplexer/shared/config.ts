// examples/web-multiplexer/shared/config.ts
// Shared runtime configuration for the bridge server and the Vite dev server.
//
// [LAW:one-source-of-truth] The bridge port is declared here and nowhere else.
// server/bridge.ts listens on it, vite.config.ts proxies /ws to it.

export const BRIDGE_PORT = 5174;
