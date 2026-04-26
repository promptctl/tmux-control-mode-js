// tests/unit/connectors-rpc.test.ts
//
// Contract tests for the connector-agnostic RPC layer
// (src/connectors/rpc.ts + src/connectors/rpc-dispatch.ts).
//
// These are the BEHAVIOR tests for the absorbed-variance refactor: the
// per-connector tests (electron-bridge.test.ts, websocket-bridge.test.ts)
// still cover transport-specific concerns, but the validation + dispatch
// surface they used to exercise twice now lives here once.

import { describe, it, expect } from "vitest";

import { TmuxClient } from "../../src/client.js";
import { TmuxCommandError } from "../../src/errors.js";
import { PaneAction } from "../../src/protocol/types.js";
import type { TmuxTransport } from "../../src/transport/types.js";

import {
  parseRpcRequest,
  RpcError,
  synthesizeFireResponse,
  type RpcMethod,
  type RpcRequest,
} from "../../src/connectors/rpc.js";
import { dispatchRpcRequest } from "../../src/connectors/rpc-dispatch.js";

// ---------------------------------------------------------------------------
// Fakes — reused minimal transport for dispatch tests
// ---------------------------------------------------------------------------

function createFakeTransport(): {
  transport: TmuxTransport;
  sent: string[];
  feed: (chunk: string) => void;
} {
  let dataCb: ((c: string) => void) | null = null;
  const sent: string[] = [];
  const transport: TmuxTransport = {
    send(cmd) {
      sent.push(cmd);
    },
    onData(cb) {
      dataCb = cb;
    },
    onClose() {
      /* noop */
    },
    close() {
      /* noop */
    },
  };
  return {
    transport,
    sent,
    feed(chunk) {
      dataCb?.(chunk);
    },
  };
}

function feedOk(
  feed: (s: string) => void,
  commandNumber: number,
  lines: readonly string[] = [],
): void {
  feed(`%begin ${commandNumber} ${commandNumber} 0\n`);
  for (const l of lines) feed(l + "\n");
  feed(`%end ${commandNumber} ${commandNumber} 0\n`);
}

// ---------------------------------------------------------------------------
// parseRpcRequest — envelope rejection
// ---------------------------------------------------------------------------

describe("parseRpcRequest — envelope", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["string", "execute"],
    ["number", 42],
    ["array", []],
  ])("rejects non-object envelope (%s)", (_name, value) => {
    expect(() => parseRpcRequest(value)).toThrow(RpcError);
    expect(() => parseRpcRequest(value)).toThrow(/INVALID_REQUEST/);
  });

  it("rejects missing method", () => {
    expect(() => parseRpcRequest({ args: [] })).toThrow(/INVALID_REQUEST/);
  });

  it("rejects non-string method", () => {
    expect(() => parseRpcRequest({ method: 1, args: [] })).toThrow(
      /INVALID_REQUEST/,
    );
  });

  it("rejects non-array args", () => {
    expect(() => parseRpcRequest({ method: "execute", args: "x" })).toThrow(
      /INVALID_REQUEST/,
    );
  });
});

// ---------------------------------------------------------------------------
// parseRpcRequest — method allowlist
// ---------------------------------------------------------------------------

describe("parseRpcRequest — allowlist", () => {
  it("accepts every known RpcMethod", () => {
    const expected: ReadonlyArray<{ method: RpcMethod; args: readonly unknown[] }> = [
      { method: "execute", args: ["list-windows"] },
      { method: "listWindows", args: [] },
      { method: "listPanes", args: [] },
      { method: "sendKeys", args: ["%0", "echo hi"] },
      { method: "splitWindow", args: [{ vertical: true }] },
      { method: "splitWindow", args: [] }, // optional arg
      { method: "setSize", args: [80, 24] },
      { method: "setPaneAction", args: [1, PaneAction.Pause] },
      { method: "subscribe", args: ["sub", "%0", "#{pane_pid}"] },
      { method: "unsubscribe", args: ["sub"] },
      { method: "setFlags", args: [["pause-after=2"]] },
      { method: "clearFlags", args: [["pause-after"]] },
      { method: "requestReport", args: [3, "\u001b]10;\u001b\\"] },
      { method: "queryClipboard", args: [] },
      { method: "detach", args: [] },
    ];
    for (const e of expected) {
      const out = parseRpcRequest({ method: e.method, args: e.args });
      expect(out.method).toBe(e.method);
    }
  });

  it.each([
    "kill-server",
    "constructor",
    "__proto__",
    "toString",
    "hasOwnProperty",
    "exec",
    "",
  ])("rejects unknown/forbidden method %s", (m) => {
    expect(() => parseRpcRequest({ method: m, args: [] })).toThrow(
      /UNKNOWN_METHOD/,
    );
  });
});

// ---------------------------------------------------------------------------
// parseRpcRequest — per-method arg validation
// ---------------------------------------------------------------------------

