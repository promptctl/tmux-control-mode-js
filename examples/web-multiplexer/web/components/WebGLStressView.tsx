// examples/web-multiplexer/web/components/WebGLStressView.tsx
//
// WebGL terminal grid — render thousands of cells across many panes at 60fps
// against a SHARED glyph atlas, then push the throughput axis until it breaks.
//
// THE HEADLINE: `TerminalSink` is renderer-agnostic. Live mode drives a
// from-scratch WebGL renderer through the SAME `PaneStream` that drives xterm
// elsewhere in this app — proving the pane-terminal data-out contract is not
// bound to xterm. Synthetic mode then manufactures a controllable cell load and
// auto-ramps it until the renderer drops below 60fps, reporting the breaking
// point. One instanced draw paints every cell of every pane.
//
// The view owns the ONE render-timing authority (the rAF loop) and the GL
// effect (the renderer); the store owns the source-of-cells and the metrics.
// [LAW:no-ambient-temporal-coupling] [LAW:effects-at-boundaries]
//
// A missing WebGL2 context is shown as an error panel — never a silent fall
// back to a slower path that would invalidate the numbers. [LAW:no-silent-failure]

import { useEffect, useRef } from "react";
import { observer } from "mobx-react-lite";
import {
  Stack,
  Group,
  Paper,
  Text,
  Badge,
  Switch,
  Slider,
  SegmentedControl,
  Box,
} from "@mantine/core";
import { WebGLGridRenderer } from "../webgl-grid-renderer.ts";
import { shelfPack, type Tile } from "../webgl-atlas-engine.ts";
import { RAMP_CAP } from "../webgl-stress-engine.ts";
import type { WebGLStressStore } from "../webgl-stress-store.ts";

interface Props {
  readonly store: WebGLStressStore;
}

/** Gap between pane tiles, device px. */
const TILE_GAP_PX = 6;

