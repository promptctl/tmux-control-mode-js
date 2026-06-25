// examples/web-multiplexer/web/components/HyperlinkSidebarView.tsx
//
// Hyperlink (OSC 8) Sidebar — a live, global aggregator of every clickable link
// any pane in any session has emitted. Type nothing; links just surface as panes
// print them, deduplicated by destination. Click a link to open it; click the
// pane label to jump to the pane that emitted it.
//
// THE HEADLINE: a terminal renders an OSC 8 hyperlink as styled text and discards
// the URI after one paint. The bridge firehose hands us the raw pty bytes of
// EVERY pane — sequences intact — tapped via `pipe-pane`, so links from panes the
// browser is NOT focused on collect here, and the tap injects nothing (read-only).
//
// This is pure projection: it reads `store.links` (the live registry) and
// `demoStore.sessions` (to resolve a paneId to its location + label). No local
// framing state — the store owns the engine and the registry.
//
// [LAW:dataflow-not-control-flow] The sidebar maps the same render over every
//   entry each pass; "no links yet" is the empty-array case, not a skipped
//   branch. [LAW:types-are-the-program] every entry carries a non-empty URI, so
//   rendering never branches on "is this a real link".
// [LAW:single-enforcer] `isSafeScheme` is the ONE place a URI is judged
//   clickable — untrusted terminal output never becomes a live <a href> without
//   passing it. [LAW:no-silent-failure] an unsafe-scheme link is still listed,
//   just rendered as non-clickable text rather than dropped.

import { useMemo } from "react";
import { observer } from "mobx-react-lite";
import {
  Stack,
  Group,
  Paper,
  Text,
  Badge,
  ScrollArea,
  Button,
  Anchor,
  Code,
} from "@mantine/core";
import type { DemoStore } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import type { HyperlinkStore, LinkEntry } from "../hyperlink-store.ts";

interface Props {
  readonly demoStore: DemoStore;
  readonly store: HyperlinkStore;
  readonly uiStore: UiStore;
}

/** Where a pane lives, resolved from the session tree for jump + labelling. */
interface PaneLocation {
  readonly sessionId: number;
  readonly sessionName: string;
  readonly windowId: number;
  readonly windowIndex: number;
  readonly paneIndex: number;
}

/**
 * Schemes safe to render as a live <a href>. Terminal output is untrusted, so a
 * `javascript:`/`data:`/`vbscript:` URI must never become a clickable anchor in
 * the page origin. Everything not on this list is shown as plain text.
 */
const SAFE_SCHEMES = new Set([
  "http",
  "https",
  "ftp",
  "ftps",
  "mailto",
  "tel",
  "file",
]);

