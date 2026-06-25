// examples/web-multiplexer/web/components/ByteAttributionView.tsx
//
// "Who wrote this byte?" — hover any rendered cell and see the exact firehose
// chunk, arrival time, and byte offset that produced it. The grid is NOT an
// xterm: it's the attribution engine's own provenance-bearing screen, so every
// cell carries the byte that wrote it. Hovering surfaces that byte's home in the
// raw stream, classified by the same VT parser the Escape Playground uses.
//
// THE AXIS: this is the only demo that renders a terminal grid it OWNS (not
// xterm/PaneStream) specifically so the byte→cell mapping survives emulation —
// the tight parser↔grid↔raw-stream integration the showcase calls for.
//
// [LAW:effects-at-boundaries] The view only renders and routes hover/click; the
//   store owns capture + the rebuild clock; the engine owns the byte→grid fold.
// [LAW:dataflow-not-control-flow] Which provenance shows is a value (pinned ??
//   hovered cell), not a branch in the render; the grid paints the same way every
//   frame, colored by a mode flag.

import { useState } from "react";
import { observer } from "mobx-react-lite";
import {
  Stack,
  Group,
  Paper,
  Text,
  Badge,
  Button,
  Switch,
} from "@mantine/core";
import type { DemoStore } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import {
  ByteAttributionStore,
  type PaneStat,
} from "../byte-attribution-store.ts";
import type { AttributedCell } from "../byte-attribution-engine.ts";
import { parseEscapes, type EscapeEvent } from "../escape-parse-engine.ts";

const FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace';

// Default cell foreground when the program selected no SGR color.
const DEFAULT_FG = "#d4d4d4";

interface Props {
  readonly demoStore: DemoStore;
  readonly store: ByteAttributionStore;
  readonly uiStore: UiStore;
}

/** Which cell's provenance the panel shows. */
interface CellRef {
  readonly row: number;
  readonly col: number;
}

