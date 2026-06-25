// examples/web-multiplexer/web/components/TutorialView.tsx
//
// Protocol Tutorial — "learn the tmux control-mode protocol without installing
// tmux." A real MockTmuxServer and TmuxParser run in this browser tab (see
// TutorialStore). Pick a scripted scenario, step through its notifications, and
// send commands; watch the RAW WIRE the server emits next to the PARSED EVENTS
// the parser decodes from it. The two columns are the lesson: bytes on the left,
// meaning on the right.
//
// Pure projection: it reads `store.wire` and `store.events` and drives the store
// via explicit Step / Send actions. No local protocol state.
//
// [LAW:dataflow-not-control-flow] Both columns map the same render over their
//   array each pass; an empty session is the empty-array case, not a branch.
// [LAW:types-are-the-program] `describeMessage` switches over the TmuxMessage
//   discriminant, so each event renders by its real shape — no guessing.

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
  Select,
  SimpleGrid,
} from "@mantine/core";
import type { UiStore } from "../ui-store.ts";
import type { TutorialStore, WireLine, EventEntry } from "../tutorial-store.ts";
import type { TmuxMessage } from "@promptctl/tmux-control-mode-js/protocol";
import { TUTORIAL_SCENARIOS } from "../tutorial-scenarios.ts";

interface Props {
  readonly store: TutorialStore;
  readonly uiStore: UiStore;
}

export const TutorialView = observer(function TutorialView({ store }: Props) {
  const scenario = store.scenario;
  const nextNote = store.nextStepNote;

  return (
    <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
      <Group justify="space-between" align="flex-end">
        <Stack gap={2} style={{ flex: 1 }}>
          <Group gap="xs">
            <Text fw={600}>Protocol Tutorial</Text>
            <Badge variant="light" color="grape">
              no tmux required
            </Badge>
          </Group>
          <Text size="sm" c="dimmed">
            A real <Code>MockTmuxServer</Code> + <Code>TmuxParser</Code> run in
            this tab. Left: the raw control-mode wire. Right: the parsed events.
          </Text>
        </Stack>
        <Select
          label="Scenario"
          value={store.scenarioId}
          onChange={(v) => v !== null && store.selectScenario(v)}
          data={TUTORIAL_SCENARIOS.map((s) => ({ value: s.id, label: s.title }))}
          allowDeselect={false}
          w={240}
        />
      </Group>

      <Text size="sm">{scenario.blurb}</Text>

      <Group gap="xs">
        <Button
          size="xs"
          onClick={() => store.step()}
          disabled={store.atTimelineEnd}
        >
          {store.atTimelineEnd ? "Timeline complete" : "Step ▶"}
        </Button>
        <Button size="xs" variant="default" onClick={() => store.reset()}>
          Reset
        </Button>
        {nextNote !== null && (
          <Text size="xs" c="dimmed" style={{ flex: 1 }}>
            Next: {nextNote}
          </Text>
        )}
      </Group>

      <Group gap="xs" align="flex-end">
        <TextInput
          label="Send a command"
          placeholder="list-windows -a"
          value={store.command}
          onChange={(e) => store.setCommand(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") store.sendCommand(store.command);
          }}
          style={{ flex: 1 }}
        />
        <Button size="sm" onClick={() => store.sendCommand(store.command)}>
          Send
        </Button>
      </Group>

      {scenario.suggestedCommands.length > 0 && (
        <Group gap="xs">
          {scenario.suggestedCommands.map((cmd) => (
            <Button
              key={cmd}
              size="compact-xs"
              variant="light"
              color="gray"
              onClick={() => store.sendCommand(cmd)}
            >
              <Code>{cmd}</Code>
            </Button>
          ))}
        </Group>
      )}

      <SimpleGrid cols={2} spacing="sm" style={{ flex: 1, minHeight: 0 }}>
        <WirePanel wire={store.wire} />
        <EventsPanel events={store.events} />
      </SimpleGrid>
    </Stack>
  );
});

