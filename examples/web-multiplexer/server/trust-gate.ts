// examples/web-multiplexer/server/trust-gate.ts
// The bridge's trust boundary: which requests may reach tmux at all.
//
// Threat model: one person using the machine. The attacker is any web page in
// their browser, or another host on the network. Browsers apply no CORS to a
// WebSocket upgrade, so without this gate any page could open the bridge and
// run `run-shell`. Two facts stop both attackers:
//   - the bridge listens on loopback only (BRIDGE_HOST), so no other host can
//     connect;
//   - the request's `Origin` must be the demo's own page (WEB_ORIGINS). A
//     page cannot forge `Origin`, and a DNS-rebinding page still sends its own.
// `Host` is not checked: the Vite proxy rewrites it to the bridge's address on
// every request (`changeOrigin`), so it carries no information here.
//
// Out of scope: other local users on a shared machine can reach loopback and
// forge `Origin` from outside a browser.
//
// [LAW:single-enforcer] Every upgrade and every HTTP route passes through
// `admitUpgrade` / `admitHttp`, which share one origin rule.
// [LAW:parse-dont-validate] An admission carries the route it admitted, so a
// route handler is only reachable from an `admitted` value.

import type { IncomingHttpHeaders } from "node:http";
import {
  FIREHOSE_WS_PATH,
  TMUX_WS_PATH,
  WEB_ORIGINS,
} from "../shared/config.js";
import { MIRROR_WS_PATH } from "../shared/mirror-frame.js";
import { COLLAB_WS_PATH } from "../shared/collab-frame.js";

export type Route = "tmux" | "firehose" | "mirror" | "collab";

// [LAW:one-source-of-truth] The one table from URL path to route.
const ROUTES: ReadonlyMap<string, Route> = new Map([
  [TMUX_WS_PATH, "tmux"],
  [FIREHOSE_WS_PATH, "firehose"],
  [MIRROR_WS_PATH, "mirror"],
  [COLLAB_WS_PATH, "collab"],
]);

export interface GateRequest {
  readonly url?: string;
  readonly headers: IncomingHttpHeaders;
}

export interface Refusal {
  readonly kind: "refused";
  readonly status: 403 | 404;
  readonly reason: string;
}

export type UpgradeAdmission =
  | { readonly kind: "admitted"; readonly route: Route }
  | Refusal;

export type HttpAdmission = { readonly kind: "admitted" } | Refusal;

export function admitUpgrade(req: GateRequest): UpgradeAdmission {
  const origin = admitHttp(req);
  if (origin.kind === "refused") return origin;
  const path = (req.url ?? "").split("?")[0] ?? "";
  const route = ROUTES.get(path);
  return route === undefined
    ? { kind: "refused", status: 404, reason: `no WebSocket route ${path}` }
    : { kind: "admitted", route };
}

// A missing Origin is refused too: everything that legitimately reaches the
// bridge is the demo page, and a browser always sends Origin on an upgrade and
// on a cross-origin POST.
export function admitHttp(req: GateRequest): HttpAdmission {
  const origin = req.headers.origin;
  return origin !== undefined && WEB_ORIGINS.includes(origin)
    ? { kind: "admitted" }
    : {
        kind: "refused",
        status: 403,
        reason: `origin ${origin ?? "(none)"} is not the demo page`,
      };
}
