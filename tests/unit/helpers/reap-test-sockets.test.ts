// Behavioral tests for the per-run tmux namespaces and their reaper.
//
// No real tmux needed: run directories are seeded under a temp root, with a
// liveness seam deciding which runs are dead and a spy recording which
// servers would be killed. The hard constraint: a live run's servers are
// never touched, whatever their sockets are called.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  reapDeadRuns,
  reapRun,
  RUNS_ROOT,
} from "../../helpers/reap-test-sockets.js";

const uid = process.getuid?.();
let root: string;
const killed: string[] = [];
/** Records each kill; a socket named `live-…` has a server running, any other is a dead file. */
const spyKill = (dir: string, socket: string): boolean => {
  killed.push(`${dir.slice(root.length + 1)}/${socket}`);
  return socket.startsWith("live-");
};

/** A run directory `pid` under the temp root, with these tmux sockets in it. */
function seedRun(pid: number, sockets: string[]): void {
  const socketDir = join(root, String(pid), `tmux-${uid}`);
  mkdirSync(socketDir, { recursive: true });
  for (const name of sockets) writeFileSync(join(socketDir, name), "");
}

beforeEach(() => {
  killed.length = 0;
  root = mkdtempSync(join(tmpdir(), "reap-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(uid === undefined)("reapDeadRuns", () => {
  it("reaps a dead run's servers and leaves a live run's alone, whatever their names", () => {
    seedRun(100, ["live-xsl-1-a", "live-collab-1-b"]);
    seedRun(200, ["live-xsl-1-a"]);

    const reaped = reapDeadRuns(root, (pid) => pid === 200, spyKill);

    expect(reaped.sort()).toEqual(["live-collab-1-b", "live-xsl-1-a"]);
    expect(killed.sort()).toEqual(["100/live-collab-1-b", "100/live-xsl-1-a"]);
    expect(readdirSync(root)).toEqual(["200"]);
  });

  it("reaps a dead run that never started a server", () => {
    mkdirSync(join(root, "100"));
    expect(reapDeadRuns(root, () => false, spyKill)).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  it("finds nothing when no run has made the root yet", () => {
    expect(reapDeadRuns(join(root, "absent"), () => false, spyKill)).toEqual(
      [],
    );
    expect(killed).toEqual([]);
  });
});

describe.skipIf(uid === undefined)("reapRun", () => {
  it("kills every server in the run's namespace, then removes it", () => {
    seedRun(100, ["live-a-1-x", "b-1-y"]);
    reapRun(join(root, "100"), spyKill);
    expect(killed.sort()).toEqual(["100/b-1-y", "100/live-a-1-x"]);
    expect(readdirSync(root)).toEqual([]);
  });

  it("reports only the servers still running, not the socket files tmux leaves behind", () => {
    seedRun(100, ["live-a-1-x", "b-1-y", "c-1-z"]);
    expect(reapRun(join(root, "100"), spyKill)).toEqual(["live-a-1-x"]);
  });
});

describe("this run's tmux namespace", () => {
  it("is where every tmux this worker spawns puts its socket", () => {
    // globalSetup set it before vitest started this worker.
    expect(process.env.TMUX_TMPDIR?.startsWith(`${RUNS_ROOT}/`)).toBe(true);
  });
});