export const HyperlinkSidebarView = observer(function HyperlinkSidebarView({
  demoStore,
  store,
  uiStore,
}: Props) {
  const locations = useMemo(
    () => buildPaneLocations(demoStore),
    [demoStore.sessions],
  );

  const links = store.links;

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Paper withBorder p="xs">
        <Group gap="md" wrap="wrap">
          <Text fw={600} size="sm">
            Hyperlink Sidebar (OSC 8)
          </Text>
          <Badge variant="light" color="gray">
            {store.tappedPaneCount} panes tapped
          </Badge>
          <Badge variant="light" color="teal">
            {store.linkCount}
            {store.linkCount >= 2000 ? "+" : ""} links
          </Badge>
          <Badge variant="light" color={store.active ? "green" : "yellow"}>
            {store.active ? "firehose live" : "firehose off"}
          </Badge>
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            onClick={() => store.clearLinks()}
            disabled={store.linkCount === 0}
          >
            Clear
          </Button>
          <Text size="xs" c="dimmed" style={{ marginLeft: "auto" }}>
            click a link to open · click the pane to jump
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
          {links.length === 0 ? (
            <Text c="dimmed" size="sm" p="sm">
              No hyperlinks yet — this is a live watch, so every clickable link any
              pane emits (via the <code>OSC 8</code> escape) collects here,
              deduplicated by destination. The sidebar reads every pane in every
              session via <code>pipe-pane</code> in the bridge process, so it
              surfaces links from panes this browser is <em>not</em> focused on,
              and it sits <em>between</em> you and the terminal without injecting a
              byte. Try <code>ls --hyperlink=auto</code> (GNU coreutils) or{" "}
              <code>
                printf '\e]8;;https://tmux.github.io\e\\tmux\e]8;;\e\\\n'
              </code>{" "}
              in any pane. ({store.tappedPaneCount} panes tapped)
            </Text>
          ) : (
            <Stack gap="xs" p="xs">
              {[...links].reverse().map((entry) => (
                <LinkRow
                  key={entry.uri}
                  entry={entry}
                  expanded={store.selectedUri === entry.uri}
                  location={locations.get(entry.paneId) ?? null}
                  onToggle={() => store.select(entry.uri)}
                  onJump={() => {
                    const loc = locations.get(entry.paneId);
                    if (loc === undefined) return;
                    demoStore.jumpToPane(
                      loc.sessionId,
                      loc.windowId,
                      entry.paneId,
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
// One link in the sidebar
// ---------------------------------------------------------------------------

const LinkRow = observer(function LinkRow({
  entry,
  expanded,
  location,
  onToggle,
  onJump,
}: {
  entry: LinkEntry;
  expanded: boolean;
  location: PaneLocation | null;
  onToggle: () => void;
  onJump: () => void;
}) {
  const paneLabel =
    location !== null
      ? `${location.sessionName}:${location.windowIndex}.${location.paneIndex}`
      : `%${entry.paneId}`;
  const scheme = schemeOf(entry.uri);
  const label = entry.text !== "" ? entry.text : entry.uri;
  const safe = scheme !== null && SAFE_SCHEMES.has(scheme);

  return (
    <Paper withBorder p="xs" bg="dark.8">
      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? "collapse link" : "expand link"}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--mantine-color-dimmed)",
            width: 16,
            padding: 0,
          }}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <Badge size="xs" color={safe ? "blue" : "red"} variant="light">
          {scheme ?? "?"}
        </Badge>
        {safe ? (
          <Anchor
            href={entry.uri}
            target="_blank"
            rel="noreferrer noopener"
            size="sm"
            truncate="end"
            style={{ flex: 1, minWidth: 0, fontWeight: 500 }}
            title={entry.uri}
          >
            {label}
          </Anchor>
        ) : (
          <Text
            size="sm"
            truncate="end"
            c="dimmed"
            style={{ flex: 1, minWidth: 0 }}
            title={`unsafe scheme — not clickable: ${entry.uri}`}
          >
            {label}
          </Text>
        )}
        {entry.count > 1 && (
          <Badge size="xs" variant="light" color="gray">
            ×{entry.count}
          </Badge>
        )}
        <button
          type="button"
          onClick={onJump}
          disabled={location === null}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: location === null ? "default" : "pointer",
            color: "var(--mantine-color-teal-4)",
            fontFamily: "var(--mantine-font-family-monospace)",
            fontSize: 12,
            fontWeight: 600,
            whiteSpace: "nowrap",
          }}
        >
          {paneLabel}
        </button>
      </Group>
      {expanded && (
        <Stack gap={4} mt={8}>
          <Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {entry.uri}
          </Code>
          <Group gap="xs">
            <Badge size="xs" variant="outline" color="gray">
              seen ×{entry.count}
            </Badge>
            {!safe && (
              <Badge size="xs" variant="filled" color="red">
                unsafe scheme — not clickable
              </Badge>
            )}
          </Group>
        </Stack>
      )}
    </Paper>
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lowercased URI scheme (`https`, `file`, …), or null if the URI has none. */
function schemeOf(uri: string): string | null {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(uri);
  return m === null ? null : m[1]!.toLowerCase();
}

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
          paneIndex: p.index,
        });
      }
    }
  }
  return map;
}
