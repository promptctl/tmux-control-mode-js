// examples/web-multiplexer/web/tutorial-store.ts
//
// TutorialStore — the IO boundary for the Protocol Tutorial. Unlike every other
// demo mode, it touches NO tmux, NO bridge, NO firehose: it runs a real
// MockTmuxServer wired to a real TmuxParser entirely in the browser, both pulled
// from the library's browser-safe subpaths (`/mock`, `/protocol`). That is the
// whole point — you learn the wire protocol with zero tmux installed, and the
// fact that the genuine library mock + parser run unmodified in a browser tab is
// itself the proof that they are pure.
//
// It captures two streams: the raw wire lines the mock emits / the user sends
// (the BYTES), and the TmuxMessages the parser produces from them (the MEANING).
// Seeing both side by side is the lesson.
//
// [LAW:effects-at-boundaries] The mock + parser are pure; this store is the only
//   stateful, observable shell around them.
// [LAW:one-source-of-truth] `_wire` / `_events` are the captured truth; `version`
//   is a change-signal for the non-observable mock + parser, never a second copy
//   of their state (mirrors PromptStore's pattern).
// [LAW:no-ambient-temporal-coupling] Notifications advance only on an explicit
//   `step()`; commands only on `sendCommand()`. Nothing fires on a timer — the
//   learner owns the clock.

import { makeAutoObservable } from "mobx";
import { MockTmuxServer } from "@promptctl/tmux-control-mode-js/mock";
import { TmuxParser } from "@promptctl/tmux-control-mode-js/protocol";
import type { TmuxMessage } from "@promptctl/tmux-control-mode-js/protocol";
import {
  TUTORIAL_SCENARIOS,
  DEFAULT_SCENARIO_ID,
  type TutorialScenario,
} from "./tutorial-scenarios.ts";

/** One line on the wire, tagged by direction (client→server vs server→client). */
export interface WireLine {
  readonly seq: number;
  readonly dir: "in" | "out";
  readonly text: string;
}

/** One parsed message the client surfaces from the inbound wire. */
export interface EventEntry {
  readonly seq: number;
  readonly message: TmuxMessage;
}

export class TutorialStore {
  scenarioId: string = DEFAULT_SCENARIO_ID;
  /** Number of timeline steps already emitted for the current scenario. */
  stepIndex = 0;
  /** The command the user is composing (controlled input). */
  command = "";
  /** Change-signal: bumped on every wire/event mutation. */
  version = 0;

  private server!: MockTmuxServer;
  private parser!: TmuxParser;
  private _wire: WireLine[] = [];
  private _events: EventEntry[] = [];
  private seq = 0;

  constructor() {
    makeAutoObservable<
      this,
      "server" | "parser" | "_wire" | "_events" | "seq"
    >(this, {
      server: false,
      parser: false,
      _wire: false,
      _events: false,
      seq: false,
    });
    this.load(DEFAULT_SCENARIO_ID);
  }

  dispose(): void {
    this.server.close();
  }

  // -------------------------------------------------------------------------
  // Scenario lifecycle
  // -------------------------------------------------------------------------

  /** Load (or reload) a scenario: a fresh mock + parser, greeting delivered. */
  load(id: string): void {
    const scenario = scenarioById(id);
    this.scenarioId = scenario.id;
    this._wire = [];
    this._events = [];
    this.seq = 0;
    this.stepIndex = 0;
    this.command = "";

    // The parser surfaces every message it decodes from the inbound wire.
    this.parser = new TmuxParser((msg) => {
      this._events.push({ seq: this.seq++, message: msg });
    });

    // A real wall clock for the guard timestamps — this is the browser, not a
    // determinism-sensitive test, so a real `now` makes the wire authentic.
    this.server = new MockTmuxServer(scenario.scenario, {
      now: () => Math.floor(Date.now() / 1000),
    });
    this.server.onData((chunk) => {
      this._wire.push({ seq: this.seq++, dir: "in", text: stripTrailingLf(chunk) });
      this.parser.feed(chunk);
    });

    this.server.start();
    this.version++;
  }

  selectScenario(id: string): void {
    this.load(id);
  }

  /** Replay the current scenario from its greeting. */
  reset(): void {
    this.load(this.scenarioId);
  }

  // -------------------------------------------------------------------------
  // Driving the session
  // -------------------------------------------------------------------------

  /** Emit the next notification on the scenario's timeline. */
  step(): void {
    const steps = this.scenario.steps;
    if (this.stepIndex >= steps.length) return;
    const next = steps[this.stepIndex];
    this.stepIndex++;
    this.server.emit(next.emit);
    this.version++;
  }

  setCommand(text: string): void {
    this.command = text;
  }

  /**
   * Send a command line. The mock frames it in a %begin/%end (or %error) guard
   * block; the inbound block flows back through the same wire + parser capture.
   */
  sendCommand(commandLine: string): void {
    const cmd = commandLine.trim();
    if (cmd === "") return;
    this._wire.push({ seq: this.seq++, dir: "out", text: cmd });
    this.server.send(cmd + "\n");
    this.command = "";
    this.version++;
  }

  // -------------------------------------------------------------------------
  // Derived (read `version` so the non-observable mock/parser drive recompute)
  // -------------------------------------------------------------------------

  get scenario(): TutorialScenario {
    return scenarioById(this.scenarioId);
  }

  get wire(): readonly WireLine[] {
    void this.version;
    return this._wire;
  }

  get events(): readonly EventEntry[] {
    void this.version;
    return this._events;
  }

  /** The note for the step that will run next (null when the timeline is done). */
  get nextStepNote(): string | null {
    void this.version;
    const steps = this.scenario.steps;
    return this.stepIndex < steps.length ? steps[this.stepIndex].note : null;
  }

  get atTimelineEnd(): boolean {
    void this.version;
    return this.stepIndex >= this.scenario.steps.length;
  }
}

function scenarioById(id: string): TutorialScenario {
  return TUTORIAL_SCENARIOS.find((s) => s.id === id) ?? TUTORIAL_SCENARIOS[0];
}

function stripTrailingLf(chunk: string): string {
  return chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk;
}
