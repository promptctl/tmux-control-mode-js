// examples/web-multiplexer/web/copilot-engine.ts
//
// AI Co-pilot — the PURE engine. Two pure functions bracket the one network
// effect (the LLM call, which lives in the bridge):
//
//   buildCopilotMessages : CommandRecord[] (recent history)  → ChatMessage[]
//   parseSuggestions     : raw model completion (string)     → CommandSuggestion[]
//
// Everything interesting and fallible about the co-pilot is here and is unit
// tested with no network: composing the prompt from the structured OSC 133
// command history (reused whole from .17's PromptEngine — `CommandRecord`
// already carries command + bounded output + exit status, exactly the context
// an LLM wants), and EXTRACTING structured suggestions back out of a messy
// reply. The reply is untrusted text: a reasoning model (e.g. qwen3) emits a
// `<think>…</think>` block, then a JSON array, sometimes wrapped in markdown
// fences or prose. Turning that into a typed list is the real work.
//
// [LAW:effects-at-boundaries] Zero IO. The messy parse is pure logic, separable
//   from the network call the bridge owns.
// [LAW:composability] Reuses `CommandRecord` from the prompt engine verbatim —
//   the co-pilot adds prompt-construction + reply-parsing, re-deriving nothing
//   about prompt boundaries or command history.
// [LAW:types-are-the-program] A `CommandSuggestion` always carries a NON-EMPTY
//   command; an entry the model returns without a usable command string is
//   unrepresentable (dropped at the parse boundary), so the view never guards.
// [LAW:no-silent-failure] An unparseable reply yields zero suggestions, not a
//   fabricated one. The raw reply is surfaced alongside so "the model answered
//   but I could not extract a command" is visible, never hidden.

import type { ChatMessage } from "../shared/copilot-frame.ts";
import type { CommandRecord } from "./prompt-engine.ts";

/**
 * One suggested next command. `command` is a single runnable command line,
 * non-empty AND free of control characters by construction — the parse drops any
 * entry lacking a usable command, and any whose command carries a control char
 * (a `\r` reaching `send-keys` would auto-execute the untrusted line, defeating
 * the co-pilot's no-auto-Enter safety invariant). `reason` is a short
 * justification and may be "" when the model omitted one.
 */
export interface CommandSuggestion {
  readonly command: string;
  readonly reason: string;
}

/** How many recent commands of the selected pane to feed the model. */
const DEFAULT_MAX_COMMANDS = 8;
/** Per-command output preview cap (chars) inside the prompt — bounds prompt size. */
const OUTPUT_PREVIEW_CHARS = 600;

const SYSTEM_PROMPT = `You are a terminal co-pilot embedded in a tmux pane. \
You are given the recent shell command history of ONE pane — each command, a \
preview of its output, and its exit code. Suggest up to 3 commands the user is \
likely to run NEXT. Prefer commands that follow naturally from the visible \
context: fix an error that just occurred, inspect a result, or the obvious next \
step in the workflow. Respond with ONLY a JSON array, no prose and no markdown \
code fences, in exactly this shape:
[{"command": "<a runnable shell command>", "reason": "<short why, <= 80 chars>"}]
If nothing sensible follows, respond with [].`;

/**
 * Build the chat messages for the LLM from a pane's recent command history.
 * Pure. The most recent `max` commands are rendered oldest-first (the order a
 * human reads them), each with its outcome and a bounded output preview.
 */
export function buildCopilotMessages(
  commands: readonly CommandRecord[],
  opts: { readonly paneLabel: string; readonly max?: number },
): ChatMessage[] {
  const max = opts.max ?? DEFAULT_MAX_COMMANDS;
  const recent = commands.slice(-max);
  const body =
    recent.length === 0
      ? "(no commands have been recorded in this pane yet)"
      : recent.map(renderCommand).join("\n\n");
  const user = `Pane ${opts.paneLabel} — recent command history:\n\n${body}\n\nSuggest the next commands.`;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

/** Render one command record as a compact prompt line + bounded output preview. */
function renderCommand(c: CommandRecord): string {
  const status =
    c.status.kind === "running"
      ? "running"
      : `exit ${c.status.exitCode ?? "unknown"}`;
  const output = c.output.trim();
  const preview = output === "" ? "" : `\n${truncate(output, OUTPUT_PREVIEW_CHARS)}`;
  return `$ ${c.command}   [${status}]${preview}`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… (${s.length - max} more chars)`;
}

/**
 * Parse a raw model completion into a list of suggestions. Pure and tolerant of
 * the real shapes a reasoning model emits:
 *   - a leading `<think>…</think>` block (stripped),
 *   - the JSON array wrapped in markdown fences or surrounding prose (extracted
 *     by a string-aware bracket walk, not a regex),
 *   - object entries missing `command`, or with a non-string / empty command,
 *     or whose command carries a control character (all dropped — a suggestion
 *     with no usable, safe command is unrepresentable),
 *   - duplicate commands (first kept).
 * A reply with no extractable array yields `[]`. [LAW:no-silent-failure]
 */
export function parseSuggestions(content: string): CommandSuggestion[] {
  const json = extractJsonArray(stripThinking(content));
  if (json === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: CommandSuggestion[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    const suggestion = toSuggestion(item);
    if (suggestion === null || seen.has(suggestion.command)) continue;
    seen.add(suggestion.command);
    out.push(suggestion);
  }
  return out;
}

/** Coerce one array element into a `CommandSuggestion`, or `null` if unusable. */
function toSuggestion(item: unknown): CommandSuggestion | null {
  if (typeof item !== "object" || item === null) return null;
  const rec = item as Record<string, unknown>;
  if (typeof rec.command !== "string") return null;
  // [LAW:single-enforcer] The one boundary where an LLM-sourced command becomes a
  // CommandSuggestion — so the sole place the control-char safety invariant is
  // enforced. Test the RAW string before trimming: a trailing `\r` must be
  // rejected, not silently trimmed away into a command that looks clean but was
  // altered. An interior control char (`\r`, ESC, ETX, …) would reach send-keys
  // and auto-execute the untrusted line, so the whole entry is dropped — never
  // stripped. [LAW:types-are-the-program] downstream (CopilotStore.insert) can
  // then treat every CommandSuggestion.command as safe to send with no re-check.
  if (hasControlChar(rec.command)) return null;
  const command = rec.command.trim();
  if (command === "") return null;
  const reason = typeof rec.reason === "string" ? rec.reason.trim() : "";
  return { command, reason };
}

/**
 * True if `s` contains any C0 control character (`\x00`–`\x1f`, which includes
 * `\r`, `\n`, `\t`, `\x03` ETX and `\x1b` ESC) or DEL (`\x7f`). A runnable
 * command line contains none — a codepoint scan rather than a regex so no
 * intentional control-char literal lives in the source.
 */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Remove well-formed `<think>…</think>` reasoning blocks. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * Extract the first top-level JSON array `[ … ]` from arbitrary text, balancing
 * brackets while respecting JSON string literals (so a `[` inside a `"reason"`
 * doesn't miscount). Returns the array substring, or `null` if none balances.
 */
function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
