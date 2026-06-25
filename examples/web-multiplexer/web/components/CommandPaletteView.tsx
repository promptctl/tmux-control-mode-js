// examples/web-multiplexer/web/components/CommandPaletteView.tsx
//
// Command Palette (OSC 133) — a live, global history of every command run in
// every pane in every session, chunked out of the raw byte stream by the shell's
// OSC 133 prompt-integration marks. Each entry carries its command line, its
// output, and its exit code. Filter the history, click a pane label to jump to
// it, or hit Re-run to send the command back to the pane it came from.
//
// THE HEADLINE: a shell emits OSC 133 marks so a terminal can fold and navigate
// between commands; the marks then scroll off and are forgotten. The bridge
// firehose hands us the raw pty bytes of EVERY pane — marks intact — tapped via
// `pipe-pane`, so the command history of panes the browser is NOT focused on is
// reconstructable here, and any past command is re-runnable.
//
// This is pure projection: it reads `store.filteredCommands` (the live history)
// and `demoStore.sessions` (to resolve a paneId to its location + label). No
// local framing state — the store owns the engine and the history.
//
// [LAW:dataflow-not-control-flow] The palette maps the same render over every
//   entry each pass; "no commands yet" is the empty-array case, not a skipped
//   branch. [LAW:types-are-the-program] `status` is a discriminated union, so the
//   badge renders by exhaustive cases (running vs finished), never a guess.
// [LAW:single-enforcer] Re-run goes through `store.rerun` — the one write path —
//   and only on an explicit click. The palette never auto-runs anything.

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
  Code,
  TextInput,
} from "@mantine/core";
import type { DemoStore } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import type { PromptStore, CommandRecord } from "../prompt-store.ts";

interface Props {
  readonly demoStore: DemoStore;
  readonly store: PromptStore;
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

export const CommandPaletteView = observer(function CommandPaletteView({
  demoStore,
  store,
  uiStore,
}: Props) {
  const locations = useMemo(
    () => buildPaneLocations(demoStore),
    [demoStore.sessions],
  );

  const commands = store.filteredCommands;

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Paper withBorder p="xs">
        <Group gap="md" wrap="wrap">
          <Text fw={600} size="sm">
            Command Palette (OSC 133)
          </Text>
          <Badge variant="light" color="gray">
            {store.tappedPaneCount} panes tapped
          </Badge>
          <Badge variant="light" color="teal">
            {store.commandCount}
            {store.commandCount >= 1000 ? "+" : ""} commands
          </Badge>
          <Badge variant="light" color={store.active ? "green" : "yellow"}>
            {store.active ? "firehose live" : "firehose off"}
          </Badge>
          <TextInput
            size="xs"
            placeholder="filter commands…"
            value={store.filter}
            onChange={(e) => store.setFilter(e.currentTarget.value)}
            style={{ flex: 1, minWidth: 160 }}
          />
          <Button
            size="xs"
            variant="subtle"
            color="gray"
            onClick={() => store.clearHistory()}
            disabled={store.commandCount === 0}
          >
            Clear
          </Button>
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
          {commands.length === 0 ? (
            <Text c="dimmed" size="sm" p="sm">
              {store.commandCount === 0 ? (
                <>
                  No commands yet — this is a live watch, so every command any
                  shell runs collects here, chunked out of the byte stream by its{" "}
                  <code>OSC 133</code> prompt-integration marks (the same marks
                  iTerm2, VTE and WezTerm use to fold commands). The palette reads
                  every pane in every session via <code>pipe-pane</code> in the
                  bridge process, so it surfaces commands from panes this browser
                  is <em>not</em> focused on, and it sits <em>between</em> you and
                  the terminal without injecting a byte. Enable shell integration
                  (iTerm2, <code>starship</code>, or the VTE/Kitty hooks), or test
                  it with{" "}
                  <code>
                    printf
                    '\e]133;A\e\\$ \e]133;B\e\\date\n\e]133;C\e\\Mon\n\e]133;D;0\e\\'
                  </code>{" "}
                  in any pane. ({store.tappedPaneCount} panes tapped)
                </>
              ) : (
                <>No commands match “{store.filter}”.</>
              )}
            </Text>
          ) : (
            <Stack gap="xs" p="xs">
              {[...commands].reverse().map((entry) => (
                <CommandRow
                  key={entry.id}
                  entry={entry}
                  expanded={store.selectedId === entry.id}
                  location={locations.get(entry.paneId) ?? null}
                  onToggle={() => store.select(entry.id)}
                  onRerun={() => store.rerun(entry)}
                  onJump={() => {
                    const loc = locations.get(entry.paneId);
                    if (loc === undefined) return;
                    demoStore.jumpToPane(loc.sessionId, loc.windowId, entry.paneId);
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
// One command in the palette
// ---------------------------------------------------------------------------

const CommandRow = observer(function CommandRow({
  entry,
  expanded,
  location,
  onToggle,
  onRerun,
  onJump,
}: {
  entry: CommandRecord;
  expanded: boolean;
  location: PaneLocation | null;
  onToggle: () => void;
  onRerun: () => void;
  onJump: () => void;
}) {
  const paneLabel =
    location !== null
      ? `${location.sessionName}:${location.windowIndex}.${location.paneIndex}`
      : `%${entry.paneId}`;

  return (
    <Paper withBorder p="xs" bg="dark.8">
      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? "collapse command" : "expand command"}
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
        <StatusBadge status={entry.status} />
        <Code
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            background: "transparent",
            fontWeight: 600,
          }}
          title={entry.command}
        >
          {entry.command}
        </Code>
        <Button
          size="compact-xs"
          variant="light"
          color="teal"
          onClick={onRerun}
          title={`re-run in ${paneLabel} (sends the command + Enter)`}
        >
          Re-run
        </Button>
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
            {entry.command}
          </Code>
          {entry.output !== "" && (
            <Code
              block
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                maxHeight: 200,
                overflow: "auto",
                color: "var(--mantine-color-dimmed)",
              }}
            >
              {entry.output}
            </Code>
          )}
        </Stack>
      )}
    </Paper>
  );
});

/**
 * The outcome badge. [LAW:types-are-the-program] `status` is a discriminated
 * union; this renders by exhaustive case — running, exit 0 (green), exit N (red),
 * or exit unknown (gray) — never by guessing from a sentinel.
 */
function StatusBadge({ status }: { status: CommandRecord["status"] }) {
  if (status.kind === "running") {
    return (
      <Badge size="xs" variant="light" color="blue">
        running
      </Badge>
    );
  }
  if (status.exitCode === null) {
    return (
      <Badge size="xs" variant="light" color="gray">
        done
      </Badge>
    );
  }
  const ok = status.exitCode === 0;
  return (
    <Badge size="xs" variant="light" color={ok ? "green" : "red"}>
      exit {status.exitCode}
    </Badge>
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
          paneIndex: p.index,
        });
      }
    }
  }
  return map;
}
