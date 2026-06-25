// examples/web-multiplexer/web/components/MomentDiffView.tsx
//
// "Diff two moments in pane history" — record a session (seed every pane up
// front, then capture the forward firehose), then drag TWO playheads (A = before,
// B = after) over recorded time and see exactly what changed between them: which
// cells were added, removed, or overwritten, and where the cursor moved. Useful
// for debugging a TUI redraw — "what did this frame actually touch?".
//
// THE AXIS: like .8, this renders a terminal grid it OWNS (not xterm), because a
// cell-level diff needs per-cell access xterm discards. Both moments are
// reconstructed from the SAME seed, so the diff is purely the forward delta — the
// .5 gap the .9 seed closes, applied to a two-sided comparison.
//
// [LAW:effects-at-boundaries] The view only renders and routes record/scrub
//   intent; the store owns capture; the engine owns the byte→grid→diff fold.
// [LAW:dataflow-not-control-flow] The grid paints the same way every frame; which
//   cell is added/removed/changed is a value on `store.diff`, not a branch the
//   view re-derives.

import { useMemo } from "react";
import { observer } from "mobx-react-lite";
import {
  Stack,
  Group,
  Paper,
  Text,
  Badge,
  Button,
  Slider,
} from "@mantine/core";
import type { DemoStore } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import { MomentDiffStore } from "../moment-diff-store.ts";
import type { CellChange, MomentDiff } from "../moment-diff-engine.ts";
import { activityHistogram } from "../session-recording-engine.ts";
import { historyDepth } from "../scrollback-engine.ts";

const FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace';

const SPARKLINE_BUCKETS = 120;
const SCRUB_STEP = 0.0005;

// One palette for the four change kinds — used by both the grid cells and the
// legend so they cannot drift. [LAW:one-source-of-truth]
const KIND_STYLE: Record<
  CellChange["kind"],
  { bg: string; fg: string; label: string }
> = {
  same: { bg: "transparent", fg: "#6a6a6a", label: "unchanged" },
  added: { bg: "rgba(46,160,67,0.40)", fg: "#e8ffe8", label: "added" },
  removed: { bg: "rgba(248,81,73,0.32)", fg: "#ffd7d5", label: "removed" },
  changed: { bg: "rgba(210,153,34,0.45)", fg: "#fff4d6", label: "changed" },
};

const CURSOR_A_COLOR = "#4dabf7"; // before
const CURSOR_B_COLOR = "#ffa94d"; // after

interface Props {
  readonly demoStore: DemoStore;
  readonly store: MomentDiffStore;
  readonly uiStore: UiStore;
}

export const MomentDiffView = observer(function MomentDiffView({
  demoStore,
  store,
  uiStore,
}: Props) {
  const ready = demoStore.connState === "ready";
  const diff = store.diff;

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Paper withBorder p="xs">
        <Group gap="md" wrap="wrap">
          <Text fw={600} size="sm">
            Diff Two Moments
          </Text>
          <Text size="xs" c="dimmed">
            record a session, then drag two playheads — see which cells changed
            between any two moments of a pane's history
          </Text>
          <PhaseBadge store={store} ready={ready} />
          <RecordControls store={store} ready={ready} />
          {store.limitHit && (
            <Text size="xs" c="orange">
              recording hit the size cap and auto-stopped
            </Text>
          )}
          {store.seedTruncated && (
            <Text size="xs" c="orange">
              only the first panes were seeded (too many open)
            </Text>
          )}
        </Group>
      </Paper>

      {store.phase === "review" && <PaneSelector store={store} />}

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
          <DiffArea store={store} ready={ready} diff={diff} />
        </Paper>

        {store.phase === "review" && diff !== null && (
          <SummaryPanel diff={diff} />
        )}
      </Group>

      {store.phase === "review" && store.timeline !== null && (
        <ScrubBar store={store} />
      )}
    </Stack>
  );
});

// ---------------------------------------------------------------------------
// Phase badge + record controls (mirrors the .9 time machine)
// ---------------------------------------------------------------------------

