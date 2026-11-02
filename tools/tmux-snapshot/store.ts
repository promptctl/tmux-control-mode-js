// On-disk layout, owned here and nowhere else:
//
//   <root>/<id>/manifest.json      the Snapshot
//   <root>/<id>/panes/<n>.ansi     full scrollback of pane %<n>, raw SGR escapes
//
// The .ansi files are plain `cat`/`less -R`-able, so a snapshot stays readable
// without this tool.

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SNAPSHOT_ID_RE, paneFileStem, type Snapshot } from './model.ts';

export function defaultRoot(env: NodeJS.ProcessEnv): string {
  return env.TMUX_SNAPSHOT_DIR ?? join(homedir(), '.tmux-snapshots');
}

export interface SnapshotWriter {
  writePane(paneId: string, text: string): Promise<void>;
  commit(snapshot: Snapshot): Promise<void>;
}

/**
 * Writes into `<id>.partial` and renames on commit, so a snapshot that is listed
 * is always complete; a crash mid-capture leaves only an ignorable .partial dir.
 */
export async function openWriter(root: string, id: string): Promise<SnapshotWriter> {
  const finalDir = join(root, id);
  const workDir = `${finalDir}.partial`;
  await mkdir(join(workDir, 'panes'), { recursive: true });
  return {
    writePane: (paneId, text) => writeFile(join(workDir, 'panes', `${paneFileStem(paneId)}.ansi`), text),
    async commit(snapshot) {
      await writeFile(join(workDir, 'manifest.json'), JSON.stringify(snapshot, null, 2));
      await rename(workDir, finalDir);
    },
  };
}

/** Snapshot ids, newest first. */
export async function listSnapshotIds(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  return entries
    .filter((e) => e.isDirectory() && SNAPSHOT_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

export async function readManifest(root: string, id: string): Promise<Snapshot> {
  if (!SNAPSHOT_ID_RE.test(id)) throw new Error(`not a snapshot id: ${JSON.stringify(id)}`);
  return JSON.parse(await readFile(join(root, id, 'manifest.json'), 'utf8')) as Snapshot;
}

export function readPane(root: string, id: string, paneId: string): Promise<string> {
  if (!SNAPSHOT_ID_RE.test(id)) throw new Error(`not a snapshot id: ${JSON.stringify(id)}`);
  return readFile(join(root, id, 'panes', `${paneFileStem(paneId)}.ansi`), 'utf8');
}
