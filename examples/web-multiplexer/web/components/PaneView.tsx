// examples/web-multiplexer/web/components/PaneView.tsx
//
// The current window, live: the library's `<WindowTerminal>` over the demo's
// bridge adapter. Layout, zoom, seeding, keys and sizing are the library's;
// the demo picks the window and the font size (the − / + above it). The
// window is the person's own
// tmux window, so the page follows tmux's size and declares none.
//
// [LAW:single-enforcer] `store.paneStreamClient` is the one adapter per
//   bridge; every terminal on the page shares it.
// [LAW:one-source-of-truth] The demo's keymap acts on tmux's active pane, so
//   tmux's active pane is the one answer to "which pane am I in": a click
//   (this page's focus moving) selects that pane in tmux, and tmux's active
//   pane moving (a chord, another client) moves this page's focus there. The
//   library keeps the two apart on purpose, for a watcher whose keys must not
//   follow another client's select-pane; this page is the person's own client.

import { useCallback, useMemo, useRef, useState, type ElementRef } from "react";
import { observer } from "mobx-react-lite";
import { ActionIcon, Chip, Group, Text, Tooltip } from "@mantine/core";
import type {
  WindowTerminalError,
  WindowTerminalState,
  XtermAddons,
  XtermOptions,
} from "@promptctl/tmux-control-mode-js/window-terminal";
import { WindowTerminal } from "@promptctl/tmux-control-mode-js/window-terminal/react";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import type { DemoStore } from "../store.ts";
import type { UiStore } from "../ui-store.ts";

const FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace';

// A page holds a few WebGL contexts at most, and the browser takes the
// oldest when a pane wants one more (or the GPU resets). A pane whose context
// is lost goes back to xterm's DOM renderer, which the window then lays out.
const webglAddon = (): WebglAddon => {
  const addon = new WebglAddon();
  addon.onContextLoss(() => addon.dispose());
  return addon;
};

interface Props {
  readonly store: DemoStore;
  readonly uiStore: UiStore;
}

interface Seen {
  // The terminal that saw it: a new one (the WebGL switch) sees its first
  // window arrive.
  readonly mount: string;
  readonly window: string;
  readonly focus: string;
  // tmux's active pane once the layout holds it: tmux names a new pane active
  // before the layout that holds it arrives.
  readonly shown: string | null;
}

export const PaneView = observer(function PaneView({ store, uiStore }: Props) {
  const win = store.currentWindow;
  const font = uiStore.terminalFontSize;
  const sizing = useMemo(
    () => ({ window: "tmux" as const, font, fit: "none" as const }),
    [font],
  );
  const terminal = useRef<ElementRef<typeof WindowTerminal>>(null);
  // A link clicked in a pane: an OSC 8 link of any scheme (a statusline's
  // `cc-candybar://…`) or a plain URL. The page shows it. Only a plain URL
  // opens: its text is the link, where an OSC 8 link's text can be anything.
  const [lastLink, setLastLink] = useState<string | null>(null);
  // The panes draw with xterm's DOM renderer, or with WebGL. Addons are read
  // at mount, so a switch mounts the terminal again.
  const [webgl, setWebgl] = useState(false);
  const { xterm, addons } = useMemo(() => {
    const show = (_: MouseEvent, uri: string): void => setLastLink(uri);
    const open = (ev: MouseEvent, uri: string): void => {
      show(ev, uri);
      window.open(uri, "_blank", "noopener");
    };
    const options: XtermOptions = {
      fontFamily: FONT_FAMILY,
      linkHandler: { allowNonHttpProtocols: true, activate: show },
    };
    const factory: XtermAddons = () => [
      new WebLinksAddon(open),
      ...(webgl ? [webglAddon()] : []),
    ];
    return { xterm: options, addons: factory };
  }, [webgl]);
  const mount = webgl ? "webgl" : "dom";
  // What the terminal reports it could not do (a pane whose WebGL could not
  // start opens as an empty box): shown, until the terminal mounts again.
  const [error, setError] = useState<WindowTerminalError | null>(null);
  const seen = useRef<Seen | null>(null);
  const onState = useCallback(
    (s: WindowTerminalState) => {
      if (s.phase !== "live") return;
      const { id, active, focus, panes } = s.window;
      const shown = panes.some((p) => p.id === active) ? active : null;
      const prev = seen.current;
      seen.current = { mount, window: id, focus, shown };
      if (prev?.mount !== mount || prev.window !== id || shown !== prev.shown) {
        // A window arriving (a switch remounts the terminal), or tmux's
        // active pane moving: the keyboard goes there. Nothing else moves
        // it, so a click waiting on tmux's answer is not pulled back.
        if (shown !== null && focus !== shown) terminal.current?.focus(shown);
      } else if (focus !== prev.focus && focus !== active) {
        // A click: tmux selects that pane.
        const pane = store.currentWindow?.panes.find(
          (p) => `%${p.id}` === focus,
        );
        if (pane !== undefined) store.selectPane(pane);
      }
    },
    [store, mount],
  );
  if (win === null) return null;
  return (
    <>
      <Group gap={4} justify="flex-end" wrap="nowrap">
        {error !== null && (
          <Text
            size="xs"
            c="red"
            ff="monospace"
            truncate
            mr="auto"
            data-testid="terminal-error"
          >
            {error.paneId ?? error.windowId} {error.seam}: {String(error.cause)}
          </Text>
        )}
        {lastLink !== null && (
          <Text
            size="xs"
            c="dimmed"
            ff="monospace"
            truncate
            mr="auto"
            data-testid="last-link"
          >
            {lastLink}
          </Text>
        )}
        <Chip
          size="xs"
          checked={webgl}
          onChange={(on) => {
            setError(null);
            setWebgl(on);
          }}
        >
          WebGL
        </Chip>
        <Tooltip label="Smaller font">
          <ActionIcon
            size="xs"
            variant="default"
            onClick={() => uiStore.decreaseTerminalFontSize()}
          >
            −
          </ActionIcon>
        </Tooltip>
        <Text size="xs" c="dimmed" ff="monospace" miw={30} ta="center">
          {font}px
        </Text>
        <Tooltip label="Larger font">
          <ActionIcon
            size="xs"
            variant="default"
            onClick={() => uiStore.increaseTerminalFontSize()}
          >
            +
          </ActionIcon>
        </Tooltip>
      </Group>
      <WindowTerminal
        key={mount}
        ref={terminal}
        className="demo-window-terminal"
        connection={store.paneStreamClient}
        window={`@${win.id}`}
        sizing={sizing}
        xterm={xterm}
        addons={addons}
        onState={onState}
        onError={setError}
      />
    </>
  );
});