export const WebGLStressView = observer(function WebGLStressView({
  store,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (canvas === null || container === null) return undefined;

    let renderer: WebGLGridRenderer;
    try {
      renderer = new WebGLGridRenderer(canvas);
      store.setGlError(null);
    } catch (err) {
      store.setGlError(err instanceof Error ? err.message : String(err));
      return undefined;
    }

    let raf = 0;
    let last = 0;
    let deviceW = 0;
    let deviceH = 0;

    const frame = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const wantW = Math.max(1, Math.floor(container.clientWidth * dpr));
      const wantH = Math.max(1, Math.floor(container.clientHeight * dpr));
      if (wantW !== deviceW || wantH !== deviceH) {
        deviceW = wantW;
        deviceH = wantH;
        canvas.style.width = `${container.clientWidth}px`;
        canvas.style.height = `${container.clientHeight}px`;
        renderer.resize(deviceW, deviceH);
      }

      const grids = store.grids;
      const sizes = grids.map(
        (g) =>
          [g.cols * renderer.cellPxW, g.rows * renderer.cellPxH] as const,
      );
      const placed = shelfPack(sizes, deviceW, TILE_GAP_PX);
      const tiles: Tile[] = grids.map((grid, i) => ({
        grid,
        originPxX: placed[i].originPxX,
        originPxY: placed[i].originPxY,
      }));
      const drawStats = renderer.draw(tiles);

      const dt = last === 0 ? 16 : now - last;
      last = now;
      store.recordFrame(dt, drawStats.cellCount, drawStats.drawCalls);
      raf = window.requestAnimationFrame(frame);
    };
    raf = window.requestAnimationFrame(frame);

    return () => {
      window.cancelAnimationFrame(raf);
      renderer.dispose();
    };
  }, [store]);

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Controls store={store} />
      <Paper
        withBorder
        p={0}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          background: "#0a0c10",
          position: "relative",
        }}
      >
        <Box
          ref={containerRef}
          style={{ position: "absolute", inset: 0 }}
        >
          <canvas
            ref={canvasRef}
            style={{ display: "block", width: "100%", height: "100%" }}
          />
        </Box>
        {store.glError !== null && (
          <Box
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 24,
            }}
          >
            <Paper withBorder p="md" maw={420}>
              <Text fw={600} c="red" size="sm" mb={6}>
                WebGL2 unavailable
              </Text>
              <Text size="xs" c="dimmed">
                {store.glError} This demo renders the terminal grid on the GPU
                and does not fall back to a slower path, so the throughput
                numbers stay meaningful. Enable hardware acceleration / WebGL2
                and reopen this tab.
              </Text>
            </Paper>
          </Box>
        )}
      </Paper>
    </Stack>
  );
});

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const Controls = observer(function Controls({
  store,
}: {
  store: WebGLStressStore;
}) {
  const fps = store.stats.fps;
  const fpsColor = fps === 0 ? "gray" : fps >= 55 ? "green" : fps >= 30 ? "yellow" : "red";
  return (
    <Paper withBorder p="xs">
      <Stack gap="xs">
        <Group gap="md" wrap="wrap">
          <Text fw={600} size="sm">
            WebGL Terminal Grid
          </Text>
          <SegmentedControl
            size="xs"
            value={store.source}
            onChange={(v) => store.setSource(v as "live" | "synthetic")}
            data={[
              { label: "Live panes", value: "live" },
              { label: "Synthetic load", value: "synthetic" },
            ]}
          />
          <Badge variant="light" color={fpsColor}>
            {fps === 0 ? "—" : fps.toFixed(0)} fps
          </Badge>
          <Badge variant="light" color="teal">
            {store.lastCellCount.toLocaleString()} cells
          </Badge>
          <Badge variant="light" color="grape">
            {store.lastDrawCalls} draw{store.lastDrawCalls === 1 ? "" : "s"}
          </Badge>
          <Badge variant="light" color="gray">
            p95 {store.stats.p95Ms.toFixed(1)}ms
          </Badge>
          <Text size="xs" c="dimmed" style={{ marginLeft: "auto" }}>
            one instanced draw · shared glyph atlas
          </Text>
        </Group>

        {store.source === "synthetic" ? (
          <Group gap="lg" wrap="wrap" align="center">
            <SliderField
              label={`panes: ${store.spec.paneCount}`}
              min={1}
              max={RAMP_CAP.paneCount}
              value={store.spec.paneCount}
              onChange={(v) => store.setPaneCount(v)}
              disabled={store.autoRamp}
            />
            <SliderField
              label={`cols: ${store.spec.cols}`}
              min={10}
              max={RAMP_CAP.cols}
              value={store.spec.cols}
              onChange={(v) => store.setGridSize(v, store.spec.rows)}
              disabled={store.autoRamp}
            />
            <SliderField
              label={`rows: ${store.spec.rows}`}
              min={4}
              max={RAMP_CAP.rows}
              value={store.spec.rows}
              onChange={(v) => store.setGridSize(store.spec.cols, v)}
              disabled={store.autoRamp}
            />
            <Switch
              size="xs"
              checked={store.autoRamp}
              onChange={(e) => store.setAutoRamp(e.currentTarget.checked)}
              label="auto-ramp to breaking point"
            />
            {store.broke && store.breakingSpec !== null && (
              <Badge color="orange" variant="filled">
                broke at {store.breakingSpec.paneCount} panes ·{" "}
                {(
                  store.breakingSpec.paneCount *
                  store.breakingSpec.cols *
                  store.breakingSpec.rows
                ).toLocaleString()}{" "}
                cells
              </Badge>
            )}
          </Group>
        ) : (
          <Group gap="md" wrap="wrap">
            <Badge variant="light" color="green">
              {store.livePaneCount} live panes
            </Badge>
            <Text size="xs" c="dimmed">
              real bytes from the current window's panes, each through a{" "}
              <code>PaneStream</code> → a custom WebGL <code>TerminalSink</code>{" "}
              (not xterm). Split a window (<code>Ctrl-b %</code>) or switch
              windows to feed more panes; switch to Synthetic to push past what
              live panes can supply.
            </Text>
          </Group>
        )}
      </Stack>
    </Paper>
  );
});

function SliderField({
  label,
  min,
  max,
  value,
  onChange,
  disabled,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <Group gap="xs" wrap="nowrap" style={{ minWidth: 200 }}>
      <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap", minWidth: 70 }}>
        {label}
      </Text>
      <Slider
        size="xs"
        style={{ flex: 1 }}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-label={label}
      />
    </Group>
  );
}
