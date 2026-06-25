// examples/web-multiplexer/web/components/ImageExtractorView.tsx
//
// Inline image extractor — sniffs iTerm2 / Kitty / Sixel image escape sequences
// out of the raw byte stream of EVERY pane in EVERY session, decodes them, and
// renders the images here, grouped by session › window › pane. Click an image
// to jump to its pane in multiplexer mode.
//
// THE HEADLINE: images appear from panes in sessions the browser is NOT focused
// on — and they're images tmux would never even show you, because tmux's own
// screen emulator strips graphics sequences from the attached `%output` it
// renders. The bytes here come from the bridge-process firehose (`pipe-pane`
// taps on every pane), where the sequences survive intact.
//
// This is pure projection: it reads `store.images` (the decoded feed) and
// `demoStore.sessions` (to resolve a paneId to its location). Blob URLs and
// <canvas> painting — the only effects — live in the leaf card components.
//
// [LAW:dataflow-not-control-flow] Grouping runs the same reduce over the feed
//   every render; "no images" is the empty-array case, not a skipped branch.
//   A card branches on payload.kind (encoded → <img>, raster → <canvas>), the
//   real rendering distinction, never on the source protocol.

import { useEffect, useMemo, useRef } from "react";
import { observer } from "mobx-react-lite";
import {
  Stack,
  Group,
  Paper,
  Text,
  Badge,
  ScrollArea,
  SimpleGrid,
} from "@mantine/core";
import type { DemoStore } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import type {
  ImageExtractorStore,
  ExtractedImage,
} from "../image-extractor-store.ts";

interface Props {
  readonly demoStore: DemoStore;
  readonly imageStore: ImageExtractorStore;
  readonly uiStore: UiStore;
}

/** Where a pane lives, resolved from the session tree for jump + labelling. */
interface PaneLocation {
  readonly sessionId: number;
  readonly sessionName: string;
  readonly windowId: number;
  readonly windowIndex: number;
  readonly windowName: string;
  readonly paneIndex: number;
}

/** Images from one pane, in arrival order. */
interface PaneGroup {
  readonly paneId: number;
  readonly location: PaneLocation | null;
  readonly images: ExtractedImage[];
}

const PROTOCOL_COLOR: Record<ExtractedImage["protocol"], string> = {
  iterm2: "grape",
  kitty: "cyan",
  sixel: "orange",
};

export const ImageExtractorView = observer(function ImageExtractorView({
  demoStore,
  imageStore,
  uiStore,
}: Props) {
  const locations = useMemo(
    () => buildPaneLocations(demoStore),
    [demoStore.sessions],
  );

  const groups = groupByPane(imageStore.images, locations);

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Paper withBorder p="xs">
        <Group gap="md" wrap="wrap">
          <Text fw={600} size="sm">
            Inline Image Extractor
          </Text>
          <Badge variant="light" color="gray">
            {imageStore.tappedPaneCount} panes tapped
          </Badge>
          <Badge variant="light" color="teal">
            {imageStore.imageCount}
            {imageStore.imageCount >= 400 ? "+" : ""} images
          </Badge>
          <Badge variant="light" color={imageStore.active ? "green" : "yellow"}>
            {imageStore.active ? "firehose live" : "firehose off"}
          </Badge>
          <Text size="xs" c="dimmed" style={{ marginLeft: "auto" }}>
            click an image to jump to its pane
          </Text>
        </Group>
      </Paper>

      <Paper
        withBorder
        p="xs"
        style={{
          flex: 1,
          minHeight: 0,
          background: "var(--mantine-color-dark-9, #0b0d10)",
        }}
      >
        <ScrollArea style={{ height: "100%" }} type="auto">
          {groups.length === 0 ? (
            <Text c="dimmed" size="sm" p="sm">
              No images yet. This is a live sniffer: run something that prints
              an inline image in any pane in any session — e.g.{" "}
              <code>magick -size 64x64 xc:tomato sixel:-</code>, or{" "}
              <code>imgcat photo.png</code> (iTerm2), or a Kitty{" "}
              <code>kitten icat</code> — and the decoded image appears here,
              even from panes this browser is <em>not</em> focused on. The bytes
              are tapped via <code>pipe-pane</code> in the bridge process, where
              the graphics sequences survive (tmux strips them from the attached{" "}
              <code>%output</code> it renders). ({imageStore.tappedPaneCount}{" "}
              panes tapped)
            </Text>
          ) : (
            <Stack gap="md" p="xs">
              {groups.map((g) => (
                <PaneGroupBlock
                  key={g.paneId}
                  group={g}
                  onJump={() => {
                    if (g.location === null) return;
                    demoStore.jumpToPane(
                      g.location.sessionId,
                      g.location.windowId,
                      g.paneId,
                    );
                    uiStore.setAppMode("multiplexer");
                  }}
                />
              ))}
            </Stack>
          )}
        </ScrollArea>
      </Paper>
    </Stack>
  );
});

// ---------------------------------------------------------------------------
// Pane group
// ---------------------------------------------------------------------------

