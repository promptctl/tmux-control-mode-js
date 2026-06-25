// examples/web-multiplexer/web/broadcast-engine.ts
//
// The pure core of "smart broadcast input with per-pane transforms": type one
// template, send it to N panes, but resolve it PER TARGET so each pane receives
// bytes transformed for it (e.g. `ssh ${host}` with a different host per pane).
//
// THE AXIS IS INPUT, NOT OUTPUT. Every prior showcase demo taps a pane's output
// and projects it; this is the first that drives the WRITE path — the bytes that
// `sendKeys` (`send-keys -H`) puts on the wire. Native tmux broadcast
// (`synchronize-panes`) sends IDENTICAL keystrokes to panes in ONE window; this
// resolves a distinct payload per target across any windows/sessions. The "smart"
// is the per-pane transform, and the transform is a VALUE: a binding map per pane.
//
// THE TRANSFORM SOURCE NEVER REACHES THE ENGINE. A binding may come from a live
// pane fact (`${pane}`, `${title}`) or a user-typed override (`${host}`); this
// module resolves a single merged `Record<string,string>` and is blind to which.
// Same shape as .11's "the oracle is a value": the demo and the unit tests feed
// the identical resolver. [LAW:dataflow-not-control-flow] per-pane variation lives
// in the binding values + the resolution union, never in a branch on the pane.
//
// AN UNBOUND VARIABLE IS A LOUD FAILURE, NOT AN EMPTY STRING. `${host}` with no
// binding makes that pane `unresolved` and names the missing variables; it is
// never substituted with "". [LAW:no-silent-failure] a silent "" would send a
// half-formed command (`ssh ` → `ssh` with no host) to a real shell — exactly the
// quiet corruption the law forbids. The store excludes unresolved panes from the
// send and surfaces them.
//
// [LAW:effects-at-boundaries] Zero IO, zero MobX, zero DOM — a deterministic
//   projection of (template, per-pane bindings) → per-pane bytes, unit-tested
//   against literal templates and synthetic binding maps. The store assembles the
//   bindings from the live pane model and fans the resolved bytes out over
//   `sendKeys`; this module knows nothing of either.

// ---------------------------------------------------------------------------
// Template language
// ---------------------------------------------------------------------------
//
// A template is literal spans interleaved with variable references. The syntax is
// shell-flavored, because "substitute $HOST" is what the feature promises:
//   ${name}  — explicit form; allows adjacent text, e.g. `${host}.local`
//   $name    — bare form; `name` is /[A-Za-z_][A-Za-z0-9_]*/
//   $$       — a literal `$`
// A `$` that begins neither a valid `$name` nor `${...}` is a literal `$`. This
// is a DIFFERENT language than .4's ANSI byte escapes, so it gets its own
// tokenizer rather than a false reuse of `parseEscapes`. [LAW:one-type-per-behavior]

/** One span of a parsed template: literal text, or a variable reference. */
export type TemplateToken =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "var"; readonly name: string };

export type Template = readonly TemplateToken[];

const VAR_START = /[A-Za-z_]/;
const VAR_CHAR = /[A-Za-z0-9_]/;

/**
 * Parse a template into tokens. Total over every string — any malformed `$` (a
 * trailing `$`, `${` with no close, `$` before a non-name char) degrades to a
 * literal `$` rather than throwing, so a half-typed template in the editor always
 * has a well-defined (if not-yet-useful) meaning. Adjacent literal characters are
 * coalesced so resolution walks the minimum number of tokens.
 */
export function parseTemplate(template: string): Template {
  const tokens: TemplateToken[] = [];
  let literal = "";
  const flush = (): void => {
    if (literal.length > 0) {
      tokens.push({ kind: "literal", text: literal });
      literal = "";
    }
  };

  let i = 0;
  while (i < template.length) {
    const c = template[i];
    if (c !== "$") {
      literal += c;
      i += 1;
      continue;
    }
    const next = template[i + 1];
    if (next === "$") {
      literal += "$";
      i += 2;
      continue;
    }
    if (next === "{") {
      const close = template.indexOf("}", i + 2);
      const name = close === -1 ? "" : template.slice(i + 2, close);
      // A well-formed `${name}` needs a non-empty name of name-chars only.
      if (close !== -1 && name.length > 0 && [...name].every((ch) => VAR_CHAR.test(ch))) {
        flush();
        tokens.push({ kind: "var", name });
        i = close + 1;
        continue;
      }
      literal += "$";
      i += 1;
      continue;
    }
    if (next !== undefined && VAR_START.test(next)) {
      let j = i + 1;
      while (j < template.length && VAR_CHAR.test(template[j])) j += 1;
      flush();
      tokens.push({ kind: "var", name: template.slice(i + 1, j) });
      i = j;
      continue;
    }
    // Bare `$` before EOF or a non-name char — a literal dollar.
    literal += "$";
    i += 1;
  }
  flush();
  return tokens;
}

/**
 * The distinct variable names a template references, in first-appearance order.
 * The view uses this to know which override columns to surface (the referenced
 * vars that are not built-in pane facts). [LAW:one-source-of-truth] the set of
 * referenced variables is derived from the template, never tracked separately.
 */
