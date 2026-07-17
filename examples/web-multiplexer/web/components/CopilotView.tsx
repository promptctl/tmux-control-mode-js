// examples/web-multiplexer/web/components/CopilotView.tsx
//
// AI Co-pilot — pick a pane, see its recent command history (chunked from the
// firehose by OSC 133 marks, reused whole from the Command Palette), and ask an
// LLM for the next commands to run, each with a one-click INSERT.
//
// THE HEADLINE: the bridge firehose hands the browser the raw command history
// of EVERY pane — command, output, exit code — and the co-pilot pipes that
// structured context to an LLM. The model's reply is parsed into suggestions
// the user can insert into the real pane (no Enter: the human reviews and runs).
//
// [LAW:types-are-the-program] `store.suggest` is a discriminated union; this
//   renders by exhaustive case (idle / loading / ready / error), never a guess.
// [LAW:no-silent-failure] An LLM error and a "no parseable suggestions" reply
//   are each a visible state — the raw reply is shown so nothing is hidden.
// [LAW:effects-at-boundaries] Insert goes through `store.insert` (the one write
//   boundary) and only on an explicit click; the view never auto-runs anything.

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
  Select,
  Loader,
  Alert,
} from "@mantine/core";
import type { DemoStore } from "../store.ts";
import type { UiStore } from "../ui-store.ts";
import type { CopilotStore, CommandRecord } from "../copilot-store.ts";

interface Props {
  readonly demoStore: DemoStore;
  readonly store: CopilotStore;
  readonly uiStore: UiStore;
}

interface PaneLocation {
  readonly sessionId: number;
  readonly sessionName: string;
  readonly windowId: number;
  readonly windowIndex: number;
  readonly paneIndex: number;
}

export const CopilotView = observer(function CopilotView({
  demoStore,
  store,
  uiStore,
}: Props) {
  const locations = useMemo(
    () => buildPaneLocations(demoStore),
    [demoStore.sessions],
  );

  const paneOptions = store.panesWithHistory.map((paneId) => ({
    value: String(paneId),
    label: paneLabel(paneId, locations),
  }));
  const selectedLabel =
    store.selectedPaneId === null
      ? ""
      : paneLabel(store.selectedPaneId, locations);
  const recent = store.recentCommands;
  const canSuggest =
    store.selectedPaneId !== null && store.suggest.kind !== "loading";

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Paper withBorder p="xs">
        <Group gap="md" wrap="wrap">
          <Text fw={600} size="sm">
            AI Co-pilot
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
          <Select
            size="xs"
            placeholder="pick a pane with history…"
            data={paneOptions}
            value={
              store.selectedPaneId === null ? null : String(store.selectedPaneId)
            }
            onChange={(v) => store.selectPane(v === null ? null : Number(v))}
            style={{ flex: 1, minWidth: 220 }}
            nothingFoundMessage="no pane has OSC 133 history yet"
            searchable
          />
          <Button
            size="xs"
            color="grape"
            onClick={() => void store.requestSuggestions(selectedLabel)}
            disabled={!canSuggest}
            loading={store.suggest.kind === "loading"}
          >
            Suggest
          </Button>
        </Group>
      </Paper>

      <Group align="stretch" gap="sm" style={{ flex: 1, minHeight: 0 }} wrap="nowrap">
        <ContextPanel recent={recent} selected={store.selectedPaneId !== null} />
        <SuggestionsPanel
          store={store}
          paneLabel={selectedLabel}
          onJump={() => {
            if (store.selectedPaneId === null) return;
            const loc = locations.get(store.selectedPaneId);
            if (loc === undefined) return;
            demoStore.jumpToPane(loc.sessionId, loc.windowId, store.selectedPaneId);
            uiStore.setAppMode("multiplexer");
          }}
        />
      </Group>
    </Stack>
  );
});

// ---------------------------------------------------------------------------
// Left: the command-history context fed to the model
// ---------------------------------------------------------------------------

function ContextPanel({
  recent,
  selected,
}: {
  recent: readonly CommandRecord[];
  selected: boolean;
}) {
  return (
    <Paper
      withBorder
      p="xs"
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        background: "var(--mantine-color-dark-9, #0b0d10)",
      }}
    >
      <Stack gap="xs" style={{ height: "100%", minHeight: 0 }}>
        <Text size="xs" c="dimmed" fw={600}>
          CONTEXT — recent commands sent to the model
        </Text>
        <ScrollArea style={{ flex: 1 }} type="auto">
          {!selected ? (
            <Text c="dimmed" size="sm" p="sm">
              Pick a pane above. Its recent commands — each command line, a bound
              preview of its output, and its exit code — are chunked from the{" "}
              <code>pipe-pane</code> firehose by the shell&apos;s{" "}
              <code>OSC 133</code> prompt marks, then piped to an LLM as context.
              Only panes whose shell has integration enabled contribute history
              (no prompt guessing). Test with{" "}
              <code>
                printf
                &apos;\e]133;A\e\\$ \e]133;B\e\\date\n\e]133;C\e\\Mon\n\e]133;D;0\e\\&apos;
              </code>{" "}
              in a pane.
            </Text>
          ) : recent.length === 0 ? (
            <Text c="dimmed" size="sm" p="sm">
              No commands recorded in this pane yet — run a command in it (with
              shell integration) and it appears here.
            </Text>
          ) : (
            <Stack gap="xs" p="xs">
              {[...recent].reverse().map((c) => (
                <ContextRow key={c.id} entry={c} />
              ))}
            </Stack>
          )}
        </ScrollArea>
      </Stack>
    </Paper>
  );
}

