#!/usr/bin/env node
// tmux-snapshot: save every pane's full scrollback, then browse it after the
// tmux server is gone.
//
//   cli.ts snapshot            capture the running tmux server
//   cli.ts list                list saved snapshots
//   cli.ts serve [--port N]    browse snapshots at http://127.0.0.1:N
//
// Snapshots live in $TMUX_SNAPSHOT_DIR, default ~/.tmux-snapshots.
// Exit codes: 0 ok, 1 failure, 2 snapshot saved but some panes failed to capture.

import { parseArgs } from 'node:util';
import { takeSnapshot } from './capture.ts';
import { startServer } from './server.ts';
import { defaultRoot, listSnapshotIds, readManifest } from './store.ts';

const USAGE = 'usage: cli.ts <snapshot | list | serve [--port N]>';

async function main(argv: readonly string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { port: { type: 'string', default: '7777' } },
  });
  const root = defaultRoot(process.env);

  switch (positionals[0]) {
    case 'snapshot': {
      const snap = await takeSnapshot(root, new Date(), (done, total) => {
        process.stderr.write(`\rcapturing panes ${done}/${total}`);
      });
      process.stderr.write('\n');
      const failed = snap.panes.filter((p) => !p.capture.ok);
      const lines = snap.panes.reduce((n, p) => n + (p.capture.ok ? p.capture.lines : 0), 0);
      console.log(
        `snapshot ${snap.id}: ${snap.sessions.length} sessions, ${snap.windows.length} windows, ` +
          `${snap.panes.length} panes, ${lines} lines -> ${root}/${snap.id}`,
      );
      for (const p of failed) console.error(`FAILED ${p.id}: ${p.capture.ok ? '' : p.capture.error}`);
      return failed.length === 0 ? 0 : 2;
    }
    case 'list': {
      const ids = await listSnapshotIds(root);
      if (ids.length === 0) console.log(`no snapshots in ${root}`);
      for (const id of ids) {
        const m = await readManifest(root, id);
        console.log(`${id}  ${m.sessions.length} sessions  ${m.panes.length} panes`);
      }
      return 0;
    }
    case 'serve': {
      const port = Number(values.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad --port: ${values.port}`);
      const { url } = await startServer(root, port);
      console.log(`browsing ${root} at ${url}`);
      return await new Promise<number>(() => undefined); // serve until killed
    }
    default:
      console.error(USAGE);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