const PhaseBadge = observer(function PhaseBadge({
  store,
  ready,
}: {
  store: MomentDiffStore;
  ready: boolean;
}) {
  if (!ready)
    return (
      <Badge variant="light" color="yellow">
        bridge connecting
      </Badge>
    );
  if (store.seeding)
    return (
      <Badge variant="light" color="grape">
        capturing scrollback…
      </Badge>
    );
  const map: Record<
    MomentDiffStore["phase"],
    { color: string; label: string }
  > = {
    idle: { color: "gray", label: "ready to record" },
    recording: { color: "red", label: "● recording" },
    review: { color: "green", label: "review" },
  };
  const s = map[store.phase];
  return (
    <Badge
      variant={store.phase === "recording" ? "filled" : "light"}
      color={s.color}
    >
      {s.label}
    </Badge>
  );
});

const RecordControls = observer(function RecordControls({
  store,
  ready,
}: {
  store: MomentDiffStore;
  ready: boolean;
}) {
  if (store.phase === "recording")
    return (
      <Group gap="xs">
        <Button size="xs" color="red" onClick={() => store.stopRecording()}>
          Stop ⏹
        </Button>
        <Badge variant="light" color="gray">
          {formatTime(store.liveDurationMs)}
        </Badge>
      </Group>
    );
  return (
    <Group gap="xs">
      <Button
        size="xs"
        color="red"
        disabled={!ready || store.seeding}
        onClick={() => store.startRecording()}
      >
        Record ●
      </Button>
      {store.phase === "review" && (
        <Button size="xs" variant="default" onClick={() => store.reset()}>
          New recording
        </Button>
      )}
    </Group>
  );
});

// ---------------------------------------------------------------------------
// Pane selector
// ---------------------------------------------------------------------------

const PaneSelector = observer(function PaneSelector({
  store,
}: {
  store: MomentDiffStore;
}) {
  const panes = [...store.snapshots.values()];
  if (panes.length === 0)
    return (
      <Paper withBorder p="xs">
        <Text size="xs" c="dimmed">
          No panes were seeded — nothing to diff.
        </Text>
      </Paper>
    );
  return (
    <Paper withBorder p="xs">
      <Group gap="xs" wrap="wrap">
        <Text size="xs" c="dimmed">
          pane:
        </Text>
        {panes.map((snap) => (
          <Button
            key={snap.paneId}
            size="compact-xs"
            variant={snap.paneId === store.selectedPaneId ? "filled" : "light"}
            onClick={() => store.selectPane(snap.paneId)}
          >
            %{snap.paneId} · {historyDepth(snap)} hist rows
          </Button>
        ))}
      </Group>
    </Paper>
  );
});

// ---------------------------------------------------------------------------
// The diff grid
// ---------------------------------------------------------------------------

const DiffArea = observer(function DiffArea({
  store,
  ready,
  diff,
}: {
  store: MomentDiffStore;
  ready: boolean;
  diff: MomentDiff | null;
}) {
  if (!ready) return <Centered>Connecting to bridge…</Centered>;
  if (store.seeding)
    return <Centered>Capturing every pane's scrollback…</Centered>;
  if (store.phase === "idle")
    return (
      <Centered>
        Hit <b>&nbsp;Record&nbsp;</b> — every pane is seeded up front, then the
        live stream is recorded. Then drag the A and B playheads to diff any two
        moments.
      </Centered>
    );
  if (store.phase === "recording")
    return (
      <Centered>
        ● Recording {formatTime(store.liveDurationMs)} — produce output in any
        pane, then hit Stop to diff it.
      </Centered>
    );
  if (diff === null) return <Centered>No seeded pane to diff.</Centered>;
  return <DiffGrid diff={diff} />;
});

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "0 var(--mantine-spacing-md)",
      }}
    >
      <Text c="dimmed" size="sm">
        {children}
      </Text>
    </div>
  );
}

function DiffGrid({ diff }: { diff: MomentDiff }) {
  const rows = [];
  for (let r = 0; r < diff.rows; r++) {
    const spans = [];
    for (let c = 0; c < diff.cols; c++) {
      const change = diff.cells[r * diff.cols + c];
      const isCursorA =
        r === diff.cursor.before.row && c === diff.cursor.before.col;
      const isCursorB =
        r === diff.cursor.after.row && c === diff.cursor.after.col;
      spans.push(
        <span
          key={c}
          title={cellTitle(change)}
          style={cellStyle(change, isCursorA, isCursorB)}
        >
          {glyphOf(change)}
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
        userSelect: "none",
      }}
    >
      {rows}
    </div>
  );
}

