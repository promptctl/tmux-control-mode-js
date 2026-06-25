// examples/web-multiplexer/web/components/SyncScrollView.tsx
//
// Synchronized scrollback across linked panes — record a session (every pane
// seeded up front, then the forward firehose), then drag ONE shared cursor and
// watch N linked panes reconstruct their screen at the SAME recorded instant, in
// lockstep. Click any pane's activity bar to drive them all from there.
//
// THE AXIS: the only demo that scrubs MANY panes on one shared clock. A single
// control client recorded every pane in every session onto one timeline, so "what
// did all of these look like at t=4.2s?" is answerable — impossible with one PTY
// per pane (N unsynchronized clocks). The synchronization coordinate is recorded
// TIME, not a per-pane scroll position (scrollback rows are untimestamped), so the
// cursor lives in the live regime only.
//
// [LAW:one-source-of-truth] ONE cursor value (`store.pos` → `store.cursorMs`)
//   drives every surface and is fed by every input (the shared slider, each pane's
//   click-to-seek bar). The surfaces never hold their own playhead — they read the
//   shared one and paint.
// [LAW:dataflow-not-control-flow] a surface's content is a pure function of the
//   shared instant: `paintAt(tl, tMs)`. The only branch in the paint path is the
//   forward-delta OPTIMIZATION (write `forwardDelta` instead of re-seeding) keyed
//   on the single `rendered` tMs — same screen either way.
// [LAW:effects-at-boundaries] the view performs DOM writes; the store owns capture
//   + the clock; the engine computes the bytes. Three seams, no overlap.

import { useEffect, useMemo, useRef } from "react";
import { observer } from "mobx-react-lite";
import {
  Stack,
  Group,
  Paper,
  Text,
  Badge,
  Button,
  ActionIcon,
  Slider,
  Tooltip,
} from "@mantine/core";
import { XtermSink } from "@promptctl/pane-terminal/xterm-sink";
import type { DemoStore } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import {
  SyncScrollStore,
  PLAYBACK_RATES,
  type PlaybackRate,
} from "../sync-store.ts";
import { activityHistogram } from "../session-recording-engine.ts";
import type { Timeline } from "../scrollback-engine.ts";
import {
  cursorFrac,
  groupDuration,
  linkablePanes,
  linkedActivity,
  linkedTimelines,
  paintAt,
  forwardDelta,
} from "../sync-engine.ts";

const FONT_FAMILY =
  '"JetBrainsMono Nerd Font Mono", "JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace';

// Grid terminals cap a touch smaller than the single-pane modes so several fit;
// the user's preferred size is honoured up to that ceiling.
const GRID_FONT_CEILING = 11;
const LINE_HEIGHT = 1.3;
const MAX_CELL_PX = 360;
const SPARKLINE_BUCKETS = 96;
const CELL_SPARKLINE_BUCKETS = 60;
const SCRUB_STEP = 0.0005;
const LIVE_COLOR = "var(--mantine-color-blue-5)";
const CURSOR_COLOR = "var(--mantine-color-yellow-4)";

interface Props {
  readonly demoStore: DemoStore;
  readonly store: SyncScrollStore;
  readonly uiStore: UiStore;
}

/** Where a pane lives, for the cell header. Null when it is no longer in the model. */
interface PaneLocation {
  readonly title: string;
  readonly where: string;
}

function paneLocation(demoStore: DemoStore, paneId: number): PaneLocation | null {
  for (const s of demoStore.sessions) {
    for (const w of s.windows) {
      for (const p of w.panes) {
        if (p.id === paneId)
          return { title: p.title, where: `${s.name} › ${w.name}` };
      }
    }
  }
  return null;
}

