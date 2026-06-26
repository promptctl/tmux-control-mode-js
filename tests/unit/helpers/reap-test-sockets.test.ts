// Behavioral tests for the socket reaper.
//
// No real tmux needed: we inject a temp dir seeded with test and foreign socket
// files, and a spy `killServer` that records which names it was called with.
// The test asserts only test-prefixed sockets are reaped and foreign ones are
// preserved. This verifies the hard constraint from the ticket:
// MUST never touch the developer's real `default` socket or unrelated sockets.

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isTestSocket,
  reapTestSockets,
  TEST_SOCKET_PREFIXES,
} from "../../helpers/reap-test-sockets.js";

// ──────────────────────────────────────────────────────────────────────────────
// isTestSocket — pure predicate, no IO
// ──────────────────────────────────────────────────────────────────────────────

describe("isTestSocket", () => {
  it("accepts every registered prefix", () => {
    for (const prefix of TEST_SOCKET_PREFIXES) {
      const name = `${prefix}1234567890-ab3fg`;
      expect(isTestSocket(name), `expected true for: ${name}`).toBe(true);
    }
  });

  it("rejects the developer's real default socket", () => {
    expect(isTestSocket("default")).toBe(false);
  });

  it("rejects unrelated demo and tool sockets", () => {
    for (const name of [
      "cmtest-44650",
      "imgtest-66912",
      "imgtest-probe",
      "mreg",
      "collab",
      "sniffdemo",
      "webgl",
      "sbtm",
      "console",
    ]) {
      expect(isTestSocket(name), `expected false for: ${name}`).toBe(false);
    }
  });

  it("does not match on substring — prefix must be at index 0", () => {
    expect(isTestSocket("not-tmux-js-test-foo")).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// reapTestSockets — IO behavior via injected dir + killServer spy
// ──────────────────────────────────────────────────────────────────────────────

let testDir: string;
const killed: string[] = [];

beforeEach(() => {
  killed.length = 0;
  testDir = join(
    tmpdir(),
    `reap-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function seedSocket(name: string): void {
  writeFileSync(join(testDir, name), "");
}

function spyKill(name: string): void {
  killed.push(name);
}

function surviving(): string[] {
  return readdirSync(testDir);
}

describe("reapTestSockets", () => {
  it("reaps all test-prefixed sockets and leaves foreign ones intact", () => {
    const testSockets = [
      "tmux-js-test-cmd-1782133005851-kkh3i",
      "tmux-scope-test-paneTitle-1782133005851-kkh3i",
      "tmux-bridge-test-auth-1782136013827-asbek",
      "tmux-bytes-sink-test-electron-1782133005851-kkh3i",
      "tmux-idle-test-notify-1782133005851-kkh3i",
      "tmux-js-conf-session-1782133005851-kkh3i",
      "tmux-js-pstream-ps-1782133005851-kkh3i",
      "tmux-line-test-format-1782133005851-kkh3i",
      "tmux-js-demo-bench-1782133005851-kkh3i",
    ];
    const foreignSockets = ["default", "cmtest-44650", "imgtest-probe", "mreg", "collab"];

    for (const name of [...testSockets, ...foreignSockets]) seedSocket(name);

    const reaped = reapTestSockets({ dir: testDir, killServer: spyKill });

    expect(reaped.sort()).toEqual(testSockets.sort());
    expect(killed.sort()).toEqual(testSockets.sort());
    expect(surviving().sort()).toEqual(foreignSockets.sort());
  });

  it("returns empty and touches nothing when dir is absent", () => {
    const reaped = reapTestSockets({
      dir: join(testDir, "nonexistent"),
      killServer: spyKill,
    });
    expect(reaped).toEqual([]);
    expect(killed).toEqual([]);
  });

  it("returns empty when dir has no test sockets", () => {
    seedSocket("default");
    seedSocket("cmtest-12345");

    const reaped = reapTestSockets({ dir: testDir, killServer: spyKill });
    expect(reaped).toEqual([]);
    expect(killed).toEqual([]);
    expect(surviving().sort()).toEqual(["cmtest-12345", "default"]);
  });

  it("returns null dir gracefully (no POSIX uid env)", () => {
    const reaped = reapTestSockets({ dir: null, killServer: spyKill });
    expect(reaped).toEqual([]);
    expect(killed).toEqual([]);
  });

  it("calls killServer before unlinking — kill is attempted even for live daemons", () => {
    const order: string[] = [];
    seedSocket("tmux-js-test-foo-1234567890-abcde");

    reapTestSockets({
      dir: testDir,
      killServer: (name) => {
        order.push(`kill:${name}`);
      },
    });

    // kill was called, then file was removed
    expect(order).toEqual(["kill:tmux-js-test-foo-1234567890-abcde"]);
    expect(surviving()).toEqual([]);
  });
});
