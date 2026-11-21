// tests/unit/example-trust-gate.test.ts
//
// The bridge's trust boundary: only the demo page's own origin reaches a
// route, and only a route the bridge serves is admitted.

import { describe, it, expect } from "vitest";
import {
  FIREHOSE_WS_PATH,
  TMUX_WS_PATH,
  WEB_ORIGINS,
  WEB_PORT,
} from "../../examples/web-multiplexer/shared/config.js";
import { MIRROR_WS_PATH } from "../../examples/web-multiplexer/shared/mirror-frame.js";
import { COLLAB_WS_PATH } from "../../examples/web-multiplexer/shared/collab-frame.js";
import {
  admitHttp,
  admitUpgrade,
} from "../../examples/web-multiplexer/server/trust-gate.js";

const ROUTES = [
  [TMUX_WS_PATH, "tmux"],
  [FIREHOSE_WS_PATH, "firehose"],
  [MIRROR_WS_PATH, "mirror"],
  [COLLAB_WS_PATH, "collab"],
] as const;

const PAGE = WEB_ORIGINS[0];

describe("admitUpgrade", () => {
  it.each(
    WEB_ORIGINS.flatMap((origin) =>
      ROUTES.map(([path, route]) => ({ origin, path, route })),
    ),
  )(
    "admits $origin on $path as the $route route",
    ({ origin, path, route }) => {
      expect(
        admitUpgrade({ url: `${path}?pane=%1`, headers: { origin } }),
      ).toEqual({ kind: "admitted", route });
    },
  );

  it.each([
    { name: "no Origin", headers: {} },
    { name: "the literal null origin", headers: { origin: "null" } },
    {
      name: "a rebinding page on the demo's port",
      headers: { origin: `http://evil.com:${WEB_PORT}` },
    },
    {
      name: "the bridge's own port",
      headers: { origin: "http://localhost:44174" },
    },
    {
      name: "https on the demo's port",
      headers: { origin: `https://localhost:${WEB_PORT}` },
    },
  ])("refuses $name with 403 on every route", ({ headers }) => {
    for (const [path] of ROUTES) {
      expect(admitUpgrade({ url: path, headers })).toMatchObject({
        kind: "refused",
        status: 403,
      });
    }
  });

  it("refuses a path the bridge serves no socket on with 404", () => {
    expect(
      admitUpgrade({ url: "/nope", headers: { origin: PAGE } }),
    ).toMatchObject({ kind: "refused", status: 404 });
  });
});

describe("admitHttp", () => {
  it("admits the demo page and refuses any other origin, as upgrades do", () => {
    expect(admitHttp({ headers: { origin: PAGE } })).toEqual({
      kind: "admitted",
    });
    expect(
      admitHttp({ headers: { origin: `http://evil.com:${WEB_PORT}` } }),
    ).toMatchObject({ kind: "refused", status: 403 });
    expect(admitHttp({ headers: {} })).toMatchObject({
      kind: "refused",
      status: 403,
    });
  });
});
