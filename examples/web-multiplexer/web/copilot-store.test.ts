// examples/web-multiplexer/web/copilot-store.test.ts
//
// Store-boundary coverage for the AI co-pilot (tmux-showcase-bhx.22): the LLM
// request state machine and the insert-without-Enter write. The prompt build
// and reply parse are covered in copilot-engine.test.ts; here we pin the
// store's effects with an injected fake LlmClient + a recording bridge double,
// so no network and no tmux are touched. [LAW:behavior-not-structure]

import { describe, it, expect } from "vitest";
import { CopilotStore } from "./copilot-store.ts";
import type { LlmClient } from "./llm-client.ts";
import type { TmuxBridge } from "./bridge.ts";
import type { CopilotSuggestResponse } from "../shared/copilot-frame.ts";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

interface SentKeys {
  readonly target: string;
  readonly keys: string;
}

/** Bridge double that records sendKeys and no-ops everything else. */
function recordingBridge(sent: SentKeys[]): TmuxBridge {
  const noopUnsub = (): void => {};
  const okResponse = {
    commandNumber: 0,
    timestamp: 0,
    output: [],
    success: true,
  };
  return {
    execute: () => Promise.resolve(okResponse),
    sendKeys: (target: string, keys: string) => {
      sent.push({ target, keys });
      return Promise.resolve(okResponse);
    },
    detach: () => {},
    connect: () => {},
    disconnect: () => {},
    onEvent: () => noopUnsub,
    onError: () => noopUnsub,
    onState: () => noopUnsub,
    onWire: () => noopUnsub,
    startFirehose: () => {},
    stopFirehose: () => {},
    onFirehose: () => noopUnsub,
  };
}

/** LlmClient double returning a canned response (and recording the call). */
function fakeLlm(
  response: CopilotSuggestResponse,
  calls: number[] = [],
): LlmClient {
  return {
    complete: (messages) => {
      calls.push(messages.length);
      return Promise.resolve(response);
    },
  };
}

describe("CopilotStore.requestSuggestions", () => {
  it("moves to `ready` with parsed suggestions on success", async () => {
    const store = new CopilotStore(
      recordingBridge([]),
      fakeLlm({
        ok: true,
        content: '[{"command": "git push", "reason": "publish commits"}]',
      }),
    );
    store.selectPane(7);
    await store.requestSuggestions("dev:0.1");

    expect(store.suggest.kind).toBe("ready");
    if (store.suggest.kind !== "ready") throw new Error("expected ready");
    expect(store.suggest.suggestions.map((s) => s.command)).toEqual([
      "git push",
    ]);
    expect(store.suggest.raw).toContain("git push");
  });

  it("moves to `error` (no fabrication) when the client reports a failure", async () => {
    const store = new CopilotStore(
      recordingBridge([]),
      fakeLlm({ ok: false, error: "LLM endpoint unreachable" }),
    );
    store.selectPane(7);
    await store.requestSuggestions("dev:0.1");

    expect(store.suggest.kind).toBe("error");
    if (store.suggest.kind !== "error") throw new Error("expected error");
    expect(store.suggest.message).toBe("LLM endpoint unreachable");
  });

  it("yields `ready` with zero suggestions when the reply is unparseable", async () => {
    const store = new CopilotStore(
      recordingBridge([]),
      fakeLlm({ ok: true, content: "I have no idea, sorry." }),
    );
    store.selectPane(7);
    await store.requestSuggestions("p");

    expect(store.suggest.kind).toBe("ready");
    if (store.suggest.kind !== "ready") throw new Error("expected ready");
    expect(store.suggest.suggestions).toHaveLength(0);
    expect(store.suggest.raw).toBe("I have no idea, sorry.");
  });

  it("does nothing with no pane selected", async () => {
    const calls: number[] = [];
    const store = new CopilotStore(
      recordingBridge([]),
      fakeLlm({ ok: true, content: "[]" }, calls),
    );
    await store.requestSuggestions("p");
    expect(store.suggest.kind).toBe("idle");
    expect(calls).toHaveLength(0);
  });
});