function WirePanel({ wire }: { readonly wire: readonly WireLine[] }) {
  return (
    <Paper withBorder p="xs" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Text size="xs" fw={600} c="dimmed" mb={4}>
        WIRE — control-mode bytes
      </Text>
      <ScrollArea style={{ flex: 1 }}>
        <Stack gap={2}>
          {wire.length === 0 ? (
            <Text size="xs" c="dimmed">
              No traffic yet.
            </Text>
          ) : (
            wire.map((line) => (
              <Group key={line.seq} gap={6} wrap="nowrap" align="flex-start">
                <Badge
                  size="xs"
                  variant="filled"
                  color={line.dir === "out" ? "blue" : "teal"}
                  style={{ flexShrink: 0 }}
                >
                  {line.dir === "out" ? "→ tmux" : "tmux →"}
                </Badge>
                <Code style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                  {line.text === "" ? "·" : line.text}
                </Code>
              </Group>
            ))
          )}
        </Stack>
      </ScrollArea>
    </Paper>
  );
}

function EventsPanel({ events }: { readonly events: readonly EventEntry[] }) {
  return (
    <Paper withBorder p="xs" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Text size="xs" fw={600} c="dimmed" mb={4}>
        PARSED — TmuxMessage events
      </Text>
      <ScrollArea style={{ flex: 1 }}>
        <Stack gap={2}>
          {events.length === 0 ? (
            <Text size="xs" c="dimmed">
              No messages parsed yet.
            </Text>
          ) : (
            events.map((entry) => (
              <Group key={entry.seq} gap={6} wrap="nowrap" align="flex-start">
                <Badge size="xs" variant="light" color="grape" style={{ flexShrink: 0 }}>
                  {entry.message.type}
                </Badge>
                <Text size="xs" style={{ fontFamily: "monospace" }}>
                  {describeMessage(entry.message)}
                </Text>
              </Group>
            ))
          )}
        </Stack>
      </ScrollArea>
    </Paper>
  );
}

const textDecoder = new TextDecoder();

/**
 * A compact, human-readable summary of a parsed message's payload.
 * [LAW:types-are-the-program] Exhaustive over the discriminant; the renderer
 * never inspects a field a given variant doesn't carry.
 */
function describeMessage(msg: TmuxMessage): string {
  switch (msg.type) {
    case "begin":
    case "end":
    case "error":
      return `cmd #${msg.commandNumber} @${msg.timestamp} flags=${msg.flags}`;
    case "output":
      return `%${msg.paneId} → ${JSON.stringify(textDecoder.decode(msg.data))}`;
    case "extended-output":
      return `%${msg.paneId} age=${msg.age}ms → ${JSON.stringify(textDecoder.decode(msg.data))}`;
    case "pause":
    case "continue":
    case "pane-mode-changed":
      return `%${msg.paneId}`;
    case "window-add":
    case "window-close":
    case "unlinked-window-add":
    case "unlinked-window-close":
      return `@${msg.windowId}`;
    case "window-renamed":
    case "unlinked-window-renamed":
      return `@${msg.windowId} = ${JSON.stringify(msg.name)}`;
    case "window-pane-changed":
      return `@${msg.windowId} active=%${msg.paneId}`;
    case "layout-change":
      return `@${msg.windowId} ${msg.windowLayout}`;
    case "session-changed":
    case "session-renamed":
      return `$${msg.sessionId} = ${JSON.stringify(msg.name)}`;
    case "sessions-changed":
      return "(session set changed)";
    case "session-window-changed":
      return `$${msg.sessionId} → @${msg.windowId}`;
    case "client-session-changed":
      return `${msg.clientName} → $${msg.sessionId} ${JSON.stringify(msg.name)}`;
    case "client-detached":
      return msg.clientName;
    case "paste-buffer-changed":
    case "paste-buffer-deleted":
      return msg.name;
    case "subscription-changed":
      return `${msg.name} $${msg.sessionId}/@${msg.windowId}/%${msg.paneId} = ${JSON.stringify(msg.value)}`;
    case "message":
      return msg.message;
    case "config-error":
      return msg.error;
    case "exit":
      return msg.reason ?? "(clean)";
  }
}
