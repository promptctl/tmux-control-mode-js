// tests/unit/commands-list-records.test.ts
// listWindows/listPanes/listSessions against a fake TmuxConnection: a reply
// whose every line parses resolves its records, and one line the parser
// cannot read rejects the whole list. The line grammar itself is covered in
// pane-output.test.ts; what real tmux sends, in tests/integration/client.test.ts.

import { describe, it, expect } from "vitest";
import type { TmuxConnection } from "../../src/client.js";
import type { CommandResponse } from "../../src/protocol/types.js";
import {
  listPanes,
  listSessions,
  listWindows,
} from "../../src/commands/index.js";
import {
  listPanesCommand,
  listSessionsCommand,
  listWindowsCommand,
} from "../../src/protocol/encoder.js";
import { TmuxReplyFormatError } from "../../src/errors.js";

function replying(output: readonly string[]): TmuxConnection {
  const client: Pick<TmuxConnection, "execute"> = {
    execute: (): Promise<CommandResponse> =>
      Promise.resolve({
        commandNumber: 1,
        timestamp: Date.now(),
        output,
        success: true,
      }),
  };
  return client as TmuxConnection;
}

const LISTS = [
  {
    list: listWindows,
    command: listWindowsCommand(),
    line: "$1\tmain\t@0\tzsh\t80\t24",
  },
  {
    list: listPanes,
    command: listPanesCommand(),
    line: "$1\tmain\t@0\tzsh\t%0\t0\t/tmp\t123\tzsh\tzsh\t80\t24",
  },
  {
    list: listSessions,
    command: listSessionsCommand(),
    line: "$1\tmain\t3\t0",
  },
] as const;

describe.each(LISTS)("$command", ({ list, command, line }) => {
  it("resolves one record per reply line", async () => {
    await expect(list(replying([line, line]))).resolves.toHaveLength(2);
  });

  it("resolves no records for an empty reply", async () => {
    await expect(list(replying([]))).resolves.toEqual([]);
  });

  it("rejects with TmuxReplyFormatError, carrying the command and reply, when one line does not parse", async () => {
    const output = [line, `${line}\textra`];
    const attempt = list(replying(output));
    await expect(attempt).rejects.toBeInstanceOf(TmuxReplyFormatError);
    await expect(attempt).rejects.toMatchObject({ command, output });
  });
});