/** The glyph a cell shows: the after-state glyph, or before-state when removed. */
function glyphOf(change: CellChange): string {
  switch (change.kind) {
    case "same":
      return change.cell === null || change.cell.char === " "
        ? " "
        : change.cell.char;
    case "added":
      return change.after.char === " " ? " " : change.after.char;
    case "removed":
      return change.before.char === " " ? "·" : change.before.char;
    case "changed":
      return change.after.char === " " ? " " : change.after.char;
  }
}

/** Hover detail for the cells that changed; nothing for unchanged context. */
function cellTitle(change: CellChange): string | undefined {
  switch (change.kind) {
    case "same":
      return undefined;
    case "added":
      return `added: "${change.after.char}"`;
    case "removed":
      return `removed: "${change.before.char}"`;
    case "changed":
      return `changed: "${change.before.char}" → "${change.after.char}"`;
  }
}

function cellStyle(
  change: CellChange,
  isCursorA: boolean,
  isCursorB: boolean,
): React.CSSProperties {
  const palette = KIND_STYLE[change.kind];
  // A and B cursors get a box-shadow ring (inset so it never grows the cell). B
  // (after) wins the outline when both land on the same cell; both are reported.
  const cursorRing = isCursorB
    ? `inset 0 0 0 1px ${CURSOR_B_COLOR}`
    : isCursorA
      ? `inset 0 0 0 1px ${CURSOR_A_COLOR}`
      : "none";
  return {
    display: "inline-block",
    width: "1ch",
    textAlign: "center",
    whiteSpace: "pre",
    color: palette.fg,
    background: palette.bg,
    fontWeight: 400,
    textDecoration: change.kind === "removed" ? "line-through" : "none",
    boxShadow: cursorRing,
  };
}

// ---------------------------------------------------------------------------
// Summary panel
// ---------------------------------------------------------------------------

function SummaryPanel({ diff }: { diff: MomentDiff }) {
  const { added, removed, changed } = diff.summary;
  const total = added + removed + changed;
  return (
    <Paper
      withBorder
      p="sm"
      style={{ width: 240, flexShrink: 0, overflow: "auto" }}
    >
      <Text fw={600} size="sm" mb="xs">
        What changed
      </Text>
      {total === 0 ? (
        <Text size="xs" c="dimmed">
          The two moments are identical — no cells differ. Drag the A and B
          playheads apart to see a delta.
        </Text>
      ) : (
        <Stack gap={6}>
          <Tally kind="added" n={added} />
          <Tally kind="changed" n={changed} />
          <Tally kind="removed" n={removed} />
        </Stack>
      )}

      <Text fw={600} size="sm" mt="md" mb="xs">
        Cursor
      </Text>
      <Group gap="xs">
        <Swatch color={CURSOR_A_COLOR} />
        <Text size="xs" style={{ fontFamily: FONT_FAMILY }}>
          A ({diff.cursor.before.row},{diff.cursor.before.col})
        </Text>
        <Text size="xs" c="dimmed">
          →
        </Text>
        <Swatch color={CURSOR_B_COLOR} />
        <Text size="xs" style={{ fontFamily: FONT_FAMILY }}>
          B ({diff.cursor.after.row},{diff.cursor.after.col})
        </Text>
      </Group>
      <Text size="xs" c={diff.cursor.moved ? "yellow" : "dimmed"} mt={4}>
        {diff.cursor.moved ? "cursor moved" : "cursor unchanged"}
      </Text>

      <Text fw={600} size="sm" mt="md" mb="xs">
        Legend
      </Text>
      <Stack gap={4}>
        <LegendRow kind="added" />
        <LegendRow kind="changed" />
        <LegendRow kind="removed" />
        <LegendRow kind="same" />
      </Stack>
    </Paper>
  );
}

