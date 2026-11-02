// Read-only HTTP viewer over the snapshot store. Binds loopback only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_ID_RE, type Snapshot } from './model.ts';
import { listSnapshotIds, readManifest, readPane } from './store.ts';
import { searchPanes } from './search.ts';

const WEB = new URL('./web/', import.meta.url);
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
const json = (res: ServerResponse, body: unknown): void =>
  send(res, 200, 'application/json', JSON.stringify(body));

async function route(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const asset = STATIC[url.pathname];
  if (asset !== undefined) {
    return send(res, 200, asset.type, await readFile(fileURLToPath(new URL(asset.file, WEB)), 'utf8'));
  }
  if (url.pathname === '/api/snapshots') return json(res, await listSnapshotIds(root));

  const m = /^\/api\/snapshots\/([^/]+)\/(manifest|search|pane\/(%\d+))$/.exec(
    decodeURIComponent(url.pathname),
  );
  if (m === null || !SNAPSHOT_ID_RE.test(m[1])) return send(res, 404, 'text/plain', 'not found');
  const [, id, kind, paneId] = m;

  if (kind === 'manifest') return json(res, await readManifest(root, id));
  if (kind === 'search') {
    const manifest: Snapshot = await readManifest(root, id);
    const query = url.searchParams.get('q') ?? '';
    return json(res, await searchPanes(manifest, (p) => readPane(root, id, p), query));
  }
  return send(res, 200, 'text/plain; charset=utf-8', await readPane(root, id, paneId));
}

export async function startServer(root: string, port: number): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    route(root, req, res).catch((err: NodeJS.ErrnoException) => {
      // [LAW:no-silent-failure] A missing snapshot/pane is a 404; anything else is a loud 500.
      const status = err.code === 'ENOENT' ? 404 : 500;
      if (status === 500) console.error(err);
      send(res, status, 'text/plain', err.message);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const addr = server.address();
  const bound = typeof addr === 'object' && addr !== null ? addr.port : port;
  return { server, url: `http://127.0.0.1:${bound}` };
}
