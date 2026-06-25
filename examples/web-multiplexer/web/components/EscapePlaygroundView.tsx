// examples/web-multiplexer/web/components/EscapePlaygroundView.tsx
//
// Escape-code playground — type or paste ANSI/escape sequences and watch a real
// tmux pane render them, with the raw bytes and the parsed events shown side by
// side. The three columns are the same data at three altitudes:
//
//   Raw bytes      what `send-keys -H` puts on the wire (UTF-8 of the input)
//   Parsed events  the pure engine's classification of those bytes
//   Rendered cells  the live scratch pane those bytes were sent to
//
// THE HEADLINE: this is the only demo that exercises the *outbound* path. The
// library's `sendKeys` encodes via `send-keys -H utf8HexBytes(s)`, so every byte
// — ESC, C0 controls, the lot — arrives byte-for-byte. The round-trip you watch
// here is the proof of that input fidelity.
//
// [LAW:dataflow-not-control-flow] Columns 1 and 2 are a pure projection of the
//   input text through `analyze`; "no input" is the empty-analysis case, not a
//   skipped branch. The store owns the pane and the send; the view owns only the
//   ephemeral composition and the layout.

import { useEffect, useMemo, useRef } from "react";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import {
  Stack,
  Group,
  Paper,
  Text,
  Badge,
  Button,
  Textarea,
  ScrollArea,
  Code,
  Loader,
} from "@mantine/core";
import { mountPaneTerminal } from "@promptctl/pane-terminal/vanilla";
import type { XtermSink } from "@promptctl/pane-terminal/xterm-sink";
import type { DemoStore } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import type { EscapePlaygroundStore } from "../escape-playground-store.ts";
import { ObservablePaneStream } from "../pane-stream-bridge.ts";
import {
  analyze,
  type EscapeEvent,
  type SgrToken,
} from "../escape-parse-engine.ts";

// Mirrors PaneView's font: the xterm fontFamily and the font-load probe must
// agree, and this view mounts its own XtermSink. [LAW:one-source-of-truth] the
// drift risk here is purely cosmetic (which monospace face renders).
const FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace';

interface Props {
  readonly demoStore: DemoStore;
  readonly store: EscapePlaygroundStore;
  readonly uiStore: UiStore;
}

/** Visually compelling, copy-pasteable starting points. */
const PRESETS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "SGR colors", value: "\\e[31mred \\e[32mgreen \\e[34mblue\\e[0m" },
  {
    label: "bold + underline",
    value: "\\e[1mbold\\e[0m \\e[4munderline\\e[0m \\e[7mreverse\\e[0m",
  },
  {
    label: "256-color",
    value: "\\e[38;5;208m■ orange\\e[0m \\e[38;5;82m■ lime\\e[0m",
  },
  {
    label: "truecolor",
    value: "\\e[38;2;255;105;180mhot pink\\e[0m",
  },
  {
    label: "cursor + clear",
    value: "\\e[2J\\e[3;6Hpositioned at row 3, col 6",
  },
  {
    label: "box drawing",
    value:
      "\\u250c\\u2500\\u2500\\u2510\\r\\n\\u2502  \\u2502\\r\\n\\u2514\\u2500\\u2500\\u2518",
  },
];

const KIND_COLOR: Readonly<Record<EscapeEvent["kind"], string>> = {
  text: "gray",
  c0: "blue",
  csi: "grape",
  osc: "teal",
  esc: "cyan",
  string: "orange",
  incomplete: "red",
};

