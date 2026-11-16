// tests/integration/line-correlation.test.ts
// Real-tmux integration tests for lines tmux answers with more or fewer than
// one reply block (tmux-server-events-6sp.0sl): a `;` list, if-shell,
// source-file, `%hidden`. Each execute() settles with its own line's reply,
// whatever the line expands to, and the sentinel that ends every line runs
// nothing in tmux and reaches no listener (SPEC.md §5.6).
//
// [LAW:verifiable-goals] Gated behind TMUX_INTEGRATION=1, same convention as
// tests/integration/client.test.ts.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { spawnTmux } from "../../src/transport/spawn.js";
import { killTmuxServer } from "../helpers/reap-test-sockets.js";
import { uniqueSocket, waitReady, tmux } from "../helpers/integration.js";
import { TmuxClient } from "../../src/client.js";
import { TmuxCommandError } from "../../src/errors.js";

const RUN_INTEGRATION = process.env.TMUX_INTEGRATION === "1";

describe.skipIf(!RUN_INTEGRATION)(
  "a line's reply is its own, however many blocks tmux writes (real tmux)",
  { timeout: 15000 },
  () => {
    let socketName: string;
    let client: TmuxClient;
    let dir: string;

    beforeEach(async () => {
      socketName = uniqueSocket("tmux-js-test-", "line");
      dir = mkdtempSync(join(tmpdir(), "tmux-js-line-"));
      tmux(socketName, ["new-session", "-d", "-s", "a"]);
      client = new TmuxClient(
        spawnTmux(["-f", "/dev/null", "attach-session", "-t", "=a"], {
          socketPath: socketName,
        }),
      );
      await waitReady(client);
    });

    afterEach(() => {
      client.close();
      killTmuxServer(socketName);
      rmSync(dir, { recursive: true, force: true });
    });

    it("a `;` list and a concurrent call each get their own reply", async () => {
      const [list, next] = await Promise.all([
        client.execute("display-message -p a ; display-message -p b"),
        client.execute("display-message -p c"),
      ]);

      expect(list.output).toEqual(["a", "b"]);
      expect(next.output).toEqual(["c"]);
    });

    it("a list whose middle command fails rejects with that failure; the concurrent call is untouched", async () => {
      const list = client.execute(
        "display-message -p a ; kill-session -t =nope ; display-message -p c",
      );
      const next = client.execute("display-message -p d");

      await expect(list).rejects.toBeInstanceOf(TmuxCommandError);
      await expect(list).rejects.toThrow("can't find session: nope");
      expect((await next).output).toEqual(["d"]);
    });

    it("if-shell and source-file resolve with what the commands they ran wrote", async () => {
      const file = join(dir, "two.conf");
      writeFileSync(file, "display-message -p one\ndisplay-message -p two\n");

      const [ifShell, sourced, next] = await Promise.all([
        client.execute(`if-shell -F 1 "display-message -p c"`),
        client.execute(`source-file ${file}`),
        client.execute("display-message -p e"),
      ]);

      expect(ifShell.output).toEqual(["c"]);
      expect(sourced.output).toEqual(["one", "two"]);
      expect(next.output).toEqual(["e"]);
    });

    it("a line tmux runs no command for resolves empty, and takes no other caller's reply", async () => {
      const [hidden, comment, next] = await Promise.all([
        client.execute("%hidden X=1"),
        client.execute("# a note"),
        client.execute("display-message -p f"),
      ]);

      expect(hidden).toMatchObject({ output: [], success: true });
      expect(comment).toMatchObject({ output: [], success: true });
      expect(next.output).toEqual(["f"]);
    });

    it("a line tmux cannot parse rejects with the parse error and leaves the next line alone", async () => {
      const broken = client.execute("if-shell true {");
      const next = client.execute("display-message -p g");

      await expect(broken).rejects.toThrow("parse error: syntax error");
      expect((await next).output).toEqual(["g"]);
    });

    it("the sentinel runs nothing in tmux and reaches no listener", async () => {
      tmux(socketName, ["set-hook", "-g", "command-error", "set -g @fired 1"]);
      const guards: string[] = [];
      client.on("*", (ev) => {
        if (ev.type === "begin" || ev.type === "end" || ev.type === "error") {
          guards.push(ev.type);
        }
      });

      await client.execute("display-message -p h");

      expect(guards).toEqual(["begin", "end"]);
      expect(tmux(socketName, ["show-options", "-gqv", "@fired"]).trim()).toBe(
        "",
      );
    });
  },
);