function ContextRow({ entry }: { entry: CommandRecord }) {
  return (
    <Paper withBorder p="xs" bg="dark.8">
      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
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
      </Group>
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Right: the model's suggestions, rendered by exhaustive SuggestState case
// ---------------------------------------------------------------------------

const SuggestionsPanel = observer(function SuggestionsPanel({
  store,
  paneLabel,
  onJump,
}: {
  store: CopilotStore;
  paneLabel: string;
  onJump: () => void;
}) {
  const s = store.suggest;
  return (
    <Paper
      withBorder
      p="xs"
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        background: "var(--mantine-color-dark-9, #0b0d10)",
      }}
    >
      <Stack gap="xs" style={{ height: "100%", minHeight: 0 }}>
        <Text size="xs" c="dimmed" fw={600}>
          SUGGESTIONS — insert into {paneLabel === "" ? "the pane" : paneLabel}{" "}
          (review, then press Enter)
        </Text>
        <ScrollArea style={{ flex: 1 }} type="auto">
          {s.kind === "idle" ? (
            <Text c="dimmed" size="sm" p="sm">
              Click <strong>Suggest</strong> to ask the model for the next
              commands to run, given this pane&apos;s history. Inserts leave the
              command on the prompt for you to run — the co-pilot never executes
              anything itself.
            </Text>
          ) : s.kind === "loading" ? (
            <Group gap="xs" p="sm">
              <Loader size="xs" color="grape" />
              <Text c="dimmed" size="sm">
                asking the model…
              </Text>
            </Group>
          ) : s.kind === "error" ? (
            <Alert color="red" variant="light" title="LLM call failed" m="xs">
              <Text size="sm">{s.message}</Text>
              <Text size="xs" c="dimmed" mt={6}>
                The bridge calls an OpenAI-compatible endpoint (default local
                Ollama at <code>http://localhost:11434/v1</code>). Set{" "}
                <code>COPILOT_LLM_BASE_URL</code>, <code>COPILOT_LLM_MODEL</code>{" "}
                and <code>COPILOT_LLM_API_KEY</code> to point it elsewhere.
              </Text>
            </Alert>
          ) : s.suggestions.length === 0 ? (
            <Stack gap="xs" p="xs">
              <Text c="dimmed" size="sm">
                The model replied but no runnable command could be extracted. Its
                raw answer:
              </Text>
              <Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {s.raw}
              </Code>
            </Stack>
          ) : (
            <Stack gap="xs" p="xs">
              {s.suggestions.map((sug, i) => (
                <Paper key={`${sug.command}-${i}`} withBorder p="xs" bg="dark.8">
                  <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
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
                      title={sug.command}
                    >
                      {sug.command}
                    </Code>
                    <Button
                      size="compact-xs"
                      variant="light"
                      color="grape"
                      onClick={() => {
                        store.insert(sug);
                        onJump();
                      }}
                      title={`insert into ${paneLabel} (no Enter — you run it)`}
                    >
                      Insert
                    </Button>
                  </Group>
                  {sug.reason !== "" && (
                    <Text size="xs" c="dimmed" mt={4}>
                      {sug.reason}
                    </Text>
                  )}
                </Paper>
              ))}
            </Stack>
          )}
        </ScrollArea>
      </Stack>
    </Paper>
  );
});

/**
 * The outcome badge. [LAW:types-are-the-program] `status` is a discriminated
 * union; renders by exhaustive case — running, exit 0, exit N, or exit unknown.
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
  for (const sn of demoStore.sessions) {
    for (const w of sn.windows) {
      for (const p of w.panes) {
        map.set(p.id, {
          sessionId: sn.id,
          sessionName: sn.name,
          windowId: w.id,
          windowIndex: w.index,
          paneIndex: p.index,
        });
      }
    }
  }
  return map;
}

function paneLabel(paneId: number, locations: Map<number, PaneLocation>): string {
  const loc = locations.get(paneId);
  return loc === undefined
    ? `%${paneId}`
    : `${loc.sessionName}:${loc.windowIndex}.${loc.paneIndex}`;
}
