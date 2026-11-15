import { describe, expect, it } from "vitest";
import { FakeTmuxClient } from "../../helpers/fake-tmux-client.js";
import {
  TmuxCommandError,
  TransportClosedError,
} from "../../../src/browser.js";
import { ClientSizeDeclarer } from "../../../src/window-terminal/sizing/client-size.js";

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

function setup() {
  const client = new FakeTmuxClient();
  client.setConnectionState({ status: "ready" });
  const errors: unknown[] = [];
  const declarer = new ClientSizeDeclarer({
    connection: client,
    windowId: "@3",
    onError: (e) => errors.push(e),
  });
  // The per-window commands; the overall size that rides with each
  // declaration has its own test below.
  const sent = () =>
    client.commands().filter((c) => c.startsWith("refresh-client -C @"));
  return { client, declarer, errors, sent };
}

const declare = (cols: number, rows: number) =>
  ({ kind: "declare", grid: { cols, rows } }) as const;

describe("ClientSizeDeclarer", () => {
  it("a declaration also sets the client's overall size to the same grid", async () => {
    const { client, declarer } = setup();
    declarer.apply(declare(100, 30));
    await settle();
    declarer.apply({ kind: "release" });
    await settle();
    expect(client.commands()).toEqual([
      "refresh-client -C 100x30",
      "refresh-client -C @3:100x30",
      "refresh-client -C @3:",
    ]);
  });

  it("when a terminal on the connection releases, the others send their claims again", async () => {
    const { client, declarer: a } = setup();
    const b = new ClientSizeDeclarer({
      connection: client,
      windowId: "@3",
      onError: () => undefined,
    });
    const elsewhere = new ClientSizeDeclarer({
      connection: new FakeTmuxClient(),
      windowId: "@3",
      onError: () => undefined,
    });
    a.apply(declare(100, 30));
    b.apply(declare(90, 28));
    elsewhere.apply(declare(70, 20));
    await settle();
    const before = client.commands().length;

    // A's clear empties the slot B's claim was in; B fills it again.
    a.dispose();
    await settle();
    expect(client.commands().slice(before)).toEqual([
      "refresh-client -C @3:",
      "refresh-client -C 90x28",
      "refresh-client -C @3:90x28",
    ]);
    // B's own next frame finds tmux holding its claim and sends nothing.
    b.apply(declare(90, 28));
    await settle();
    expect(client.commands()).toHaveLength(before + 3);
    b.dispose();
    elsewhere.dispose();
  });

  it("declares, and does not repeat a size tmux already has", async () => {
    const { declarer, sent } = setup();
    declarer.apply(declare(100, 30));
    await settle();
    declarer.apply(declare(100, 30));
    await settle();
    expect(sent()).toEqual(["refresh-client -C @3:100x30"]);
  });

  it("one command in flight; the latest claim wins", async () => {
    const { declarer, sent } = setup();
    declarer.apply(declare(100, 30));
    declarer.apply(declare(90, 30));
    declarer.apply(declare(80, 24));
    await settle();
    expect(sent()).toEqual([
      "refresh-client -C @3:100x30",
      "refresh-client -C @3:80x24",
    ]);
  });

  it("hold sends nothing and keeps the declaration", async () => {
    const { declarer, sent } = setup();
    declarer.apply({ kind: "hold" });
    await settle();
    expect(sent()).toEqual([]);
    declarer.apply(declare(100, 30));
    await settle();
    declarer.apply({ kind: "hold" });
    await settle();
    expect(sent()).toEqual(["refresh-client -C @3:100x30"]);
  });

  it("release clears only what it declared", async () => {
    const { declarer, sent } = setup();
    declarer.apply({ kind: "release" });
    await settle();
    expect(sent()).toEqual([]);
    declarer.apply(declare(100, 30));
    declarer.apply({ kind: "release" });
    await settle();
    expect(sent()).toEqual([
      "refresh-client -C @3:100x30",
      "refresh-client -C @3:",
    ]);
  });

  it("dispose releases a declaration, then sends nothing", async () => {
    const { declarer, sent } = setup();
    declarer.apply(declare(100, 30));
    await settle();
    declarer.dispose();
    declarer.apply(declare(50, 20));
    await settle();
    expect(sent()).toEqual([
      "refresh-client -C @3:100x30",
      "refresh-client -C @3:",
    ]);
  });

  it("dispose with nothing declared sends nothing", async () => {
    const { declarer, sent } = setup();
    declarer.dispose();
    await settle();
    expect(sent()).toEqual([]);
  });

  it("declares again after the connection comes back", async () => {
    const { client, declarer, sent } = setup();
    declarer.apply(declare(100, 30));
    await settle();
    client.setConnectionState({ status: "reconnecting", attempt: 1 });
    client.setConnectionState({ status: "ready" });
    declarer.apply(declare(100, 30));
    await settle();
    expect(sent()).toEqual([
      "refresh-client -C @3:100x30",
      "refresh-client -C @3:100x30",
    ]);
  });

  it("a refused size reaches onError once and is not sent again; another size is", async () => {
    const { client, declarer, errors, sent } = setup();
    const refusal = new TmuxCommandError({
      commandNumber: 1,
      timestamp: 0,
      output: ["bad size argument"],
      success: false,
    });
    client.setExecuteFailure(() => refusal);
    for (let frame = 0; frame < 3; frame++) {
      declarer.apply(declare(100, 30));
      await settle();
    }
    expect(errors).toEqual([refusal]);
    client.setExecuteFailure(() => null);
    declarer.apply(declare(90, 30));
    await settle();
    expect(sent()).toEqual([
      "refresh-client -C @3:100x30",
      "refresh-client -C @3:90x30",
    ]);
  });

  it("a refusal reaches onError and the next claim is sent; a lost connection is not an error", async () => {
    const { client, declarer, errors, sent } = setup();
    const refusal = new TmuxCommandError({
      commandNumber: 1,
      timestamp: 0,
      output: ["bad size"],
      success: false,
    });
    client.setExecuteFailure(() => refusal);
    declarer.apply(declare(100, 30));
    await settle();
    expect(errors).toEqual([refusal]);
    client.setExecuteFailure(() => new TransportClosedError("gone"));
    declarer.apply(declare(90, 30));
    await settle();
    expect(errors).toEqual([refusal]);
    expect(sent()).toHaveLength(2);
  });
});
