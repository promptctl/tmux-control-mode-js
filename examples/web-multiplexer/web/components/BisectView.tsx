// examples/web-multiplexer/web/components/BisectView.tsx
//
// "Bisect a TUI bug in a recorded session" — record a session that broke, then
// git-bisect the pane's recorded BYTE STREAM to find the escape sequence that did
// it. At each step the store reconstructs the screen at the midpoint byte offset;
// you judge "bug present?"; each verdict halves the search until it pins one byte,
// which the engine names back to its escape sequence (e.g. `ESC [ 2 J`).
//
// THE AXIS IS BYTES, NOT TIME: one firehose chunk carries one timestamp, so time
// can't address a point mid-chunk — but an escape sequence is a span of bytes, so
// the search must run over byte offsets. Like .8/.10 the screen is an OWNED grid
// (xterm is lossy); reconstruction is emulate(seed ++ stream.slice(0, n)), the
// seed kept so the culprit is always in the forward delta, never the seed.
//
// [LAW:effects-at-boundaries] The view only renders and routes record/verdict
//   intent; the store owns capture + the bisect state; the engine owns the
//   byte→grid fold and the search reducer.
// [LAW:dataflow-not-control-flow] The screen paints the same way every probe;
//   which offset and whether the search has converged are values on the store,
//   not branches the view re-derives.

import { observer } from "mobx-react-lite";
import { Stack, Group, Paper, Text, Badge, Button } from "@mantine/core";
import type { DemoStore } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import { BisectStore } from "../bisect-store.ts";
import type { AttributionGrid } from "../byte-attribution-engine.ts";
import type { EscapeEvent } from "../escape-parse-engine.ts";
import { historyDepth } from "../scrollback-engine.ts";
import { prettyBytes } from "../format-bytes.ts";

const FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace';

const GOOD_COLOR = "#2ea043"; // bug absent / clean
const BAD_COLOR = "#f85149"; // bug present / broken
const PROBE_COLOR = "#d29922"; // the offset under judgement

interface Props {
  readonly demoStore: DemoStore;
  readonly store: BisectStore;
  readonly uiStore: UiStore;
}

export const BisectView = observer(function BisectView({
  demoStore,
  store,
}: Props) {
  const ready = demoStore.connState === "ready";

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Paper withBorder p="xs">
        <Group gap="md" wrap="wrap">
          <Text fw={600} size="sm">
            Bisect a TUI Bug
          </Text>
          <Text size="xs" c="dimmed">
            record a session that broke, then binary-search the byte stream —
            judge each reconstructed screen and the offending escape sequence is
            pinned
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
          <ScreenArea store={store} ready={ready} />
        </Paper>

        {store.phase === "review" && store.bisect !== null && (
          <SearchPanel store={store} />
        )}
      </Group>
    </Stack>
  );
});

// ---------------------------------------------------------------------------
// Phase badge + record controls (mirrors .9 / .10)
// ---------------------------------------------------------------------------

