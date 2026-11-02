// Takes a snapshot of a live tmux server. This is the effect edge: it runs tmux
// and writes the store. Everything it decides comes from model.ts.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PANE_ROWS_FORMAT,
  countLines,
  parseTopology,
  snapshotId,
  type PaneRecord,
  type Snapshot,
} from './model.ts';
import { openWriter } from './store.ts';

const run = promisify(execFile);

// Scrollback of 100k lines of colored output can exceed the 1 MiB default.
const MAX_BUFFER = 512 * 1024 * 1024;
const CONCURRENCY = 8;

async function tmux(args: readonly string[]): Promise<string> {
  const { stdout } = await run('tmux', [...args], { maxBuffer: MAX_BUFFER, encoding: 'utf8' });
  return stdout;
}

/**
 * Entire history plus visible screen, with SGR escapes (-e) and soft-wrapped
 * lines joined (-J) so a long command or URL stays one searchable line.
 */
function capturePane(paneId: string): Promise<string> {
  return tmux(['capture-pane', '-p', '-e', '-J', '-S', '-', '-E', '-', '-t', paneId]);
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function takeSnapshot(
  root: string,
  now: Date,
  onProgress: (done: number, total: number) => void,
): Promise<Snapshot> {
  // [LAW:no-silent-failure] No server / unparsable output throws here, before
  // anything is written; only per-pane capture failures are recorded in the manifest.
  const tmuxVersion = (await tmux(['-V'])).trim();
  const topology = parseTopology(await tmux(['list-panes', '-a', '-F', PANE_ROWS_FORMAT]));
  if (topology.panes.length === 0) throw new Error('tmux server has no panes to snapshot');

  const writer = await openWriter(root, snapshotId(now));
  let done = 0;
  const panes = await mapLimited(topology.panes, CONCURRENCY, async (pane): Promise<PaneRecord> => {
    let capture: PaneRecord['capture'];
    try {
      const text = await capturePane(pane.id);
      await writer.writePane(pane.id, text);
      capture = { ok: true, bytes: Buffer.byteLength(text), lines: countLines(text) };
    } catch (err) {
      capture = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    onProgress(++done, topology.panes.length);
    return { ...pane, capture };
  });

  const snapshot: Snapshot = {
    version: 1,
    id: snapshotId(now),
    takenAt: now.toISOString(),
    tmuxVersion,
    sessions: topology.sessions,
    windows: topology.windows,
    panes,
  };
  await writer.commit(snapshot);
  return snapshot;
}