export const EscapePlaygroundView = observer(function EscapePlaygroundView({
  demoStore,
  store,
  uiStore,
}: Props) {
  const [input, setInput] = useState<string>(PRESETS[0].value);

  // [LAW:dataflow-not-control-flow] One analysis drives both data columns AND
  // the bytes sent — `analyze(input)` is the single derivation.
  const analysis = useMemo(() => analyze(input), [input]);

  const ready = demoStore.connState === "ready";
  const canSend =
    ready && store.status === "ready" && analysis.bytes.length > 0;

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Paper withBorder p="xs">
        <Group gap="md" wrap="wrap">
          <Text fw={600} size="sm">
            Escape-Code Playground
          </Text>
          <Text size="xs" c="dimmed">
            type escape sequences → sent to a scratch pane via{" "}
            <Code>send-keys -H</Code> → rendered live
          </Text>
          <StatusBadge store={store} ready={ready} />
          {store.lastSentBytes !== null && (
            <Badge variant="light" color="gray">
              sent {store.lastSentBytes} bytes
            </Badge>
          )}
          {store.errorMsg !== null && (
            <Text size="xs" c="red">
              {store.errorMsg}
            </Text>
          )}
        </Group>
      </Paper>

      <Paper withBorder p="xs">
        <Group align="flex-start" gap="sm" wrap="nowrap">
          <Textarea
            label="Input — supports \e \x1b \033 \n \r \t \uHHHH"
            value={input}
            onChange={(e) => setInput(e.currentTarget.value)}
            autosize
            minRows={2}
            maxRows={4}
            spellCheck={false}
            style={{ flex: 1 }}
            styles={{
              input: { fontFamily: "var(--mantine-font-family-monospace)" },
            }}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter sends — Enter alone inserts a newline so the
              // user can compose multi-line input (e.g. box drawing).
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSend) {
                e.preventDefault();
                store.send(analysis.interpreted);
              }
            }}
          />
          <Stack gap="xs">
            <Button
              size="xs"
              disabled={!canSend}
              onClick={() => store.send(analysis.interpreted)}
            >
              Send ⌘↵
            </Button>
            <Button
              size="xs"
              variant="default"
              disabled={!ready || store.status !== "ready"}
              onClick={() => store.send("\x1bc")}
              title="Send ESC c (RIS) to reset the scratch pane"
            >
              Reset pane
            </Button>
          </Stack>
        </Group>
        <Group gap="xs" mt="xs">
          <Text size="xs" c="dimmed">
            presets:
          </Text>
          {PRESETS.map((p) => (
            <Button
              key={p.label}
              size="compact-xs"
              variant="light"
              onClick={() => setInput(p.value)}
            >
              {p.label}
            </Button>
          ))}
        </Group>
      </Paper>

      {/* Flex row (not SimpleGrid) so each column reliably STRETCHES to the
          row's height — a CSS grid track sizes to content by default, which
          collapsed the terminal column to zero height and left the xterm
          clipped + unrendered. align-items:stretch (the flex default) gives
          every column the row height; each column then flex-fills internally. */}
      <div
        style={{
          display: "flex",
          gap: "var(--mantine-spacing-sm)",
          flex: 1,
          // A floor so a short viewport (header + input area consuming the
          // column space) can never starve the columns to zero height — which
          // would clip the terminal and make xterm suspend rendering (blank).
          minHeight: 220,
        }}
      >
        <ColumnPaper
          title="Raw bytes"
          subtitle={`${analysis.bytes.length} bytes · sent via send-keys -H`}
        >
          <RawBytes bytes={analysis.bytes} />
        </ColumnPaper>

        <ColumnPaper
          title="Parsed events"
          subtitle={`${analysis.events.length} events`}
        >
          <ScrollArea style={{ height: "100%" }} type="auto">
            <Stack gap={4} p={4}>
              {analysis.events.length === 0 ? (
                <Text c="dimmed" size="xs">
                  Type a sequence above to see it classified.
                </Text>
              ) : (
                analysis.events.map((ev, i) => <EventRow key={i} event={ev} />)
              )}
            </Stack>
          </ScrollArea>
        </ColumnPaper>

        <ColumnPaper
          title="Rendered cells"
          subtitle="live scratch pane (cat in raw mode)"
        >
          <RenderedColumn
            demoStore={demoStore}
            store={store}
            uiStore={uiStore}
          />
        </ColumnPaper>
      </div>
    </Stack>
  );
});

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const StatusBadge = observer(function StatusBadge({
  store,
  ready,
}: {
  store: EscapePlaygroundStore;
  ready: boolean;
}) {
  if (!ready)
    return (
      <Badge variant="light" color="yellow">
        bridge connecting
      </Badge>
    );
  const map: Record<string, { color: string; label: string }> = {
    idle: { color: "gray", label: "idle" },
    spawning: { color: "yellow", label: "spawning pane…" },
    ready: { color: "green", label: "pane live" },
    error: { color: "red", label: "spawn failed" },
  };
  const s = map[store.status];
  return (
    <Badge variant="light" color={s.color}>
      {s.label}
    </Badge>
  );
});