const PaneGroupBlock = observer(function PaneGroupBlock({
  group,
  onJump,
}: {
  group: PaneGroup;
  onJump: () => void;
}) {
  const loc = group.location;
  const label =
    loc !== null
      ? `${loc.sessionName}:${loc.windowIndex}.${loc.paneIndex}`
      : `%${group.paneId}`;
  const sub =
    loc !== null ? loc.windowName : "pane no longer in the session tree";

  return (
    <Stack gap={6}>
      <Group gap="xs" wrap="nowrap">
        <button
          type="button"
          onClick={onJump}
          disabled={loc === null}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: loc === null ? "default" : "pointer",
            color: "var(--mantine-color-teal-4)",
            fontFamily: "var(--mantine-font-family-monospace)",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {label}
        </button>
        <Text size="xs" c="dimmed" truncate="end">
          {sub}
        </Text>
        <Badge size="xs" variant="light" color="gray">
          {group.images.length}
        </Badge>
      </Group>
      <SimpleGrid cols={{ base: 2, sm: 3, md: 4, lg: 6 }} spacing="xs">
        {group.images.map((img) => (
          <ImageCard key={img.id} image={img} onClick={onJump} />
        ))}
      </SimpleGrid>
    </Stack>
  );
});

const ImageCard = observer(function ImageCard({
  image,
  onClick,
}: {
  image: ExtractedImage;
  onClick: () => void;
}) {
  return (
    <Paper
      withBorder
      p={4}
      onClick={onClick}
      style={{
        cursor: "pointer",
        background: "var(--mantine-color-dark-8, #14171c)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div
        style={{
          // Checkerboard so transparent images (sixel/RGBA) are legible.
          backgroundImage:
            "linear-gradient(45deg,#333 25%,transparent 25%),linear-gradient(-45deg,#333 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#333 75%),linear-gradient(-45deg,transparent 75%,#333 75%)",
          backgroundSize: "12px 12px",
          backgroundPosition: "0 0,0 6px,6px -6px,-6px 0",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 72,
          overflow: "hidden",
        }}
      >
        {image.payload.kind === "encoded" ? (
          <EncodedImage payload={image.payload} />
        ) : (
          <RasterImage payload={image.payload} />
        )}
      </div>
      <Group gap={4} justify="space-between" wrap="nowrap">
        <Badge size="xs" variant="light" color={PROTOCOL_COLOR[image.protocol]}>
          {image.protocol}
        </Badge>
        <Text size="xs" c="dimmed" truncate="end" title={image.label}>
          {image.label}
        </Text>
      </Group>
    </Paper>
  );
});

/** Pixelated upscaling so tiny test images (1×1, 4×4) stay crisp, not blurry. */
const PIXELATED: React.CSSProperties = {
  maxWidth: "100%",
  maxHeight: 160,
  imageRendering: "pixelated",
  objectFit: "contain",
};

function EncodedImage({
  payload,
}: {
  payload: Extract<ExtractedImage["payload"], { kind: "encoded" }>;
}) {
  // [LAW:effects-at-boundaries] The blob URL is the effect: created from inert
  // bytes the engine produced, revoked when this card unmounts or the bytes
  // change, so we never leak object URLs.
  const url = useMemo(() => {
    const blob = new Blob([payload.bytes as BlobPart], { type: payload.mime });
    return URL.createObjectURL(blob);
  }, [payload]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img src={url} alt={payload.mime} style={PIXELATED} />;
}

function RasterImage({
  payload,
}: {
  payload: Extract<ExtractedImage["payload"], { kind: "raster" }>;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    // createImageData + set (rather than `new ImageData(rgba, …)`) sidesteps the
    // DOM lib's ArrayBuffer/SharedArrayBuffer overload friction and copies the
    // engine's raster into a canvas-owned buffer.
    const imageData = ctx.createImageData(payload.width, payload.height);
    imageData.data.set(payload.rgba);
    ctx.putImageData(imageData, 0, 0);
  }, [payload]);
  return (
    <canvas
      ref={ref}
      width={payload.width}
      height={payload.height}
      style={PIXELATED}
    />
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPaneLocations(demoStore: DemoStore): Map<number, PaneLocation> {
  const map = new Map<number, PaneLocation>();
  for (const s of demoStore.sessions) {
    for (const w of s.windows) {
      for (const p of w.panes) {
        map.set(p.id, {
          sessionId: s.id,
          sessionName: s.name,
          windowId: w.id,
          windowIndex: w.index,
          windowName: w.name,
          paneIndex: p.index,
        });
      }
    }
  }
  return map;
}

function groupByPane(
  images: readonly ExtractedImage[],
  locations: Map<number, PaneLocation>,
): PaneGroup[] {
  const order: number[] = [];
  const byPane = new Map<number, ExtractedImage[]>();
  for (const img of images) {
    let arr = byPane.get(img.paneId);
    if (arr === undefined) {
      arr = [];
      byPane.set(img.paneId, arr);
      order.push(img.paneId);
    }
    arr.push(img);
  }
  return order.map((paneId) => ({
    paneId,
    location: locations.get(paneId) ?? null,
    images: byPane.get(paneId) ?? [],
  }));
}
