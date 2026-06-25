// examples/web-multiplexer/web/tutorial-scenarios.ts
//
// Scripted scenarios for the Protocol Tutorial — the data half of "learn the
// tmux control-mode protocol without installing tmux." Each scenario is pure
// description: a greeting (the topology a freshly-attached control client sees),
// a reactive command responder, and a timeline of notifications to step through.
// The TutorialStore feeds these into a real MockTmuxServer + TmuxParser running
// IN THE BROWSER, so what you read here is exactly what crosses the wire.
//
// [LAW:effects-at-boundaries] Zero IO: scenarios are values. The MockTmuxServer
//   and TmuxParser (both browser-safe library subpaths) are the only moving
//   parts, and they live in the store.
// [LAW:one-source-of-truth] The MockScenario shape comes from the library; this
//   file only authors instances of it, never redefines it.

import type { MockScenario, CommandReply } from "@promptctl/tmux-control-mode-js/mock";
import type { TmuxMessage } from "@promptctl/tmux-control-mode-js/protocol";

/** One step on a scenario's notification timeline: a human note + what it emits. */
export interface TutorialStep {
  /** Plain-language explanation of what this notification means. */
  readonly note: string;
  /** The server-to-client notification pushed when this step runs. */
  readonly emit: TmuxMessage;
}

export interface TutorialScenario {
  readonly id: string;
  readonly title: string;
  /** One-line description shown under the picker. */
  readonly blurb: string;
  /** Greeting + command responder handed to the MockTmuxServer. */
  readonly scenario: MockScenario;
  /** Notification timeline the user steps through. */
  readonly steps: readonly TutorialStep[];
  /** Commands offered as one-click chips (each is handled by `scenario.respond`). */
  readonly suggestedCommands: readonly string[];
}

const enc = new TextEncoder();
/** Build a `%output` message; `text` may contain escape sequences (e.g. "\x1b[31m"). */
function out(paneId: number, text: string): TmuxMessage {
  return { type: "output", paneId, data: enc.encode(text) };
}

// ---------------------------------------------------------------------------
// Scenario 1 — a control client attaches and the session evolves
// ---------------------------------------------------------------------------

const startupRespond: MockScenario["respond"] = (command): CommandReply | undefined => {
  if (command.startsWith("list-sessions")) {
    return { kind: "ok", output: ["$1: main: 1 windows (attached)"] };
  }
  if (command.startsWith("list-windows")) {
    return { kind: "ok", output: ["@1 1 shell (active)", "@2 2 logs"] };
  }
  if (command.startsWith("list-panes")) {
    return { kind: "ok", output: ["%1 @1 $1", "%2 @2 $1"] };
  }
  // Every other command succeeds with no output — exactly how tmux answers
  // most state-changing commands (kill-window, rename, select).
  return undefined;
};

const SESSION_STARTUP: TutorialScenario = {
  id: "startup",
  title: "Session startup",
  blurb:
    "A control client attaches: the server greets it with the current session, then the topology evolves as windows open and panes produce output.",
  scenario: {
    greeting: [
      { type: "session-changed", sessionId: 1, name: "main" },
      { type: "sessions-changed" },
      { type: "window-add", windowId: 1 },
      {
        type: "layout-change",
        windowId: 1,
        windowLayout: "b1f2,80x24,0,0,1",
        windowVisibleLayout: "b1f2,80x24,0,0,1",
        windowFlags: "*",
      },
    ],
    respond: startupRespond,
  },
  steps: [
    {
      note: "A second window opens (e.g. the user ran `tmux new-window`). The server pushes a %window-add for @2.",
      emit: { type: "window-add", windowId: 2 },
    },
    {
      note: "The new window's pane prints a prompt. Pane bytes arrive as %output, octal-escaped for control characters.",
      emit: out(2, "$ "),
    },
    {
      note: "The user renames the first window to `editor` — a %window-renamed notification.",
      emit: { type: "window-renamed", windowId: 1, name: "editor" },
    },
    {
      note: "The active pane changes within window @1 — a %window-pane-changed notification.",
      emit: { type: "window-pane-changed", windowId: 1, paneId: 2 },
    },
    {
      note: "The session is renamed to `work` — a %session-renamed notification.",
      emit: { type: "session-renamed", sessionId: 1, name: "work" },
    },
  ],
  suggestedCommands: [
    "list-sessions",
    "list-windows -a",
    "list-panes -a -F '#{pane_id} #{window_id} #{session_id}'",
    "rename-window -t @1 editor",
  ],
};

// ---------------------------------------------------------------------------
// Scenario 2 — watching live pane output (octal escaping on the wire)
// ---------------------------------------------------------------------------

const LIVE_OUTPUT: TutorialScenario = {
  id: "output",
  title: "Live pane output",
  blurb:
    "Step through a command running in a pane. Notice how tmux octal-escapes every control byte (ESC → \\033, newline → \\012) so the wire stays line-oriented.",
  scenario: {
    greeting: [{ type: "session-changed", sessionId: 1, name: "main" }],
    // No command responder needed — this scenario is all notifications.
  },
  steps: [
    {
      note: "The user types `ls` and presses Enter. The shell echoes nothing yet; the first %output carries the command result's first line.",
      emit: out(1, "README.md  src  package.json\r\n"),
    },
    {
      note: "A colored `ls --color` line: the SGR sequence ESC[34m turns it blue. ESC is byte 0x1b → it crosses the wire as the octal escape \\033.",
      emit: out(1, "\x1b[34mnode_modules\x1b[0m\r\n"),
    },
    {
      note: "The shell redraws its prompt. Carriage return (0x0d) and the prompt text arrive together.",
      emit: out(1, "\r\x1b[32m➜\x1b[0m ~/project $ "),
    },
  ],
  suggestedCommands: [],
};

// ---------------------------------------------------------------------------
// Scenario 3 — a command fails (%error instead of %end)
// ---------------------------------------------------------------------------

const COMMAND_ERROR: TutorialScenario = {
  id: "error",
  title: "Command success & failure",
  blurb:
    "Every command produces a guard block: %begin, then output lines, then %end on success or %error on failure. Send a good command and a bad one to see both terminators.",
  scenario: {
    greeting: [{ type: "session-changed", sessionId: 1, name: "main" }],
    respond: (command): CommandReply | undefined => {
      if (command.startsWith("kill-pane")) {
        return { kind: "error", output: ["can't find pane: %99"] };
      }
      if (command.startsWith("display-message")) {
        return { kind: "ok", output: ["tmux 3.6a"] };
      }
      return undefined;
    },
  },
  steps: [],
  suggestedCommands: [
    "display-message -p '#{version}'",
    "kill-pane -t %99",
    "new-window -n logs",
  ],
};

/** The tutorial catalog, in display order. */
export const TUTORIAL_SCENARIOS: readonly TutorialScenario[] = [
  SESSION_STARTUP,
  LIVE_OUTPUT,
  COMMAND_ERROR,
];

export const DEFAULT_SCENARIO_ID = SESSION_STARTUP.id;
