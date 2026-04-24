// tests/unit/keymap/bind.test.ts
// Dispatcher tests against a recording fake TmuxCommander.

import { describe, it, expect } from "vitest";
import {
  bindKeymap,
  defaultTmuxKeymap,
  dispatchAction,
  parseChord,
  type KeymapState,
  type TmuxCommander,
} from "../../../src/keymap/index.js";

function fakeClient(): {
  client: TmuxCommander;
  commands: string[];
  detaches: number;
} {
  const commands: string[] = [];
  let detaches = 0;
  return {
    commands,
    get detaches() {
      return detaches;
    },
    client: {
      execute(cmd) {
        commands.push(cmd);
        return undefined;
      },
      detach() {
        detaches += 1;
      },
    },
  };
}

describe("bindKeymap dispatch", () => {
  it("C-b c dispatches new-window", () => {
    const f = fakeClient();
    const b = bindKeymap(f.client, defaultTmuxKeymap());
    expect(b.handleKey(parseChord("C-b"))).toBe(true);
    expect(f.commands).toEqual([]);
    expect(b.handleKey(parseChord("c"))).toBe(true);
    expect(f.commands).toEqual(["new-window"]);
  });

  it("C-b % dispatches split-window -h", () => {
    const f = fakeClient();
    const b = bindKeymap(f.client, defaultTmuxKeymap());
    b.handleKey(parseChord("C-b"));
    b.handleKey(parseChord("%"));
    expect(f.commands).toEqual(["split-window -h"]);
  });

  it("C-b \" dispatches split-window -v", () => {
    const f = fakeClient();
    const b = bindKeymap(f.client, defaultTmuxKeymap());
    b.handleKey(parseChord("C-b"));
    b.handleKey(parseChord('"'));
    expect(f.commands).toEqual(["split-window -v"]);
  });

  it("C-b 5 dispatches select-window -t :5", () => {
    const f = fakeClient();
    const b = bindKeymap(f.client, defaultTmuxKeymap());
    b.handleKey(parseChord("C-b"));
    b.handleKey(parseChord("5"));
    expect(f.commands).toEqual(["select-window -t :5"]);
  });

  it("C-b Right dispatches select-pane -R", () => {
    const f = fakeClient();
    const b = bindKeymap(f.client, defaultTmuxKeymap());
    b.handleKey(parseChord("C-b"));
    b.handleKey(parseChord("Right"));
    expect(f.commands).toEqual(["select-pane -R"]);
  });

  it("C-b C-Down dispatches resize-pane -D 5", () => {
    const f = fakeClient();
    const b = bindKeymap(f.client, defaultTmuxKeymap());
    b.handleKey(parseChord("C-b"));
    b.handleKey(parseChord("C-Down"));
    expect(f.commands).toEqual(["resize-pane -D 5"]);
  });

  it("C-b d calls client.detach() (not execute)", () => {
    const f = fakeClient();
    const b = bindKeymap(f.client, defaultTmuxKeymap());
    b.handleKey(parseChord("C-b"));
    b.handleKey(parseChord("d"));
    expect(f.detaches).toBe(1);
    expect(f.commands).toEqual([]);
  });

  it("non-prefix key in root mode returns handled=false and dispatches nothing", () => {
    const f = fakeClient();
    const b = bindKeymap(f.client, defaultTmuxKeymap());
    expect(b.handleKey(parseChord("a"))).toBe(false);
    expect(f.commands).toEqual([]);
  });

  it("unbound key in prefix mode is swallowed (handled=true, no dispatch)", () => {
    const f = fakeClient();
    const b = bindKeymap(f.client, defaultTmuxKeymap());
    b.handleKey(parseChord("C-b"));
    expect(b.handleKey(parseChord("Z"))).toBe(true);
    expect(f.commands).toEqual([]);
  });
});

describe("KeymapBinding state observation", () => {
  it("state reflects root, then prefix, then root again", () => {
    const f = fakeClient();
    const b = bindKeymap(f.client, defaultTmuxKeymap());
    expect(b.state).toEqual({ mode: "root" });
    b.handleKey(parseChord("C-b"));
    expect(b.state).toEqual({ mode: "prefix" });
    b.handleKey(parseChord("c"));
    expect(b.state).toEqual({ mode: "root" });
  });

  it("onStateChange fires on transitions only, not on every keystroke", () => {
    const f = fakeClient();
    const b = bindKeymap(f.client, defaultTmuxKeymap());
    const states: KeymapState[] = [];
    b.onStateChange((s) => states.push(s));

    b.handleKey(parseChord("a")); // root → root, no notify
    b.handleKey(parseChord("C-b")); // root → prefix, notify
    b.handleKey(parseChord("c")); // prefix → root, notify
    b.handleKey(parseChord("b")); // root → root, no notify

    expect(states).toEqual([{ mode: "prefix" }, { mode: "root" }]);
  });

  it("onStateChange unsubscribe stops delivery", () => {
    const f = fakeClient();
    const b = bindKeymap(f.client, defaultTmuxKeymap());
    const received: KeymapState[] = [];
    const off = b.onStateChange((s) => received.push(s));
    b.handleKey(parseChord("C-b"));
    off();
    b.handleKey(parseChord("c"));
    expect(received).toEqual([{ mode: "prefix" }]);
  });
});

describe("dispatchAction exported", () => {
  it("maps Action → tmux command identically to bindKeymap's internal dispatch", () => {
    const f = fakeClient();
    dispatchAction(f.client, { type: "new-window" });
    dispatchAction(f.client, { type: "select-window", index: 3 });
    dispatchAction(f.client, { type: "split", orientation: "vertical" });
    dispatchAction(f.client, { type: "resize-pane", direction: "left", amount: 5 });
    expect(f.commands).toEqual([
      "new-window",
      "select-window -t :3",
      "split-window -v",
      "resize-pane -L 5",
    ]);
  });

  it("lets a consumer override some actions and delegate the rest", () => {
    const f = fakeClient();
    const killed: unknown[] = [];

    // Composed dispatcher: intercept kill-pane, delegate everything else.
    function composedDispatch(action: Parameters<typeof dispatchAction>[1]): void {
      if (action.type === "kill-pane") {
        killed.push(action);
        return;
      }
      dispatchAction(f.client, action);
    }

    composedDispatch({ type: "new-window" });
    composedDispatch({ type: "kill-pane" });
    composedDispatch({ type: "next-window" });

    expect(f.commands).toEqual(["new-window", "next-window"]);
    expect(killed).toEqual([{ type: "kill-pane" }]);
  });
});
