// examples/web-multiplexer/web/copilot-store.ts
//
// CopilotStore — the IO boundary for the AI co-pilot. It does NOT re-implement
// command-history extraction: it COMPOSES a PromptStore (the .17 OSC 133 engine
// + firehose + tick-drain) as its history source, and adds exactly two things —
// the async LLM request (a state machine) and a single "insert suggestion"
// write. [LAW:composability] one-thing-each parts combined: history(out) +
// suggest(round-trip) + insert(in).
//
// [LAW:effects-at-boundaries] All IO lives here: the composed PromptStore's
//   firehose, the injected `LlmClient.complete`, and the `sendKeys` insert. The
//   prompt construction + reply parse are the pure engine.
// [LAW:one-source-of-truth] The composed PromptStore IS the command-history
//   authority; this store filters it by pane, never keeps a second copy.
// [LAW:types-are-the-program] `suggest` is a discriminated union — idle /
//   loading / ready / error — so the view renders by exhaustive case and an
//   "error" or "no suggestions" state is a represented value, not a guess.
// [LAW:no-silent-failure] A failed LLM call lands in the `error` state and is
//   shown; the co-pilot never fabricates a suggestion to fill silence.

import { makeAutoObservable, runInAction } from "mobx";
import type { TmuxBridge } from "./bridge.ts";
import { PromptStore, type CommandRecord } from "./prompt-store.ts";
import {
  buildCopilotMessages,
  parseSuggestions,
  type CommandSuggestion,
} from "./copilot-engine.ts";
import type { LlmClient } from "./llm-client.ts";

/** How many of the selected pane's recent commands feed a suggestion request. */
const CONTEXT_COMMANDS = 8;

/**
 * The suggestion request lifecycle. [LAW:types-are-the-program] every state the
 * UI must render is a variant — there is no "loading" boolean plus a separate
 * "error" string that could disagree.
 */
export type SuggestState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly suggestions: readonly CommandSuggestion[];
      readonly raw: string;
    }
  | { readonly kind: "error"; readonly message: string };

export type { CommandSuggestion } from "./copilot-engine.ts";
export type { CommandRecord } from "./prompt-store.ts";

export class CopilotStore {
  /** True while the firehose taps are open (co-pilot mode is active). */
  active = false;
  /** The pane whose history drives suggestions (null = none picked yet). */
  selectedPaneId: number | null = null;
  /** The current suggestion request state. */
  suggest: SuggestState = { kind: "idle" };

  private readonly history: PromptStore;

  constructor(
    private readonly bridge: TmuxBridge,
    private readonly llm: LlmClient,
  ) {
    this.history = new PromptStore(bridge);
    makeAutoObservable<this, "history" | "bridge" | "llm">(this, {
      history: false,
      bridge: false,
      llm: false,
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle — delegated to the composed history store
  // -------------------------------------------------------------------------

  start(): void {
    if (this.active) return;
    this.active = true;
    this.history.start();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.history.stop();
    this.selectedPaneId = null;
    this.suggest = { kind: "idle" };
  }

  dispose(): void {
    this.history.dispose();
  }

  // -------------------------------------------------------------------------
  // Derived — read through the single history authority
  // -------------------------------------------------------------------------

  /** Distinct pane ids that have produced at least one command, recent first. */
  get panesWithHistory(): number[] {
    const seen = new Set<number>();
    const ordered: number[] = [];
    for (const c of [...this.history.commands].reverse()) {
      if (seen.has(c.paneId)) continue;
      seen.add(c.paneId);
      ordered.push(c.paneId);
    }
    return ordered;
  }

  /** The selected pane's recent commands (chronological), the LLM's context. */
  get recentCommands(): readonly CommandRecord[] {
    if (this.selectedPaneId === null) return [];
    const paneId = this.selectedPaneId;
    return this.history.commands
      .filter((c) => c.paneId === paneId)
      .slice(-CONTEXT_COMMANDS);
  }

  get tappedPaneCount(): number {
    return this.history.tappedPaneCount;
  }

  get commandCount(): number {
    return this.history.commandCount;
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  /** Pick the pane to suggest for; clears any prior suggestion. */
  selectPane(paneId: number | null): void {
    this.selectedPaneId = paneId;
    this.suggest = { kind: "idle" };
  }

  // -------------------------------------------------------------------------
  // The LLM round-trip (the new outbound effect)
  // -------------------------------------------------------------------------

  /**
   * Ask the LLM for next-command suggestions from the selected pane's history.
   * The pure engine builds the prompt and parses the reply; the injected client
   * performs the network effect. A represented error never throws past here.
   */
  async requestSuggestions(paneLabel: string): Promise<void> {
    if (this.selectedPaneId === null) return;
    const messages = buildCopilotMessages(this.recentCommands, { paneLabel });
    runInAction(() => {
      this.suggest = { kind: "loading" };
    });
    const result = await this.llm.complete(messages);
    runInAction(() => {
      this.suggest = result.ok
        ? {
            kind: "ready",
            suggestions: parseSuggestions(result.content),
            raw: result.content,
          }
        : { kind: "error", message: result.error };
    });
  }

  // -------------------------------------------------------------------------
  // The write path (outbound) — insert, never auto-run
  // -------------------------------------------------------------------------

  /**
   * Insert a suggested command into the selected pane WITHOUT a trailing Enter.
   * [LAW:effects-at-boundaries] the one write boundary, gated to an explicit
   * click. The missing `\r` is deliberate: LLM output is untrusted, so the
   * human stays the sole executor — they review the inserted line and press
   * Enter themselves. (Contrast PromptStore.rerun, which DOES append Enter for a
   * command the user already ran once.)
   */
  insert(command: string): void {
    if (this.selectedPaneId === null) return;
    // Fire-and-forget: a rejection (bridge closed mid-flight) carries no
    // action beyond what onState/onError already report.
    void this.bridge
      .sendKeys(`%${this.selectedPaneId}`, command)
      .catch(() => {});
  }
}
