// examples/web-multiplexer/shared/config.ts
// Shared runtime configuration for the bridge server and the Vite dev server.
//
// [LAW:one-source-of-truth] Demo port ownership lives here. The bridge and
// Vite server import the same constants instead of each hard-coding a port.
// Port values resolve in this order: env override → built-in default. The
// env hooks are how the e2e harness allocates a free pair of ports per
// test run so it can run isolated against whatever else the developer has
// open. Module is server-side only — no consumer in the browser bundle
// imports it (the renderer derives WS_URL from `location.host`).

const fromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const n = Number.parseInt(raw, 10);
  // [LAW:no-defensive-null-guards] Out-of-range or non-numeric env value
  // is a misconfiguration — fall through to the default rather than mask
  // it with a runtime error from a downstream listen().
  return Number.isFinite(n) && n > 0 && n <= 65535 ? n : fallback;
};

export const WEB_PORT = fromEnv("WEB_MULTIPLEXER_WEB_PORT", 44173);
export const BRIDGE_PORT = fromEnv("WEB_MULTIPLEXER_BRIDGE_PORT", 44174);
