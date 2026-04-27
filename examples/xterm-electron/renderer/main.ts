// examples/xterm-electron/renderer/main.ts
// Renderer-process entry. Runs under contextIsolation + sandbox — no Node
// access. Uses window.tmuxIpc (exposed by preload.ts) to talk to the main
// process via the library's IPC bridge.

import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { createRendererBridge } from "@promptctl/tmux-control-mode-js/electron/renderer";

const statusEl = document.getElementById("status") as HTMLElement;
const terminalEl = document.getElementById("terminal") as HTMLElement;

function setStatus(text: string): void {
  statusEl.textContent = text;
}

async function run(): Promise<void> {
  const proxy = createRendererBridge(window.tmuxIpc);

  const term = new Terminal({
    fontFamily: "Menlo, Consolas, monospace",
    fontSize: 14,
    cursorBlink: true,
    scrollback: 5000,
    theme: {
      background: "#0b1120",
      foreground: "#e2e8f0",
      cursor: "#f59e0b",
    },
  });
  term.open(terminalEl);

  // Pick the first pane of the session. The parser correctly routes
  // %-prefixed lines inside a response block as command output (per
  // SPEC_MANIFEST §4: notifications never appear inside a response block),
  // so a bare `%N` pane id from `list-panes -F '#{pane_id}'` arrives
  // verbatim in `paneList.output`.
  setStatus("discovering panes…");
  const paneList = await proxy.execute('list-panes -F "#{pane_id}"');
  const firstPane = paneList.output[0];
  if (firstPane === undefined || !/^%\d+$/.test(firstPane)) {
    setStatus(`no pane found (got: ${JSON.stringify(paneList.output)})`);
    return;
  }
  const paneId = Number.parseInt(firstPane.slice(1), 10);
  setStatus(`attached to pane ${firstPane}`);

  // Forward live tmux output for this pane to xterm.
  proxy.on("output", (ev) => {
    if (ev.paneId !== paneId) return;
    term.write(ev.data);
  });
  proxy.on("extended-output", (ev) => {
    if (ev.paneId !== paneId) return;
    term.write(ev.data);
  });

  // Forward xterm keystrokes to tmux.
  term.onData((data) => {
    void proxy.sendKeys(firstPane, data);
  });

  // Seed with the pane's current visible contents.
  const capture = await proxy.execute(
    `capture-pane -e -p -S - -t ${firstPane}`,
  );
  if (capture.output.length > 0) {
    term.write(capture.output.join("\r\n") + "\r\n");
  }

  // Report any disconnect (tmux exited, socket gone, etc.).
  proxy.on("exit", (ev) => {
    setStatus(`tmux exited${ev.reason !== undefined ? `: ${ev.reason}` : ""}`);
  });

  term.focus();
}

run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  setStatus(`error: ${msg}`);
  // eslint-disable-next-line no-console
  console.error(err);
});