export const SyncScrollView = observer(function SyncScrollView({
  demoStore,
  store,
  uiStore,
}: Props) {
  const ready = demoStore.connState === "ready";
  const fontSize = Math.min(uiStore.terminalFontSize, GRID_FONT_CEILING);

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Paper withBorder p="xs">
        <Group gap="md" wrap="wrap">
          <Text fw={600} size="sm">
            Synchronized Scrollback
          </Text>
          <Text size="xs" c="dimmed">
            one cursor, N linked panes — every pane reconstructed at the same
            recorded instant
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

      {store.phase === "review" && (
        <LinkSelector demoStore={demoStore} store={store} />
      )}

      <Paper
        withBorder
        p="xs"
        style={{
          flex: 1,
          minHeight: 240,
          display: "flex",
          flexDirection: "column",
          overflow: "auto",
        }}
      >
        <ReviewBody
          demoStore={demoStore}
          store={store}
          ready={ready}
          fontSize={fontSize}
        />
      </Paper>

      {store.phase === "review" && groupDuration(store.group) > 0 && (
        <SharedTransportBar store={store} />
      )}
    </Stack>
  );
});

// ---------------------------------------------------------------------------
// Phase badge + record controls (same shape as the .9 time machine)
// ---------------------------------------------------------------------------