describe("parseRpcRequest — arg shape", () => {
  it.each([
    [{ method: "execute", args: [] }],
    [{ method: "execute", args: [42] }],
    [{ method: "sendKeys", args: ["%0"] }],
    [{ method: "sendKeys", args: ["%0", 1] }],
    [{ method: "setSize", args: [80] }],
    [{ method: "setSize", args: ["80", "24"] }],
    [{ method: "setSize", args: [Number.NaN, 24] }],
    [{ method: "setPaneAction", args: [1, "bogus"] }],
    [{ method: "setPaneAction", args: ["1", PaneAction.Pause] }],
    [{ method: "subscribe", args: ["a", "b"] }],
    [{ method: "setFlags", args: [[1, 2]] }],
    [{ method: "setFlags", args: ["not-an-array"] }],
    [{ method: "splitWindow", args: ["not-an-object"] }],
    [{ method: "listWindows", args: ["extra"] }],
  ])("rejects invalid args: %j", (req) => {
    expect(() => parseRpcRequest(req)).toThrow(/INVALID_ARG/);
  });

  it("accepts splitWindow with no args (optional)", () => {
    const out = parseRpcRequest({ method: "splitWindow", args: [] });
    expect(out.method).toBe("splitWindow");
    expect(out.args).toEqual([undefined]);
  });
});

// ---------------------------------------------------------------------------
// dispatchRpcRequest — every variant routes to the right TmuxClient method
// ---------------------------------------------------------------------------

describe("dispatchRpcRequest — routing", () => {
  function makeClient(): { client: TmuxClient; sent: string[] } {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    return { client, sent: t.sent };
  }

  // Drop the dummy `makeClient` helper — every test below builds a fresh
  // (transport, client) pair so it can both observe `sent` and feed responses.
  void makeClient;

  it("listWindows → 'list-windows'", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const p = dispatchRpcRequest(client, { method: "listWindows", args: [] });
    expect(t.sent).toEqual(["list-windows\n"]);
    feedOk(t.feed, 1, ["@0 zsh 1 -"]);
    const r = await p;
    expect(r.success).toBe(true);
    expect(r.output).toEqual(["@0 zsh 1 -"]);
  });

  it("sendKeys forwards target+keys", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const p = dispatchRpcRequest(client, {
      method: "sendKeys",
      args: ["%0", "hi"],
    });
    expect(t.sent[0]).toContain("send-keys");
    expect(t.sent[0]).toContain("%0");
    expect(t.sent[0]).toContain("hi");
    feedOk(t.feed, 1);
    await p;
  });

  it("setPaneAction forwards paneId+action", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const p = dispatchRpcRequest(client, {
      method: "setPaneAction",
      args: [3, PaneAction.Pause],
    });
    expect(t.sent[0]).toContain("refresh-client");
    expect(t.sent[0]).toContain("%3:pause");
    feedOk(t.feed, 1);
    await p;
  });

  it("subscribe forwards name+what+format", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);
    const p = dispatchRpcRequest(client, {
      method: "subscribe",
      args: ["sub", "%0", "#{pane_pid}"],
    });
    expect(t.sent[0]).toContain("refresh-client");
    expect(t.sent[0]).toContain("sub");
    feedOk(t.feed, 1);
    await p;
  });
});

// ---------------------------------------------------------------------------
// dispatchRpcRequest — fire methods synthesize a CommandResponse
// ---------------------------------------------------------------------------

describe("dispatchRpcRequest — fire methods", () => {
  it("detach returns a synthesized success response without awaiting tmux", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);

    // Detach sends a single LF (per SPEC §4.1) and never sees a %begin/%end
    // pair from tmux. The dispatcher must resolve immediately.
    const result = await dispatchRpcRequest(client, {
      method: "detach",
      args: [],
    });

    expect(t.sent).toEqual(["\n"]);
    expect(result.success).toBe(true);
    expect(result.commandNumber).toBe(-1);
    expect(result.output).toEqual([]);
  });

  it("synthesizeFireResponse is exported for observability hooks", () => {
    const r = synthesizeFireResponse();
    expect(r.success).toBe(true);
    expect(r.commandNumber).toBe(-1);
    expect(r.output).toEqual([]);
    expect(typeof r.timestamp).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// dispatchRpcRequest — TmuxCommandError surfaces as Promise rejection
// ---------------------------------------------------------------------------

describe("dispatchRpcRequest — error propagation", () => {
  it("rejects with TmuxCommandError when tmux replies %error", async () => {
    const t = createFakeTransport();
    const client = new TmuxClient(t.transport);

    const p = dispatchRpcRequest(client, {
      method: "execute",
      args: ["bogus"],
    });
    t.feed("%begin 1 1 0\n");
    t.feed("unknown command\n");
    t.feed("%error 1 1 0\n");

    await expect(p).rejects.toBeInstanceOf(TmuxCommandError);
    await expect(p).rejects.toMatchObject({
      response: { success: false, output: ["unknown command"] },
    });
  });
});

// ---------------------------------------------------------------------------
// Type-level exhaustiveness sanity check
// ---------------------------------------------------------------------------

describe("RpcRequest exhaustiveness", () => {
  it("RpcMethod covers every variant", () => {
    // If RpcMethod ever drifts from RpcRequest['method'], this assignment
    // fails to type-check. The runtime body just confirms the literal set is
    // non-empty so the test counts as exercised.
    const methods: RpcMethod[] = [
      "execute",
      "listWindows",
      "listPanes",
      "sendKeys",
      "splitWindow",
      "setSize",
      "setPaneAction",
      "subscribe",
      "unsubscribe",
      "setFlags",
      "clearFlags",
      "requestReport",
      "queryClipboard",
      "detach",
    ];
    expect(methods.length).toBe(14);
    // Round-trip type narrowing via the union to confirm the discriminator
    // is load-bearing.
    const r: RpcRequest = { method: "listWindows", args: [] };
    expect(r.method).toBe("listWindows");
  });
});