export function templateVars(template: string): readonly string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const tok of parseTemplate(template)) {
    if (tok.kind === "var" && !seen.has(tok.name)) {
      seen.add(tok.name);
      order.push(tok.name);
    }
  }
  return order;
}

// ---------------------------------------------------------------------------
// Built-in bindings (pure projection of a pane's facts)
// ---------------------------------------------------------------------------

/**
 * A pane's facts, as plain data lifted off the live pane model at the store
 * boundary. Kept pure here so the built-in binding spelling has ONE definition
 * the tests can pin without a tmux server.
 */
export interface PaneFacts {
  readonly paneId: number;
  readonly paneIndex: number;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly windowName: string;
  readonly windowIndex: number;
  readonly sessionName: string;
}

/**
 * The variable names every pane carries for free. Surfaced to the view so it can
 * distinguish "needs a user override" from "resolves from the pane itself".
 */
export const BUILTIN_VARS = [
  "pane",
  "index",
  "title",
  "width",
  "height",
  "window",
  "windowindex",
  "session",
] as const;

export type BuiltinVar = (typeof BUILTIN_VARS)[number];

/**
 * The built-in bindings for one pane. `pane` is the bare numeric id (no `%`),
 * matching what a user would type into a command. Overrides are merged on top of
 * these by the store, so a user may intentionally shadow a built-in.
 */
export function builtinBindings(facts: PaneFacts): Record<BuiltinVar, string> {
  return {
    pane: String(facts.paneId),
    index: String(facts.paneIndex),
    title: facts.title,
    width: String(facts.width),
    height: String(facts.height),
    window: facts.windowName,
    windowindex: String(facts.windowIndex),
    session: facts.sessionName,
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** One target: a pane id and the merged bindings (built-ins ⊕ overrides). */
export interface PaneBindings {
  readonly paneId: number;
  readonly bindings: Readonly<Record<string, string>>;
}

/**
 * The result of resolving the template for one pane. A discriminated union so the
 * illegal states — "resolved but missing a var", "unresolved but no list" — are
 * unrepresentable. [LAW:types-are-the-program]
 */
export type PaneResolution =
  | { readonly kind: "resolved"; readonly paneId: number; readonly text: string }
  | {
      readonly kind: "unresolved";
      readonly paneId: number;
      readonly missing: readonly string[];
    };

export interface ResolveOptions {
  /**
   * Append a carriage return (`\r`, what the Enter key transmits) to every
   * resolved payload, so the broadcast RUNS each command rather than leaving it
   * un-submitted at the prompt. The `\r` is part of the resolved `text`, so the
   * view's preview is byte-identical to the wire. [LAW:one-source-of-truth]
   */
  readonly appendEnter: boolean;
}

/** Enter, as `send-keys -H` would carry it. */
const ENTER = "\r";

/**
 * Resolve `template` against each target's bindings. A referenced variable with
 * no binding key makes that pane `unresolved` and collects every missing name (in
 * first-appearance order, de-duplicated); a binding present but empty is a
 * deliberate empty substitution, NOT a miss. Pure: same inputs → same output, and
 * the template is parsed once for all panes.
 */
export function resolveBroadcast(
  template: string,
  targets: readonly PaneBindings[],
  opts: ResolveOptions,
): readonly PaneResolution[] {
  const tokens = parseTemplate(template);
  const suffix = opts.appendEnter ? ENTER : "";
  return targets.map((t) => resolveOne(tokens, t, suffix));
}

function resolveOne(
  tokens: Template,
  target: PaneBindings,
  suffix: string,
): PaneResolution {
  const missing: string[] = [];
  const missingSeen = new Set<string>();
  let text = "";
  for (const tok of tokens) {
    if (tok.kind === "literal") {
      text += tok.text;
      continue;
    }
    // `in`, not truthiness: an intentionally empty binding ("") is present.
    if (Object.prototype.hasOwnProperty.call(target.bindings, tok.name)) {
      text += target.bindings[tok.name];
      continue;
    }
    if (!missingSeen.has(tok.name)) {
      missingSeen.add(tok.name);
      missing.push(tok.name);
    }
  }
  if (missing.length > 0) {
    return { kind: "unresolved", paneId: target.paneId, missing };
  }
  return { kind: "resolved", paneId: target.paneId, text: text + suffix };
}

/**
 * Narrow a resolution list to the panes ready to send. The store fans `sendKeys`
 * over exactly these; the complement (unresolved) is surfaced, never sent.
 * [LAW:no-silent-failure] the split is explicit so a blocked broadcast is visible
 * rather than a silently shorter fan-out.
 */
export function sendablePanes(
  resolutions: readonly PaneResolution[],
): readonly { readonly paneId: number; readonly text: string }[] {
  return resolutions
    .filter((r): r is Extract<PaneResolution, { kind: "resolved" }> => r.kind === "resolved")
    .map((r) => ({ paneId: r.paneId, text: r.text }));
}