const PhaseBadge = observer(function PhaseBadge({
  store,
  ready,
}: {
  store: SyncScrollStore;
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
    SyncScrollStore["phase"],
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
  store: SyncScrollStore;
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
// Link selector — which seeded panes are in the synchronized group
// ---------------------------------------------------------------------------

const LinkSelector = observer(function LinkSelector({
  demoStore,
  store,
}: {
  demoStore: DemoStore;
  store: SyncScrollStore;
}) {
  const panes = linkablePanes(store.group);
  if (panes.length === 0)
    return (
      <Paper withBorder p="xs">
        <Text size="xs" c="dimmed">
          No panes were seeded — nothing to synchronize.
        </Text>
      </Paper>
    );
  return (
    <Paper withBorder p="xs">
      <Group gap="xs" wrap="wrap" align="center">
        <Text size="xs" c="dimmed">
          linked panes:
        </Text>
        {panes.map((paneId) => {
          const loc = paneLocation(demoStore, paneId);
          const on = store.linked.has(paneId);
          return (
            <Button
              key={paneId}
              size="compact-xs"
              variant={on ? "filled" : "light"}
              color={on ? "blue" : "gray"}
              onClick={() => store.toggleLinked(paneId)}
            >
              %{paneId}
              {loc !== null && loc.title !== "" ? ` · ${loc.title}` : ""}
            </Button>
          );
        })}
        <Button size="compact-xs" variant="subtle" onClick={() => store.linkAll()}>
          all
        </Button>
        <Button
          size="compact-xs"
          variant="subtle"
          onClick={() => store.linkNone()}
        >
          none
        </Button>
      </Group>
    </Paper>
  );
});

// ---------------------------------------------------------------------------
// Review body — the synchronized grid, or a phase prompt
// ---------------------------------------------------------------------------

const ReviewBody = observer(function ReviewBody({
  demoStore,
  store,
  ready,
  fontSize,
}: {
  demoStore: DemoStore;
  store: SyncScrollStore;
  ready: boolean;
  fontSize: number;
}) {
  if (!ready) return <Centered>Connecting to bridge…</Centered>;
  if (store.seeding)
    return <Centered>Capturing every pane's scrollback…</Centered>;
  if (store.phase === "idle")
    return (
      <Centered>
        Hit <b>&nbsp;Record&nbsp;</b> — every pane is seeded with its scrollback,
        then the live stream is recorded. In review, one cursor scrubs every
        linked pane to the same instant.
      </Centered>
    );
  if (store.phase === "recording")
    return (
      <Centered>
        ● Recording {formatTime(store.liveDurationMs)} — produce output in any
        panes, then hit Stop to scrub them together.
      </Centered>
    );

  const timelines = linkedTimelines(store.group);
  if (timelines.length === 0)
    return <Centered>No panes linked — pick some above to synchronize.</Centered>;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))",
        gap: 8,
        alignContent: "start",
      }}
    >
      {timelines.map((tl) => (
        <LinkedPaneCell
          key={`${tl.paneId}:${tl.snapshot.lines.length}:${tl.durationMs}`}
          demoStore={demoStore}
          store={store}
          timeline={tl}
          fontSize={fontSize}
        />
      ))}
    </div>
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

// ---------------------------------------------------------------------------
// One linked pane: header + reconstructed terminal + click-to-seek activity bar
// ---------------------------------------------------------------------------

const LinkedPaneCell = observer(function LinkedPaneCell({
  demoStore,
  store,
  timeline,
  fontSize,
}: {
  demoStore: DemoStore;
  store: SyncScrollStore;
  timeline: Timeline;
  fontSize: number;
}) {
  const loc = paneLocation(demoStore, timeline.paneId);
  const cursorMs = store.cursorMs;
  return (
    <Paper withBorder p={6} style={{ display: "flex", flexDirection: "column" }}>
      <Group gap={6} wrap="nowrap" mb={4} style={{ minWidth: 0 }}>
        <Badge size="xs" variant="light" color="blue">
          %{timeline.paneId}
        </Badge>
        <Text size="xs" fw={500} truncate="end" style={{ minWidth: 0 }}>
          {loc?.title === "" || loc === null ? "(untitled)" : loc.title}
        </Text>
        {loc !== null && (
          <Text size="xs" c="dimmed" truncate="end" style={{ minWidth: 0 }}>
            {loc.where}
          </Text>
        )}
      </Group>
      <SyncSurface
        timeline={timeline}
        cursorMs={cursorMs}
        cols={timeline.snapshot.geometry.cols}
        rows={timeline.snapshot.geometry.rows}
        fontSize={fontSize}
      />
      <CellActivityBar store={store} timeline={timeline} />
    </Paper>
  );
});

/**
 * Owns an `XtermSink` and paints it to match the SHARED cursor. A forward step
 * writes only the byte delta (`forwardDelta`); any backward move or the first
 * paint clears and repaints from `paintAt`. `rendered` is the single record of the
 * instant the terminal currently shows, so the delta math reads and updates only
 * it. The cursor is the store's, never this surface's — that is what keeps every
 * cell in lockstep. [LAW:no-ambient-temporal-coupling]
 */
function SyncSurface({
  timeline,
  cursorMs,
  cols,
  rows,
  fontSize,
}: {
  timeline: Timeline;
  cursorMs: number;
  cols: number;
  rows: number;
  fontSize: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sinkRef = useRef<XtermSink | null>(null);
  const rendered = useRef<number | null>(null);
  const initial = useRef({ cols, rows, fontSize });
  const heightPx = Math.min(
    MAX_CELL_PX,
    Math.ceil(rows * fontSize * LINE_HEIGHT) + 8,
  );

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;
    const sink = new XtermSink({
      container,
      fontFamily: FONT_FAMILY,
      fontSize: initial.current.fontSize,
    });
    sinkRef.current = sink;
    // First resize drains the buffer and unblocks painting (the .4/.5 findings).
    sink.resize(initial.current.cols, initial.current.rows);
    rendered.current = null;
    return () => {
      sink.dispose();
      sinkRef.current = null;
    };
  }, []);

  useEffect(() => {
    const sink = sinkRef.current;
    if (sink === null) return;
    const prev = rendered.current;
    if (prev !== null && cursorMs >= prev) {
      sink.write(forwardDelta(timeline, prev, cursorMs));
    } else {
      sink.clear();
      sink.write(paintAt(timeline, cursorMs));
    }
    rendered.current = cursorMs;
  }, [cursorMs, timeline]);

  useEffect(() => {
    sinkRef.current?.setFontSize(fontSize);
  }, [fontSize]);

  return (
    <div
      ref={containerRef}
      style={{
        height: heightPx,
        overflow: "hidden",
        background: "var(--mantine-color-dark-9, #0b0d10)",
        borderRadius: 2,
      }}
    />
  );
}

/**
 * One pane's activity sparkline, with the shared cursor drawn over it. Clicking
 * anywhere seeks the SHARED cursor to that fraction — so any pane can drive the
 * whole linked group, yet there is only ever one cursor value. [LAW:one-source-of-truth]
 */
