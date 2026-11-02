/* global document, fetch, Option */
// Browser side of the snapshot viewer. All text reaches the DOM via textContent,
// never innerHTML: scrollback is untrusted terminal output.

const $ = (id) => document.getElementById(id);
const api = (path) => fetch(`/api/snapshots${path}`).then((r) => {
  if (!r.ok) throw new Error(`${path}: ${r.status} ${r.statusText}`);
  return r;
});

// ---- ANSI SGR -> styled spans -------------------------------------------------

const BASE16 = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];

function color256(n) {
  if (n < 16) return BASE16[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const i = n - 16, lv = (x) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${lv(Math.floor(i / 36))},${lv(Math.floor(i / 6) % 6)},${lv(i % 6)})`;
}

const NO_STYLE = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false };

function applySgr(style, params) {
  const s = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) Object.assign(s, NO_STYLE);
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 7) s.inverse = true;
    else if (p === 9) s.strike = true;
    else if (p === 22) { s.bold = false; s.dim = false; }
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 27) s.inverse = false;
    else if (p === 29) s.strike = false;
    else if (p >= 30 && p <= 37) s.fg = BASE16[p - 30];
    else if (p >= 90 && p <= 97) s.fg = BASE16[p - 90 + 8];
    else if (p >= 40 && p <= 47) s.bg = BASE16[p - 40];
    else if (p >= 100 && p <= 107) s.bg = BASE16[p - 100 + 8];
    else if (p === 39) s.fg = null;
    else if (p === 49) s.bg = null;
    else if (p === 38 || p === 48) {
      const key = p === 38 ? 'fg' : 'bg';
      if (params[i + 1] === 5) { s[key] = color256(params[i + 2] ?? 0); i += 2; }
      else if (params[i + 1] === 2) { s[key] = `rgb(${params[i + 2] ?? 0},${params[i + 3] ?? 0},${params[i + 4] ?? 0})`; i += 4; }
    }
  }
  return s;
}

function styleCss(s) {
  const fg = s.inverse ? (s.bg ?? '#0f1012') : s.fg;
  const bg = s.inverse ? (s.fg ?? '#d4d4d4') : s.bg;
  return [fg && `color:${fg}`, bg && `background:${bg}`, s.bold && 'font-weight:700', s.dim && 'opacity:.6',
    s.italic && 'font-style:italic',
    (s.underline || s.strike) && `text-decoration:${[s.underline && 'underline', s.strike && 'line-through'].filter(Boolean).join(' ')}`,
  ].filter(Boolean).join(';');
}

// Style carries across lines, as it does in a terminal.
function renderLines(text) {
  const frag = document.createDocumentFragment();
  // eslint-disable-next-line no-control-regex -- matching ESC is the point
  const csi = /\x1b\[([0-9;:?]*)([ -/]*[@-~])/g;
  let style = NO_STYLE;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  lines.forEach((line, idx) => {
    const div = document.createElement('div');
    div.dataset.line = String(idx + 1);
    let last = 0;
    const emit = (chunk) => {
      if (chunk === '') return;
      const span = document.createElement('span');
      span.textContent = chunk;
      const css = styleCss(style);
      if (css) span.style.cssText = css;
      div.append(span);
    };
    for (const m of line.matchAll(csi)) {
      emit(line.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[2] === 'm') style = applySgr(style, m[1] === '' ? [0] : m[1].split(/[;:]/).map(Number));
    }
    emit(line.slice(last));
    frag.append(div);
  });
  return frag;
}

// ---- state + views ----------------------------------------------------------

let snapshotId = null;
let manifest = null;
let selectedPane = null;

function paneLabel(p) {
  const dir = p.cwd.split('/').filter(Boolean).pop() ?? '/';
  const lines = p.capture.ok ? `${p.capture.lines} lines` : 'CAPTURE FAILED';
  return [`${p.id} ${p.command}`, `${dir} · ${lines}`];
}

function renderTree() {
  const filter = $('filter').value.toLowerCase();
  const panes = new Map(manifest.panes.map((p) => [p.id, p]));
  const windows = new Map(manifest.windows.map((w) => [w.id, w]));
  const tree = $('tree');
  tree.replaceChildren();
  for (const s of manifest.sessions) {
    const rows = [];
    for (const sw of s.windows) {
      const w = windows.get(sw.windowId);
      for (const pid of w.paneIds) {
        const p = panes.get(pid);
        const hay = `${s.name} ${w.name} ${p.command} ${p.cwd} ${p.title}`.toLowerCase();
        if (hay.includes(filter)) rows.push({ sw, w, p });
      }
    }
    if (rows.length === 0) continue;
    const head = document.createElement('div');
    head.className = 'session';
    head.textContent = s.name;
    if (s.group) { const g = document.createElement('small'); g.textContent = `  group ${s.group}`; head.append(g); }
    tree.append(head);
    let lastWin = null;
    for (const { sw, w, p } of rows) {
      if (lastWin !== w.id) {
        const wd = document.createElement('div');
        wd.className = 'window';
        wd.textContent = `${sw.index}: ${w.name}`;
        tree.append(wd);
        lastWin = w.id;
      }
      const row = document.createElement('div');
      row.className = `pane${p.id === selectedPane ? ' sel' : ''}`;
      const [a, b] = paneLabel(p);
      row.textContent = `${a} `;
      const small = document.createElement('small');
      small.textContent = b;
      row.append(small);
      row.onclick = () => openPane(p.id);
      tree.append(row);
    }
  }
}

async function openPane(paneId, line) {
  selectedPane = paneId;
  const p = manifest.panes.find((x) => x.id === paneId);
  const meta = $('meta');
  meta.className = '';
  meta.replaceChildren();
  const b = document.createElement('b');
  b.textContent = `${p.id} ${p.command}`;
  meta.append(b, ` — ${p.cwd} — ${p.width}×${p.height}, ${p.historyLines} history rows`);
  if (p.alternateScreen) meta.append(' — was on alternate screen (full-screen app)');
  if (p.title) meta.append(` — title: ${p.title}`);
  const screen = $('screen');
  if (!p.capture.ok) {
    screen.replaceChildren(Object.assign(document.createElement('div'), { textContent: `capture failed: ${p.capture.error}` }));
  } else {
    screen.replaceChildren(renderLines(await (await api(`/${snapshotId}/pane/${encodeURIComponent(paneId)}`)).text()));
    const target = line ? screen.querySelector(`[data-line="${line}"]`) : null;
    if (target) { target.classList.add('flash'); target.scrollIntoView({ block: 'center' }); }
    else screen.scrollTop = screen.scrollHeight; // newest output first
  }
  renderTree();
}

async function runSearch() {
  const q = $('q').value;
  const results = $('results');
  if (q === '') { results.hidden = true; $('tree').hidden = false; return; }
  const { hits, truncated } = await (await api(`/${snapshotId}/search?q=${encodeURIComponent(q)}`)).json();
  results.replaceChildren();
  $('tree').hidden = true;
  results.hidden = false;
  const summary = document.createElement('div');
  summary.className = 'note';
  summary.textContent = `${hits.length}${truncated ? '+' : ''} matching lines`;
  results.append(summary);
  const panes = new Map(manifest.panes.map((p) => [p.id, p]));
  for (const h of hits) {
    const p = panes.get(h.paneId);
    const row = document.createElement('div');
    row.className = 'hit';
    const where = document.createElement('b');
    where.textContent = `${h.paneId} ${p.command} :${h.line}`;
    const text = document.createElement('span');
    text.textContent = h.text;
    row.append(where, text);
    row.onclick = () => openPane(h.paneId, h.line);
    results.append(row);
  }
}

async function loadSnapshot(id) {
  snapshotId = id;
  manifest = await (await api(`/${id}/manifest`)).json();
  selectedPane = null;
  renderTree();
}

async function init() {
  const ids = await (await api('')).json();
  const sel = $('snap');
  if (ids.length === 0) { $('meta').textContent = 'No snapshots found.'; return; }
  for (const id of ids) sel.append(new Option(id, id));
  sel.onchange = () => loadSnapshot(sel.value);
  $('filter').oninput = renderTree;
  $('q').onkeydown = (e) => { if (e.key === 'Enter') runSearch(); };
  await loadSnapshot(ids[0]);
}

init().catch((err) => { $('meta').textContent = `error: ${err.message}`; });