const PhaseBadge = observer(function PhaseBadge({
  store,
  ready,
}: {
  store: BisectStore;
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
  const map: Record<BisectStore["phase"], { color: string; label: string }> = {
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
  store: BisectStore;
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
  store: BisectStore;
}) {
  const panes = [...store.snapshots.values()];
  if (panes.length === 0)
    return (
      <Paper withBorder p="xs">
        <Text size="xs" c="dimmed">
          No panes were seeded — nothing to bisect.
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
// The reconstructed screen + verdict buttons
// ---------------------------------------------------------------------------

const ScreenArea = observer(function ScreenArea({
  store,
  ready,
}: {
  store: BisectStore;
  ready: boolean;
}) {
  if (!ready) return <Centered>Connecting to bridge…</Centered>;
  if (store.seeding)
    return <Centered>Capturing every pane&apos;s scrollback…</Centered>;
  if (store.phase === "idle")
    return (
      <Centered>
        Hit <b>&nbsp;Record&nbsp;</b>, reproduce the bug in a pane, then Stop.
        The screen was fine at the start and broken at the end — bisect finds
        the byte in between that broke it.
      </Centered>
    );
  if (store.phase === "recording")
    return (
      <Centered>
        ● Recording {formatTime(store.liveDurationMs)} — reproduce the glitch in
        any pane, then hit Stop to bisect it.
      </Centered>
    );

  const grid = store.displayGrid;
  if (grid === null || store.bisect === null)
    return (
      <Centered>
        This pane recorded no forward bytes — nothing to bisect. Pick another
        pane or record some output.
      </Centered>
    );

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <ScreenGrid grid={grid} />
      {store.converged ? (
        <CulpritPanel store={store} />
      ) : (
        <VerdictBar store={store} />
      )}
    </Stack>
  );
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

/** The owned reconstructed screen at the probe offset — faithful fg/bg/bold. */
function ScreenGrid({ grid }: { grid: AttributionGrid }) {
  const rows = [];
  for (let r = 0; r < grid.rows; r++) {
    const spans = [];
    for (let c = 0; c < grid.cols; c++) {
      const cell = grid.cells[r * grid.cols + c];
      const isCursor = r === grid.cursorRow && c === grid.cursorCol;
      spans.push(
        <span
          key={c}
          style={{
            display: "inline-block",
            width: "1ch",
            textAlign: "center",
            whiteSpace: "pre",
            color: cell?.fg ?? "#d4d4d4",
            background: cell?.bg ?? "transparent",
            fontWeight: cell?.bold === true ? 700 : 400,
            boxShadow: isCursor ? "inset 0 0 0 1px #4dabf7" : "none",
          }}
        >
          {cell === null || cell.char === " " ? " " : cell.char}
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

/** The good/bad oracle: you are the predicate. [LAW:dataflow-not-control-flow] */
const VerdictBar = observer(function VerdictBar({
  store,
}: {
  store: BisectStore;
}) {
  const offset = store.displayOffset ?? 0;
  return (
    <Paper withBorder p="xs">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Text size="xs" c="dimmed">
          Does the screen above show the bug? (byte {offset.toLocaleString()} of{" "}
          {store.stream.length.toLocaleString()}, ≤{store.probesRemaining} steps
          left)
        </Text>
        <Group gap="xs">
          <Button
            size="xs"
            color="red"
            onClick={() => store.markPresent()}
            title="The bug is visible — search the earlier half"
          >
            🐛 Bug present
          </Button>
          <Button
            size="xs"
            color="green"
            onClick={() => store.markAbsent()}
            title="Screen looks fine — search the later half"
          >
            ✓ Looks fine
          </Button>
        </Group>
      </Group>
    </Paper>
  );
});

/** The convergence: the offending escape sequence, decoded and located. */
const CulpritPanel = observer(function CulpritPanel({
  store,
}: {
  store: BisectStore;
}) {
  const culprit = store.culprit;
  const seq = store.offendingSequence;
  const loc = store.culpritLocation;
  if (culprit === null)
    return (
      <Paper withBorder p="xs">
        <Text size="xs" c="dimmed">
          Nothing to pin — the stream had no forward bytes.
        </Text>
        <Button
          size="xs"
          variant="default"
          mt="xs"
          onClick={() => store.restartBisect()}
        >
          Search again
        </Button>
      </Paper>
    );
  return (
    <Paper withBorder p="sm" style={{ borderColor: BAD_COLOR }}>
      <Group gap="xs" mb={6}>
        <Text fw={600} size="sm" c={BAD_COLOR}>
          🐛 Found it
        </Text>
        <Text size="xs" c="dimmed">
          the bug appeared at byte {culprit.byteOffset.toLocaleString()}
        </Text>
      </Group>
      {seq === null ? (
        <Text size="xs" c="dimmed">
          (could not isolate the enclosing sequence)
        </Text>
      ) : (
        <Stack gap={4}>
          <Text size="sm" style={{ fontFamily: FONT_FAMILY }}>
            {describeEvent(seq.event)}
          </Text>
          <Text
            size="xs"
            style={{
              fontFamily: FONT_FAMILY,
              background: "#161b22",
              padding: "4px 6px",
              borderRadius: 4,
              color: "#ffa657",
              wordBreak: "break-all",
            }}
          >
            {prettyBytes(seq.raw, 80)}
          </Text>
          <Text size="xs" c="dimmed">
            bytes {seq.start.toLocaleString()}–{(seq.end - 1).toLocaleString()}{" "}
            of the stream
            {loc !== null && (
              <>
                {" "}
                · arrived in %output chunk #{loc.chunkIndex} at +
                {formatTime(loc.tMs)}
              </>
            )}
          </Text>
        </Stack>
      )}
      <Button
        size="xs"
        variant="default"
        mt="sm"
        onClick={() => store.restartBisect()}
      >
        Search again
      </Button>
    </Paper>
  );
});

// ---------------------------------------------------------------------------
// The search-progress sidebar
// ---------------------------------------------------------------------------

const SearchPanel = observer(function SearchPanel({
  store,
}: {
  store: BisectStore;
}) {
  const b = store.bisect;
  if (b === null) return null;
  const len = store.stream.length;
  return (
    <Paper
      withBorder
      p="sm"
      style={{ width: 260, flexShrink: 0, overflow: "auto" }}
    >
      <Text fw={600} size="sm" mb="xs">
        Binary search
      </Text>
      <RangeBar lo={b.lo} hi={b.hi} len={len} converged={store.converged} />
      <Group gap="xs" mt="xs" justify="space-between">
        <Text size="xs" c="dimmed">
          range
        </Text>
        <Text size="xs" style={{ fontFamily: FONT_FAMILY }}>
          {(b.hi - b.lo).toLocaleString()} bytes
        </Text>
      </Group>
      <Group gap="xs" justify="space-between">
        <Text size="xs" c="dimmed">
          probes left
        </Text>
        <Text size="xs" style={{ fontFamily: FONT_FAMILY }}>
          {store.converged ? "—" : store.probesRemaining}
        </Text>
      </Group>

      <Text fw={600} size="sm" mt="md" mb="xs">
        Steps
      </Text>
      {store.steps.length === 0 ? (
        <Text size="xs" c="dimmed">
          No probes judged yet. Read the screen and click 🐛 or ✓.
        </Text>
      ) : (
        <Stack gap={2}>
          {store.steps.map((s, i) => (
            <Group key={i} gap={6} wrap="nowrap">
              <Badge
                size="xs"
                variant="filled"
                color={s.verdict === "present" ? "red" : "green"}
                style={{ minWidth: 64 }}
              >
                {s.verdict === "present" ? "🐛 bug" : "✓ fine"}
              </Badge>
              <Text size="xs" c="dimmed" style={{ fontFamily: FONT_FAMILY }}>
                @ {s.offset.toLocaleString()}
              </Text>
            </Group>
          ))}
        </Stack>
      )}

      <Text fw={600} size="sm" mt="md" mb="xs">
        How it works
      </Text>
      <Text size="xs" c="dimmed">
        Each screen is reconstructed from the seed plus the first N stream bytes
        (<span style={{ fontFamily: FONT_FAMILY }}>emulate(seed ++ slice)</span>
        ). Your verdict halves the byte range; the seed never changes, so the
        culprit is always in the recorded delta.
      </Text>
    </Paper>
  );
});

/** The collapsing search interval: green (good) · amber (unknown) · red (bad). */
function RangeBar({
  lo,
  hi,
  len,
  converged,
}: {
  lo: number;
  hi: number;
  len: number;
  converged: boolean;
}) {
  const span = Math.max(1, len);
  const goodPct = (lo / span) * 100;
  const unknownPct = ((hi - lo) / span) * 100;
  const badPct = ((len - hi) / span) * 100;
  return (
    <div>
      <div
        style={{
          display: "flex",
          height: 14,
          borderRadius: 3,
          overflow: "hidden",
          border: "1px solid #30363d",
        }}
      >
        <div style={{ width: `${goodPct}%`, background: GOOD_COLOR }} />
        <div
          style={{
            // A converged interval is one byte wide — show it as a thin marker
            // rather than letting it vanish below sub-pixel width.
            width: converged ? 3 : `${unknownPct}%`,
            minWidth: 3,
            background: PROBE_COLOR,
          }}
        />
        <div style={{ width: `${badPct}%`, background: BAD_COLOR }} />
      </div>
      <Group justify="space-between" mt={2}>
        <Text size="9px" c={GOOD_COLOR}>
          fine
        </Text>
        <Text size="9px" c={PROBE_COLOR}>
          {converged ? "culprit" : "unknown"}
        </Text>
        <Text size="9px" c={BAD_COLOR}>
          broken
        </Text>
      </Group>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** A one-line human description of the offending event. */
function describeEvent(event: EscapeEvent): string {
  switch (event.kind) {
    case "text":
      return `printed text — "${event.text.slice(0, 40)}"`;
    case "c0":
      return `${event.name} — ${event.desc}`;
    case "csi":
      return `CSI ${event.params}${event.intermediates}${event.final} — ${event.desc}`;
    case "osc":
      return `OSC ${event.ps} — ${event.desc}`;
    case "esc":
      return `ESC ${event.intermediates}${event.final} — ${event.desc}`;
    case "string":
      return `${event.type} string — ${event.desc}`;
    case "incomplete":
      return `incomplete — ${event.desc}`;
  }
}

/** `m:ss.t` — minutes:seconds.tenths. */
function formatTime(ms: number): string {
  const totalSec = ms / 1000;
  const min = Math.floor(totalSec / 60);
  const sec = Math.floor(totalSec % 60);
  const tenths = Math.floor((ms % 1000) / 100);
  return `${min}:${sec.toString().padStart(2, "0")}.${tenths}`;
}