// ---------------------------------------------------------------------------
// Column shell
// ---------------------------------------------------------------------------

function ColumnPaper({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <Paper
      withBorder
      p="xs"
      // flex:1 + width:0 makes the column take an equal third of the flex row
      // and STRETCH to its full height; the inner content area then flex-fills.
      style={{
        flex: 1,
        width: 0,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <Group gap="xs" justify="space-between" wrap="nowrap" mb={4}>
        <Text fw={600} size="sm">
          {title}
        </Text>
        <Text size="xs" c="dimmed" truncate="end">
          {subtitle}
        </Text>
      </Group>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </div>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Raw bytes
// ---------------------------------------------------------------------------

function RawBytes({ bytes }: { bytes: Uint8Array }) {
  const hex = useMemo(() => {
    const parts: string[] = [];
    for (const b of bytes) parts.push(b.toString(16).padStart(2, "0"));
    return parts.join(" ");
  }, [bytes]);
  const pretty = useMemo(() => prettyEscaped(bytes), [bytes]);

  return (
    <ScrollArea style={{ height: "100%" }} type="auto">
      <Stack gap="xs" p={4}>
        <div>
          <Text size="xs" c="dimmed" mb={2}>
            hex
          </Text>
          <Code
            block
            style={{
              fontSize: 11,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {hex || "—"}
          </Code>
        </div>
        <div>
          <Text size="xs" c="dimmed" mb={2}>
            escaped
          </Text>
          <Code block style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>
            {pretty || "—"}
          </Code>
        </div>
      </Stack>
    </ScrollArea>
  );
}

/** Full escaped rendering of a byte run (no truncation — input is short). */
function prettyEscaped(bytes: Uint8Array): string {
  let out = "";
  for (const c of bytes) {
    if (c === 0x1b) out += "\\e";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x07) out += "\\a";
    else if (c >= 0x20 && c <= 0x7e) out += String.fromCharCode(c);
    else out += `\\x${c.toString(16).padStart(2, "0")}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsed-event row
// ---------------------------------------------------------------------------

const EventRow = observer(function EventRow({ event }: { event: EscapeEvent }) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Badge
        size="xs"
        variant="light"
        color={KIND_COLOR[event.kind]}
        style={{ flexShrink: 0, minWidth: 64 }}
      >
        {event.kind}
      </Badge>
      <div style={{ minWidth: 0, flex: 1 }}>
        <Text
          size="xs"
          style={{ fontFamily: "var(--mantine-font-family-monospace)" }}
        >
          {describeEvent(event)}
        </Text>
        {event.kind === "csi" && event.sgr !== undefined && (
          <Group gap={4} mt={2}>
            {event.sgr.map((t, i) => (
              <SgrChip key={i} token={t} />
            ))}
          </Group>
        )}
      </div>
    </Group>
  );
});

function SgrChip({ token }: { token: SgrToken }) {
  return (
    <Group gap={3} wrap="nowrap" style={{ display: "inline-flex" }}>
      {token.color !== undefined && (
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: 2,
            background: token.color,
            border: "1px solid rgba(255,255,255,0.25)",
            display: "inline-block",
          }}
        />
      )}
      <Text size="xs" c="dimmed">
        {token.label}
      </Text>
    </Group>
  );
}

/** One-line human description per event, mirroring the engine's classification. */
function describeEvent(event: EscapeEvent): string {
  switch (event.kind) {
    case "text":
      return JSON.stringify(event.text);
    case "c0":
      return `${event.name} — ${event.desc}`;
    case "csi":
      return `CSI ${event.params}${event.intermediates}${event.final} — ${event.desc}`;
    case "osc":
      return `${event.desc} = ${JSON.stringify(event.payload)} [${event.terminator}]`;
    case "esc":
      return `ESC ${event.intermediates}${event.final} — ${event.desc}`;
    case "string":
      return `${event.desc} [${event.terminator}]`;
    case "incomplete":
      return event.desc;
  }
}

// ---------------------------------------------------------------------------
// Rendered column — the live scratch pane
// ---------------------------------------------------------------------------

const RenderedColumn = observer(function RenderedColumn({
  demoStore,
  store,
  uiStore,
}: Props) {
  if (demoStore.connState !== "ready")
    return (
      <Centered>
        <Text c="dimmed" size="sm">
          Connecting to bridge…
        </Text>
      </Centered>
    );
  if (store.status === "error")
    return (
      <Centered>
        <Text c="red" size="sm">
          {store.errorMsg ?? "Failed to spawn the scratch pane."}
        </Text>
      </Centered>
    );
  if (
    store.status !== "ready" ||
    store.paneId === null ||
    store.paneCols === null ||
    store.paneRows === null
  )
    return (
      <Centered>
        <Loader size="sm" />
      </Centered>
    );
  return (
    <PlaygroundTerminal
      // Key on the pane id so a respawn (reconnect) tears down the old terminal
      // and stream and builds a fresh one for the new pane.
      key={store.paneId}
      paneId={store.paneId}
      cols={store.paneCols}
      rows={store.paneRows}
      client={demoStore.paneStreamClient}
      uiStore={uiStore}
    />
  );
});

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </div>
  );
}

/**
 * Owns the scratch pane's `ObservablePaneStream` and mounts an XtermSink on it —
 * a faithful copy of PaneView's `PaneCell`. Creating the stream and the sink in
 * the SAME component (rather than handing in a store-owned stream) keeps them on
 * the same mount tick, so there is no window in which the stream seeds and goes
 * live before any terminal is attached to paint it.
 *
 * [LAW:one-type-per-behavior] The playground terminal and the multiplexer
 *   terminal are the same behavior — one tmux pane rendered as cells — so they
 *   are built the same way.
 * [LAW:no-ambient-temporal-coupling] The stream + mount lifecycle has one owner
 *   (this component); `key={paneId}` upstream makes a respawn a clean remount.
 */
const PlaygroundTerminal = observer(function PlaygroundTerminal({
  paneId,
  cols,
  rows,
  client,
  uiStore,
}: {
  paneId: number;
  cols: number;
  rows: number;
  client: DemoStore["paneStreamClient"];
  uiStore: UiStore;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sinkRef = useRef<XtermSink | null>(null);
  const initialFontSize = useRef(uiStore.terminalFontSize);
  const initialSize = useRef({ cols, rows });

  // [LAW:single-enforcer] One ObservablePaneStream per pane id, stable across
  // re-renders; disposed when the pane unmounts.
  const obs = useMemo(
    () => new ObservablePaneStream({ client, paneId }),
    [client, paneId],
  );
  useEffect(() => () => obs.dispose(), [obs]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;
    const mount = mountPaneTerminal(obs.stream, container, {
      fontFamily: FONT_FAMILY,
      fontSize: initialFontSize.current,
    });
    sinkRef.current = mount.sink;
    // Give the sink its first resize directly from the pane's known geometry.
    // This is what drains the buffered seed + live bytes and paints them — the
    // XtermSink holds everything until its first resize, and the per-pane size
    // subscription (the only other resize source) never fires for a freshly
    // created window. [LAW:no-ambient-temporal-coupling] the first-resize owner
    // is explicit and local, not a race against a subscription that may never
    // emit.
    mount.sink.resize(initialSize.current.cols, initialSize.current.rows);
    return () => {
      mount.dispose();
      sinkRef.current = null;
    };
  }, [obs.stream]);

  useEffect(() => {
    sinkRef.current?.setFontSize(uiStore.terminalFontSize);
  }, [uiStore.terminalFontSize]);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
        background: "var(--mantine-color-dark-9, #0b0d10)",
      }}
    />
  );
});
