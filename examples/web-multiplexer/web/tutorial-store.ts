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
import { withChaos } from "@promptctl/tmux-control-mode-js/chaos";
import { TmuxParser } from "@promptctl/tmux-control-mode-js/protocol";
import type { TmuxMessage } from "@promptctl/tmux-control-mode-js/protocol";
import {
  TUTORIAL_SCENARIOS,
  DEFAULT_SCENARIO_ID,
  type TutorialScenario,
} from "./tutorial-scenarios.ts";

/** The chaos a learner dials in; all-zero is a transparent pass-through. */
export interface ChaosConfig {
  /** P(an inbound line is dropped), 0..1. */
  readonly dropRate: number;
  /** P(an inbound line is corrupted), 0..1. */
  readonly corruptRate: number;
  /** Fixed delivery delay in ms (0 = synchronous). */
  readonly latencyMs: number;
  /** Seed — same seed + same dials replays the exact same chaotic run. */
  readonly seed: number;
}

const CLEAN: ChaosConfig = { dropRate: 0, corruptRate: 0, latencyMs: 0, seed: 1 };

/** What chaos did to an inbound line: delivered intact, or delivered corrupted. */
export type WireFate = "clean" | "corrupted";

/** One line on the wire, tagged by direction (client→server vs server→client). */
export interface WireLine {
  readonly seq: number;
  readonly dir: "in" | "out";
  readonly text: string;
  /** For inbound lines: chaos's verdict. Outbound lines carry none. */
  readonly fate?: WireFate;
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
  /** The chaos dialed in; applied on the next (re)load. */
  chaos: ChaosConfig = CLEAN;
  /** Change-signal: bumped on every wire/event mutation. */
  version = 0;

  private server!: MockTmuxServer;
  private parser!: TmuxParser;
  private _wire: WireLine[] = [];
  private _events: EventEntry[] = [];
  private seq = 0;

  // Chaos accounting: every line the mock SENT, counted into `_sent`; every line
  // chaos DELIVERED, counted into `_delivered` (and `_corrupted` when mangled).
  // Drops fall out as `_sent - _delivered` — no fragile positional matching.
  private _sent = 0;
  private _delivered = 0;
  private _corrupted = 0;
  // [LAW:no-ambient-temporal-coupling] A reload starts a new epoch; a late
  // (latency-delayed) delivery from a prior epoch is ignored, never leaking into
  // the fresh session's captured streams.
  private epoch = 0;
  // Multiset of lines the mock sent this epoch, to classify a delivered line as
  // clean (present) or corrupted (absent).
  private pendingSent = new Map<string, number>();

  constructor() {
    makeAutoObservable<
      this,
      | "server"
      | "parser"
      | "_wire"
      | "_events"
      | "seq"
      | "_sent"
      | "_delivered"
      | "_corrupted"
      | "epoch"
      | "pendingSent"
    >(this, {
      server: false,
      parser: false,
      _wire: false,
      _events: false,
      seq: false,
      _sent: false,
      _delivered: false,
      _corrupted: false,
      epoch: false,
      pendingSent: false,
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
    this._sent = 0;
    this._delivered = 0;
    this._corrupted = 0;
    this.pendingSent = new Map();
    const gen = ++this.epoch;

    // The parser surfaces every message it decodes from the inbound wire.
    this.parser = new TmuxParser((msg) => {
      this._events.push({ seq: this.seq++, message: msg });
    });

    // A real wall clock for the guard timestamps — this is the browser, not a
    // determinism-sensitive test, so a real `now` makes the wire authentic.
    this.server = new MockTmuxServer(scenario.scenario, {
      now: () => Math.floor(Date.now() / 1000),
    });

    // Count + remember every line the mock SENT (registered before withChaos so
    // the multiset is populated before chaos classifies a synchronous delivery).
    this.server.onData((chunk) => {
      this._sent++;
      this.pendingSent.set(chunk, (this.pendingSent.get(chunk) ?? 0) + 1);
    });

    // The genuine library decorator perturbs the stream the parser sees — "watch
    // the library cope" is literal here, not a simulation. A real setTimeout
    // clock realises latency in the live tab.
    const source = withChaos(this.server, {
      dropRate: this.chaos.dropRate,
      corruptRate: this.chaos.corruptRate,
      latencyMs: { min: this.chaos.latencyMs, max: this.chaos.latencyMs },
      seed: this.chaos.seed,
    });
    source.onData((chunk) => {
      if (gen !== this.epoch) return; // stale delayed delivery from a prior epoch
      const fate: WireFate = this.takePending(chunk) ? "clean" : "corrupted";
      this._delivered++;
      if (fate === "corrupted") this._corrupted++;
      this._wire.push({ seq: this.seq++, dir: "in", text: stripTrailingLf(chunk), fate });
      this.parser.feed(chunk);
      this.version++;
    });

    this.server.start();
    this.version++;
  }

  /** Apply new chaos dials and replay the current scenario under them. */
  setChaos(partial: Partial<ChaosConfig>): void {
    this.chaos = { ...this.chaos, ...partial };
    this.load(this.scenarioId);
  }

  // Decrement the multiset for a delivered line; true if it was a line the mock
  // genuinely sent (clean), false if chaos fabricated/mangled it (corrupted).
  private takePending(chunk: string): boolean {
    const n = this.pendingSent.get(chunk) ?? 0;
    if (n <= 0) return false;
    this.pendingSent.set(chunk, n - 1);
    return true;
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

  /** Live tally of what chaos did to the inbound stream this run. */
  get chaosStats(): {
    readonly sent: number;
    readonly delivered: number;
    readonly dropped: number;
    readonly corrupted: number;
  } {
    void this.version;
    return {
      sent: this._sent,
      delivered: this._delivered,
      dropped: this._sent - this._delivered,
      corrupted: this._corrupted,
    };
  }

  /** True when any chaos dial is engaged. */
  get chaosActive(): boolean {
    void this.version;
    return (
      this.chaos.dropRate > 0 ||
      this.chaos.corruptRate > 0 ||
      this.chaos.latencyMs > 0
    );
  }
}

function scenarioById(id: string): TutorialScenario {
  return TUTORIAL_SCENARIOS.find((s) => s.id === id) ?? TUTORIAL_SCENARIOS[0];
}

function stripTrailingLf(chunk: string): string {
  return chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk;
}