const CellActivityBar = observer(function CellActivityBar({
  store,
  timeline,
}: {
  store: SyncScrollStore;
  timeline: Timeline;
}) {
  const histogram = useMemo(
    () =>
      activityHistogram(
        timeline.recording,
        timeline.paneId,
        CELL_SPARKLINE_BUCKETS,
      ),
    [timeline],
  );
  const dur = groupDuration(store.group);
  const frac = cursorFrac(store.cursorMs, dur);
  const max = histogram.reduce((m, v) => Math.max(m, v), 0);

  function seekFromEvent(e: React.MouseEvent<HTMLDivElement>): void {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    store.seek((e.clientX - rect.left) / rect.width);
  }

  return (
    <div
      onClick={seekFromEvent}
      title="click to move every linked pane to this moment"
      style={{
        position: "relative",
        display: "flex",
        alignItems: "flex-end",
        gap: 1,
        height: 18,
        marginTop: 4,
        cursor: "pointer",
      }}
    >
      {histogram.map((v, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: `${max === 0 ? 0 : Math.max(2, (v / max) * 100)}%`,
            background: LIVE_COLOR,
            opacity: v === 0 ? 0.15 : 0.7,
            borderRadius: 1,
          }}
        />
      ))}
      <div
        style={{
          position: "absolute",
          left: `${frac * 100}%`,
          top: 0,
          bottom: 0,
          width: 2,
          background: CURSOR_COLOR,
          transform: "translateX(-1px)",
          pointerEvents: "none",
        }}
      />
    </div>
  );
});

// ---------------------------------------------------------------------------
// Shared transport bar — the one cursor that moves every linked pane
// ---------------------------------------------------------------------------

const SharedTransportBar = observer(function SharedTransportBar({
  store,
}: {
  store: SyncScrollStore;
}) {
  const dur = groupDuration(store.group);
  const histogram = useMemo(
    () => linkedActivity(store.group, SPARKLINE_BUCKETS),
    [store.group],
  );

  return (
    <Paper withBorder p="xs">
      <Group gap="sm" wrap="nowrap" align="center">
        <Tooltip label={store.playing ? "Pause" : "Play"}>
          <ActionIcon
            variant="filled"
            size="lg"
            disabled={dur <= 0}
            onClick={() => store.togglePlay()}
            aria-label={store.playing ? "pause" : "play"}
          >
            {store.playing ? "⏸" : "▶"}
          </ActionIcon>
        </Tooltip>

        <Group gap={2} wrap="nowrap">
          {PLAYBACK_RATES.map((r) => (
            <Button
              key={r}
              size="compact-xs"
              variant={r === store.rate ? "filled" : "light"}
              disabled={dur <= 0}
              onClick={() => store.setRate(r as PlaybackRate)}
            >
              {r}×
            </Button>
          ))}
        </Group>

        <div style={{ flex: 1, minWidth: 0 }}>
          <ActivityStrip histogram={histogram} />
          <Slider
            min={0}
            max={1}
            value={store.pos}
            onChange={(v) => store.seek(v)}
            label={null}
            step={SCRUB_STEP}
            size="sm"
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
          ▶ +{formatTime(store.cursorMs)} / {formatTime(dur)}
        </Text>
      </Group>
    </Paper>
  );
});

/** The merged activity sparkline behind the shared scrubber — when ANY linked pane was busy. */
function ActivityStrip({ histogram }: { histogram: readonly number[] }) {
  const max = histogram.reduce((m, v) => Math.max(m, v), 0);
  return (
    <div style={{ display: "flex", height: 24, marginBottom: 2, gap: 1 }}>
      {histogram.map((v, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            height: `${max === 0 ? 0 : Math.max(2, (v / max) * 100)}%`,
            alignSelf: "flex-end",
            background: LIVE_COLOR,
            opacity: v === 0 ? 0.15 : 0.7,
            borderRadius: 1,
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `m:ss.t` — minutes:seconds.tenths. */
function formatTime(ms: number): string {
  const totalSec = ms / 1000;
  const min = Math.floor(totalSec / 60);
  const sec = Math.floor(totalSec % 60);
  const tenths = Math.floor((ms % 1000) / 100);
  return `${min}:${sec.toString().padStart(2, "0")}.${tenths}`;
}
