// examples/web-multiplexer/shared/config.ts
// Shared runtime configuration for the bridge server and the Vite dev server.
//
// [LAW:one-source-of-truth] Demo port ownership lives here. The bridge and
// Vite server import the same constants instead of each hard-coding a port.

export const WEB_PORT = 44173;
export const BRIDGE_PORT = 44174;

// [LAW:one-source-of-truth] The bridge listens on loopback only, and the Vite
// proxy targets the same address, so the two can never disagree about which
// interface the bridge is reachable on.
export const BRIDGE_HOST = "127.0.0.1";

// The page origins the bridge serves: the Vite dev page under each loopback
// name. A WebSocket upgrade carries no CORS protection, so this allowlist is
// the whole of the cross-site defence (see server/trust-gate.ts).
export const WEB_ORIGINS: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "[::1]",
].map((host) => `http://${host}:${WEB_PORT}`);
