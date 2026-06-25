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
function fakeLlm(response: CopilotSuggestResponse, calls: number[] = []): LlmClient {
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
    expect(store.suggest.suggestions.map((s) => s.command)).toEqual(["git push"]);
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
    const store = new CopilotStore(recordingBridge(sent), fakeLlm({ ok: true, content: "[]" }));
    store.selectPane(42);
    store.insert("ls -la");

    expect(sent).toEqual([{ target: "%42", keys: "ls -la" }]);
    expect(sent[0].keys).not.toContain("\r");
  });

  it("does nothing with no pane selected", () => {
    const sent: SentKeys[] = [];
    const store = new CopilotStore(recordingBridge(sent), fakeLlm({ ok: true, content: "[]" }));
    store.insert("rm -rf /");
    expect(sent).toHaveLength(0);
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
