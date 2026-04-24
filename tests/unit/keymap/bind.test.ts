// tests/unit/keymap/bind.test.ts
// Dispatcher tests against a recording fake TmuxCommander.

import { describe, it, expect } from "vitest";
import {
  bindKeymap,
  defaultTmuxKeymap,
  parseChord,
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
