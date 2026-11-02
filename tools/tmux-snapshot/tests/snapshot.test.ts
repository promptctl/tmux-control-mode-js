import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PANE_ROWS_FORMAT, countLines, paneFileStem, parseTopology, snapshotId } from '../model.ts';
import { searchPanes, stripAnsi } from '../search.ts';
import { listSnapshotIds, openWriter, readManifest, readPane } from '../store.ts';

const row = (...o: Partial<Record<string, string>>[]): string => {
  const base: Record<string, string> = {
    session_id: '$1', session_name: 'a', session_group: '', session_attached: '0', session_created: '1',
    window_id: '@1', window_index: '0', window_name: 'w', window_layout: 'L', window_active: '1',
    pane_id: '%1', pane_width: '80', pane_height: '24', pane_pid: '10', pane_current_command: 'zsh',
    pane_current_path: '/tmp', pane_title: 't', history_size: '5', alternate_on: '0',
  };
  const merged = Object.assign({}, base, ...o) as Record<string, string>;
  // field order is the format's order
  return [...PANE_ROWS_FORMAT.matchAll(/#\{(\w+)\}/g)].map((m) => merged[m[1]]).join('\t');
};

test('grouped sessions share windows and panes: deduplicated by id, listed per session', () => {
  const t = parseTopology(
    [
      row({}),
      row({ session_id: '$2', session_name: 'view', session_group: 'a' }), // same window+pane via group
      row({ pane_id: '%2', pane_title: 'second' }),
    ].join('\n') + '\n',
  );
  assert.deepEqual(t.sessions.map((s) => [s.name, s.windows.length]), [['a', 1], ['view', 1]]);
  assert.equal(t.sessions[1].group, 'a');
  assert.equal(t.windows.length, 1);
  assert.deepEqual(t.windows[0].paneIds, ['%1', '%2']);
  assert.equal(t.panes.length, 2);
});

test('a row with the wrong field count fails loudly instead of shifting columns', () => {
  assert.throws(() => parseTopology('a\tb\n'), /expected \d+ tab-separated fields/);
});

test('non-integer numeric fields fail loudly', () => {
  assert.throws(() => parseTopology(row({ pane_pid: 'x' })), /pane_pid is not an integer/);
});

test('pane ids map to file stems only when they are tmux pane ids', () => {
  assert.equal(paneFileStem('%12'), '12');
  assert.throws(() => paneFileStem('../x'));
});

test('countLines ignores the trailing newline', () => {
  assert.deepEqual([countLines(''), countLines('a'), countLines('a\n'), countLines('a\nb\n')], [0, 1, 1, 2]);
});

test('snapshotId is sortable UTC', () => {
  assert.equal(snapshotId(new Date('2026-11-01T12:34:56.789Z')), '20261101T123456Z');
});

test('stripAnsi removes SGR but keeps text', () => {
  assert.equal(stripAnsi('\x1b[1;31mred\x1b[0m plain \x1b[38;5;200mx\x1b[m'), 'red plain x');
});

test('store: only committed snapshots are listed; panes round-trip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'snap-'));
  const partial = await openWriter(root, '20260101T000000Z');
  await partial.writePane('%1', 'never committed');
  assert.deepEqual(await listSnapshotIds(root), []);

  const w = await openWriter(root, '20260102T000000Z');
  await w.writePane('%1', '\x1b[31mhello needle\x1b[0m\nbye\n');
  const t = parseTopology(row({}));
  const snap = {
    version: 1 as const, id: '20260102T000000Z', takenAt: 'x', tmuxVersion: 'tmux 3.8', ...t,
    panes: t.panes.map((p) => ({ ...p, capture: { ok: true as const, bytes: 1, lines: 2 } })),
  };
  await w.commit(snap);

  assert.deepEqual(await listSnapshotIds(root), ['20260102T000000Z']);
  assert.deepEqual(await readManifest(root, snap.id), snap);
  assert.match(await readPane(root, snap.id, '%1'), /hello needle/);
  assert.deepEqual(await readdir(join(root, snap.id)), ['manifest.json', 'panes']);
  await assert.rejects(readManifest(root, '../../etc'), /not a snapshot id/);
});

test('search matches case-insensitively on stripped text, skips failed panes, reports line numbers', async () => {
  const t = parseTopology([row({}), row({ pane_id: '%2' })].join('\n'));
  const snap = {
    version: 1 as const, id: 'i', takenAt: 'x', tmuxVersion: 'v', ...t,
    panes: [
      { ...t.panes[0], capture: { ok: true as const, bytes: 1, lines: 2 } },
      { ...t.panes[1], capture: { ok: false as const, error: 'gone' } },
    ],
  };
  const r = await searchPanes(snap, async () => 'one\n\x1b[1mNeEdLe\x1b[0m here\n', 'needle');
  assert.deepEqual(r, { hits: [{ paneId: '%1', line: 2, text: 'NeEdLe here' }], truncated: false });
});