function Tally({ kind, n }: { kind: CellChange["kind"]; n: number }) {
  return (
    <Group gap="xs" justify="space-between">
      <Group gap={6}>
        <Swatch color={KIND_STYLE[kind].bg} border />
        <Text size="xs">{KIND_STYLE[kind].label}</Text>
      </Group>
      <Text size="sm" fw={600} style={{ fontFamily: FONT_FAMILY }}>
        {n}
      </Text>
    </Group>
  );
}

function LegendRow({ kind }: { kind: CellChange["kind"] }) {
  return (
    <Group gap={6}>
      <Swatch color={KIND_STYLE[kind].bg} border />
      <Text size="xs" c="dimmed">
        {KIND_STYLE[kind].label}
      </Text>
    </Group>
  );
}

function Swatch({
  color,
  border = false,
}: {
  color: string;
  border?: boolean;
}) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 12,
        height: 12,
        background: color === "transparent" ? "#1e1e1e" : color,
        border: border ? "1px solid #555" : "none",
        borderRadius: 2,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Scrub bar — two playheads over recorded time
// ---------------------------------------------------------------------------

const ScrubBar = observer(function ScrubBar({
  store,
}: {
  store: MomentDiffStore;
}) {
  const timeline = store.timeline;
  // Hooks run unconditionally before any early return (Rules of Hooks); the
  // memo is a no-op when there is no timeline.
  const histogram = useMemo(
    () =>
      timeline === null
        ? []
        : activityHistogram(
            timeline.recording,
            timeline.paneId,
            SPARKLINE_BUCKETS,
          ),
    [timeline],
  );
  if (timeline === null) return null;
  const dur = timeline.durationMs;

  if (dur <= 0)
    return (
      <Paper withBorder p="xs">
        <Text size="xs" c="dimmed">
          No forward activity was recorded for this pane — both moments show the
          seed. Record some output to diff across time.
        </Text>
      </Paper>
    );

  return (
    <Paper withBorder p="xs">
      <Sparkline histogram={histogram} />
      <PlayheadRow
        label="A"
        color={CURSOR_A_COLOR}
        value={store.posA}
        timeMs={store.tAMs}
        durationMs={dur}
        onChange={(v) => store.seekA(v)}
      />
      <PlayheadRow
        label="B"
        color={CURSOR_B_COLOR}
        value={store.posB}
        timeMs={store.tBMs}
        durationMs={dur}
        onChange={(v) => store.seekB(v)}
      />
    </Paper>
  );
});

function PlayheadRow({
  label,
  color,
  value,
  timeMs,
  durationMs,
  onChange,
}: {
  label: string;
  color: string;
  value: number;
  timeMs: number;
  durationMs: number;
  onChange: (v: number) => void;
}) {
  return (
    <Group gap="sm" wrap="nowrap" align="center">
      <Badge
        variant="filled"
        style={{ background: color, color: "#11151c", minWidth: 28 }}
      >
        {label}
      </Badge>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Slider
          min={0}
          max={1}
          value={value}
          onChange={onChange}
          label={null}
          step={SCRUB_STEP}
          size="sm"
          color={label === "A" ? "blue" : "orange"}
        />
      </div>
      <Text
        size="xs"
        c="dimmed"
        style={{
          fontFamily: "var(--mantine-font-family-monospace)",
          whiteSpace: "nowrap",
          minWidth: 132,
          textAlign: "right",
        }}
      >
        +{formatTime(timeMs)} / {formatTime(durationMs)}
      </Text>
    </Group>
  );
}

/** The activity sparkline backdrop shared by both playheads. */
function Sparkline({ histogram }: { histogram: readonly number[] }) {
  const max = histogram.reduce((m, v) => Math.max(m, v), 0);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 1,
        height: 24,
        marginBottom: 4,
      }}
    >
      {histogram.map((v, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: `${max === 0 ? 0 : Math.max(2, (v / max) * 100)}%`,
            background: "var(--mantine-color-blue-5)",
            opacity: v === 0 ? 0.15 : 0.7,
            borderRadius: 1,
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** `m:ss.t` — minutes:seconds.tenths. */
function formatTime(ms: number): string {
  const totalSec = ms / 1000;
  const min = Math.floor(totalSec / 60);
  const sec = Math.floor(totalSec % 60);
  const tenths = Math.floor((ms % 1000) / 100);
  return `${min}:${sec.toString().padStart(2, "0")}.${tenths}`;
}