export const ByteAttributionView = observer(function ByteAttributionView({
  demoStore,
  store,
  uiStore,
}: Props) {
  const ready = demoStore.connState === "ready";
  const [hovered, setHovered] = useState<CellRef | null>(null);
  const [pinned, setPinned] = useState<CellRef | null>(null);
  const [colorByChunk, setColorByChunk] = useState(false);

  const grid = store.grid;
  const target = pinned ?? hovered;
  const targetCell =
    grid !== null && target !== null
      ? (grid.cells[target.row * grid.cols + target.col] ?? null)
      : null;

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Paper withBorder p="xs">
        <Group gap="md" wrap="wrap">
          <Text fw={600} size="sm">
            Who wrote this byte?
          </Text>
          <Text size="xs" c="dimmed">
            hover any cell → the exact firehose chunk + time + byte offset that
            produced it
          </Text>
          <Switch
            size="xs"
            label="color by chunk"
            checked={colorByChunk}
            onChange={(e) => setColorByChunk(e.currentTarget.checked)}
          />
          <Button
            size="xs"
            variant={store.frozen ? "filled" : "light"}
            color={store.frozen ? "blue" : "gray"}
            onClick={() => store.toggleFreeze()}
            disabled={!ready}
          >
            {store.frozen ? "Frozen — resume" : "Freeze"}
          </Button>
        </Group>
      </Paper>

      <PaneSelector store={store} />

      <Group
        align="stretch"
        gap="sm"
        style={{ flex: 1, minHeight: 0 }}
        wrap="nowrap"
      >
        <Paper
          withBorder
          p="xs"
          style={{
            flex: 1,
            minHeight: 240,
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {!ready ? (
            <Text c="dimmed" size="sm">
              Connecting to bridge ({demoStore.connState})…
            </Text>
          ) : grid === null ? (
            <Text c="dimmed" size="sm">
              Waiting for any pane to produce output… (run something in a tmux
              pane — the firehose taps every pane in every session)
            </Text>
          ) : (
            <CellGrid
              store={store}
              colorByChunk={colorByChunk}
              target={target}
              onHover={setHovered}
              onLeave={() => setHovered(null)}
              onPin={(ref) =>
                setPinned((prev) =>
                  prev !== null && prev.row === ref.row && prev.col === ref.col
                    ? null
                    : ref,
                )
              }
            />
          )}
        </Paper>

        <ProvenancePanel
          store={store}
          cell={targetCell}
          pinned={pinned !== null}
        />
      </Group>
    </Stack>
  );
});

// ---------------------------------------------------------------------------
// Pane selector
// ---------------------------------------------------------------------------

const PaneSelector = observer(function PaneSelector({
  store,
}: {
  store: ByteAttributionStore;
}) {
  if (store.paneList.length === 0) return null;
  const sorted = [...store.paneList].sort((a, b) => b.byteCount - a.byteCount);
  return (
    <Group gap="xs" wrap="wrap">
      <Text size="xs" c="dimmed">
        pane:
      </Text>
      {sorted.map((p) => (
        <PaneChip
          key={p.paneId}
          stat={p}
          selected={p.paneId === store.selectedPaneId}
          onSelect={() => store.selectPane(p.paneId)}
        />
      ))}
    </Group>
  );
});

function PaneChip({
  stat,
  selected,
  onSelect,
}: {
  stat: PaneStat;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Badge
      component="button"
      variant={selected ? "filled" : "light"}
      color={selected ? "blue" : "gray"}
      style={{ cursor: "pointer" }}
      onClick={onSelect}
      rightSection={
        <Text span size="9px">
          {formatBytes(stat.byteCount)}
          {stat.trimmed ? " ✂" : ""}
        </Text>
      }
    >
      %{stat.paneId}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// The cell grid
// ---------------------------------------------------------------------------

const CellGrid = observer(function CellGrid({
  store,
  colorByChunk,
  target,
  onHover,
  onLeave,
  onPin,
}: {
  store: ByteAttributionStore;
  colorByChunk: boolean;
  target: CellRef | null;
  onHover: (ref: CellRef) => void;
  onLeave: () => void;
  onPin: (ref: CellRef) => void;
}) {
  const grid = store.grid;
  if (grid === null) return null;

  // Event delegation: one handler reads data-r / data-c off the hovered span.
  const refFromEvent = (e: React.MouseEvent): CellRef | null => {
    const el = e.target as HTMLElement;
    const r = el.dataset.r;
    const c = el.dataset.c;
    if (r === undefined || c === undefined) return null;
    return { row: Number(r), col: Number(c) };
  };

  const rows = [];
  for (let r = 0; r < grid.rows; r++) {
    const spans = [];
    for (let c = 0; c < grid.cols; c++) {
      const cell = grid.cells[r * grid.cols + c];
      const isTarget = target !== null && target.row === r && target.col === c;
      spans.push(
        <span
          key={c}
          data-r={r}
          data-c={c}
          style={cellStyle(cell, colorByChunk, isTarget)}
        >
          {cell === null || cell.char === " " ? " " : cell.char}
        </span>,
      );
    }
    rows.push(
      <div key={r} style={{ display: "flex", height: "1.2em" }}>
        {spans}
      </div>,
    );
  }

  return (
    <div
      style={{
        fontFamily: FONT_FAMILY,
        fontSize: 13,
        lineHeight: "1.2em",
        background: "#1e1e1e",
        padding: 6,
        width: "fit-content",
        cursor: "crosshair",
        userSelect: "none",
      }}
      onMouseOver={(e) => {
        const ref = refFromEvent(e);
        if (ref !== null) onHover(ref);
      }}
      onMouseLeave={onLeave}
      onClick={(e) => {
        const ref = refFromEvent(e);
        if (ref !== null) onPin(ref);
      }}
    >
      {rows}
    </div>
  );
});

function cellStyle(
  cell: AttributedCell | null,
  colorByChunk: boolean,
  isTarget: boolean,
): React.CSSProperties {
  const base: React.CSSProperties = {
    display: "inline-block",
    width: "1ch",
    textAlign: "center",
    whiteSpace: "pre",
    outline: isTarget ? "1px solid #4dabf7" : "none",
    outlineOffset: "-1px",
  };
  if (cell === null) {
    return { ...base, color: "#3a3a3a", background: "transparent" };
  }
  if (colorByChunk) {
    return {
      ...base,
      color: "#fff",
      background: chunkColor(cell.chunkId),
      fontWeight: cell.bold ? 700 : 400,
    };
  }
  return {
    ...base,
    color: cell.fg ?? DEFAULT_FG,
    background: cell.bg ?? "transparent",
    fontWeight: cell.bold ? 700 : 400,
  };
}

/** Deterministic, well-spread hue per chunk so adjacent chunks read distinctly. */
function chunkColor(chunkId: number): string {
  const hue = (chunkId * 47) % 360;
  return `hsl(${hue}, 55%, 32%)`;
}

// ---------------------------------------------------------------------------
// Provenance panel
// ---------------------------------------------------------------------------

const ProvenancePanel = observer(function ProvenancePanel({
  store,
  cell,
  pinned,
}: {
  store: ByteAttributionStore;
  cell: AttributedCell | null;
  pinned: boolean;
}) {
  return (
    <Paper
      withBorder
      p="sm"
      style={{ width: 340, flexShrink: 0, overflow: "auto" }}
    >
      <Group gap="xs" mb="xs">
        <Text fw={600} size="sm">
          Provenance
        </Text>
        {pinned && (
          <Badge size="xs" color="blue">
            pinned — click again to release
          </Badge>
        )}
      </Group>

      {cell === null ? (
        <Text size="xs" c="dimmed">
          Hover a written cell to trace it back to the byte that produced it.
          Click to pin. Dim cells were never written; a written space still has
          a source byte.
        </Text>
      ) : (
        <CellProvenance store={store} cell={cell} />
      )}

      {store.selectedTrimmed && (
        <Text size="xs" c="orange" mt="sm">
          Older bytes were trimmed from this pane's retained window — a cell
          from before the window will report its chunk as evicted.
        </Text>
      )}
    </Paper>
  );
});

function CellProvenance({
  store,
  cell,
}: {
  store: ByteAttributionStore;
  cell: AttributedCell;
}) {
  const chunk = store.getChunk(cell.chunkId);
  return (
    <Stack gap={6}>
      <Group gap="xs">
        <Text size="xs" c="dimmed">
          glyph
        </Text>
        <Text
          span
          style={{ fontFamily: FONT_FAMILY, fontSize: 16 }}
          c={cell.fg ?? undefined}
        >
          {cell.char === " " ? "␠ (space)" : cell.char}
        </Text>
      </Group>
      <Field label="chunk" value={`#${cell.chunkId}`} />
      <Field label="arrived" value={`+${cell.tMs.toFixed(0)} ms`} />
      <Field label="offset in chunk" value={`byte ${cell.byteOffset}`} />
      <Field label="stream offset" value={`byte ${cell.streamOffset}`} />
      {(cell.fg !== null || cell.bg !== null || cell.bold) && (
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            style
          </Text>
          {cell.bold && <Badge size="xs">bold</Badge>}
          {cell.fg !== null && <Swatch label="fg" color={cell.fg} />}
          {cell.bg !== null && <Swatch label="bg" color={cell.bg} />}
        </Group>
      )}

      <Text size="xs" c="dimmed" mt={4}>
        chunk #{cell.chunkId} bytes (the producing byte highlighted):
      </Text>
      {chunk === null ? (
        <Text size="xs" c="orange">
          This chunk was evicted from the retained window.
        </Text>
      ) : (
        <ChunkAnatomy bytes={chunk.bytes} byteOffset={cell.byteOffset} />
      )}
    </Stack>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Group gap="xs" justify="space-between">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="xs" style={{ fontFamily: FONT_FAMILY }}>
        {value}
      </Text>
    </Group>
  );
}

function Swatch({ label, color }: { label: string; color: string }) {
  return (
    <Group gap={4}>
      <span
        style={{
          display: "inline-block",
          width: 12,
          height: 12,
          background: color,
          border: "1px solid #888",
          borderRadius: 2,
        }}
      />
      <Text size="9px" c="dimmed">
        {label} {color}
      </Text>
    </Group>
  );
}

/**
 * The chunk's raw bytes classified by the shared VT parser, with the event that
 * contains the producing byte highlighted — the parser↔raw-stream half of the
 * integration. [LAW:single-enforcer] one VT classifier, reused from the
 * Escape Playground rather than re-deriving framing here.
 */
function ChunkAnatomy({
  bytes,
  byteOffset,
}: {
  bytes: Uint8Array;
  byteOffset: number;
}) {
  const events = parseEscapes(bytes);
  const chips = [];
  let offset = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const len = eventLength(ev);
    const contains = byteOffset >= offset && byteOffset < offset + len;
    chips.push(
      <span
        key={i}
        title={`bytes ${offset}–${offset + len - 1}`}
        style={{
          fontFamily: FONT_FAMILY,
          fontSize: 11,
          padding: "1px 4px",
          borderRadius: 3,
          background: contains ? "#1971c2" : "#2a2a2a",
          color: contains ? "#fff" : "#bbb",
          border: contains ? "1px solid #4dabf7" : "1px solid #3a3a3a",
        }}
      >
        {eventLabel(ev)}
      </span>,
    );
    offset += len;
  }
  return (
    <Group gap={4} style={{ rowGap: 4 }}>
      {chips}
    </Group>
  );
}

function eventLength(ev: EscapeEvent): number {
  return ev.kind === "c0" ? 1 : ev.byteLength;
}

function eventLabel(ev: EscapeEvent): string {
  switch (ev.kind) {
    case "text":
      return JSON.stringify(ev.text);
    case "c0":
      return ev.name;
    case "csi":
      return `CSI ${ev.params}${ev.intermediates}${ev.final}`;
    case "osc":
      return `OSC ${ev.ps}`;
    case "esc":
      return `ESC ${ev.intermediates}${ev.final}`;
    case "string":
      return ev.type;
    case "incomplete":
      return "…";
  }
}

// ---------------------------------------------------------------------------

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
