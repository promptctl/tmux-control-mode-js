// Case-insensitive substring search across the captured scrollback of a snapshot.

import type { Snapshot } from './model.ts';

// SGR and other CSI sequences; the only escapes `capture-pane -e` emits.
// eslint-disable-next-line no-control-regex -- matching ESC is the point
const CSI =/\x1b\[[0-9;:?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string): string => s.replace(CSI, '');

export interface SearchHit {
  readonly paneId: string;
  /** 1-based line number within the pane's capture. */
  readonly line: number;
  readonly text: string;
}

export interface SearchResult {
  readonly hits: readonly SearchHit[];
  readonly truncated: boolean;
}

const MAX_HITS = 500;

export async function searchPanes(
  snapshot: Snapshot,
  read: (paneId: string) => Promise<string>,
  query: string,
): Promise<SearchResult> {
  const needle = query.toLowerCase();
  if (needle === '') return { hits: [], truncated: false };
  const hits: SearchHit[] = [];
  for (const pane of snapshot.panes) {
    if (!pane.capture.ok) continue;
    const lines = stripAnsi(await read(pane.id)).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      if (hits.length === MAX_HITS) return { hits, truncated: true };
      hits.push({ paneId: pane.id, line: i + 1, text: lines[i].trim().slice(0, 300) });
    }
  }
  return { hits, truncated: false };
}
