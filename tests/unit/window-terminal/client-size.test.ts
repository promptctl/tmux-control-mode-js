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
    declarer.apply(declare(100, 30));
    await settle();
    expect(errors).toEqual([refusal]);
    expect(sent()).toHaveLength(2);
  });
});