describe("CopilotStore.insert", () => {
  it("sends the command to the selected pane WITHOUT a trailing Enter", () => {
    const sent: SentKeys[] = [];
    const store = new CopilotStore(
      recordingBridge(sent),
      fakeLlm({ ok: true, content: "[]" }),
    );
    store.selectPane(42);
    store.insert("ls -la");

    expect(sent).toEqual([{ target: "%42", keys: "ls -la" }]);
    expect(sent[0].keys).not.toContain("\r");
  });

  it("does nothing with no pane selected", () => {
    const sent: SentKeys[] = [];
    const store = new CopilotStore(
      recordingBridge(sent),
      fakeLlm({ ok: true, content: "[]" }),
    );
    store.insert("rm -rf /");
    expect(sent).toHaveLength(0);
  });
});

describe("CopilotStore.requestSuggestions — concurrency guard (tmux-optimistic-ui-7ue)", () => {
  it("a stale-but-later-resolving request does not clobber a fresher one", async () => {
    const first = deferred<CopilotSuggestResponse>();
    const second = deferred<CopilotSuggestResponse>();
    const replies = [first.promise, second.promise];
    const llm: LlmClient = {
      complete: () => replies.shift()!,
    };
    const store = new CopilotStore(recordingBridge([]), llm);
    store.selectPane(1);

    const firstCall = store.requestSuggestions("p");
    const secondCall = store.requestSuggestions("p");

    // The SECOND (newer) request resolves first.
    second.resolve({ ok: true, content: '[{"command": "second"}]' });
    await secondCall;
    expect(store.suggest.kind).toBe("ready");
    if (store.suggest.kind !== "ready") throw new Error("expected ready");
    expect(store.suggest.suggestions.map((s) => s.command)).toEqual(["second"]);

    // The FIRST (stale) request resolves late — it must not overwrite the
    // fresher result the second request already wrote.
    first.resolve({ ok: true, content: '[{"command": "first"}]' });
    await firstCall;
    expect(store.suggest.kind).toBe("ready");
    if (store.suggest.kind !== "ready") throw new Error("expected ready");
    expect(store.suggest.suggestions.map((s) => s.command)).toEqual(["second"]);
  });

  it("selectPane mid-flight invalidates the in-flight request for the old pane", async () => {
    const pending = deferred<CopilotSuggestResponse>();
    const llm: LlmClient = { complete: () => pending.promise };
    const store = new CopilotStore(recordingBridge([]), llm);
    store.selectPane(1);

    const call = store.requestSuggestions("p");
    store.selectPane(2);
    expect(store.suggest.kind).toBe("idle");

    pending.resolve({ ok: true, content: '[{"command": "stale"}]' });
    await call;
    await tick();

    // The stale reply for pane 1 must not resurrect a suggestion after the
    // user has already moved on to pane 2.
    expect(store.suggest.kind).toBe("idle");
  });

  it("stop() mid-flight invalidates the in-flight request", async () => {
    const pending = deferred<CopilotSuggestResponse>();
    const llm: LlmClient = { complete: () => pending.promise };
    const store = new CopilotStore(recordingBridge([]), llm);
    store.start();
    store.selectPane(1);

    const call = store.requestSuggestions("p");
    store.stop();
    expect(store.suggest.kind).toBe("idle");

    pending.resolve({ ok: true, content: '[{"command": "stale"}]' });
    await call;
    await tick();

    // A reply that lands after stop() must not resurrect a suggestion — it
    // would surface a prior session's output after the copilot was torn down.
    expect(store.suggest.kind).toBe("idle");
  });
});

describe("CopilotStore.selectPane", () => {
  it("resets a prior suggestion to idle", async () => {
    const store = new CopilotStore(
      recordingBridge([]),
      fakeLlm({ ok: true, content: '[{"command": "ls"}]' }),
    );
    store.selectPane(1);
    await store.requestSuggestions("p");
    expect(store.suggest.kind).toBe("ready");

    store.selectPane(2);
    expect(store.suggest.kind).toBe("idle");
  });
});
