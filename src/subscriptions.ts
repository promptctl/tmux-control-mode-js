// src/subscriptions.ts
// Internal building blocks for typed format subscriptions.
//
// [LAW:one-source-of-truth] Format-string and row-parsing logic for typed
// helpers lives here only. TmuxClient owns the runtime state (router map,
// name counter, listener installation); this file owns the pure functions.
//
// [LAW:single-enforcer] Field/row separators are RS (\x1e) and US (\x1f).
// These C0 control bytes cannot appear in any tmux name (sessions, windows,
// panes), so they cannot collide with delimited field values — eliminating
// the demo's `\n` / `|` collision footgun by construction.

export const FIELD_SEP = "\x1f";
export const ROW_SEP = "\x1e";

export type Scope = "S" | "S:W" | "S:W:P";

// [LAW:dataflow-not-control-flow] One unconditional build path; the scope
// value selects which prefix wraps the inner field list.
const SCOPE_PREFIX: Readonly<Record<Scope, [string, string]>> = {
  S: ["#{S:", "}"],
  "S:W": ["#{S:#{W:", "}}"],
  "S:W:P": ["#{S:#{W:#{P:", "}}}"],
};

/**
 * Build a tmux format string for a given iteration scope and field list.
 *
 * Each field becomes `#{field}`, joined by US (\x1f) and terminated by RS
 * (\x1e). The whole list is wrapped in the scope iteration prefix:
 *
 *   buildScopedFormat("S:W:P", ["pane_id", "pane_index"])
 *     → "#{S:#{W:#{P:#{pane_id}\x1f#{pane_index}\x1e}}}"
 *
 * tmux iterates the chosen scope and emits one row per element, each row
 * carrying the requested fields in order.
 */
export function buildScopedFormat(
  scope: Scope,
  fields: readonly string[],
): string {
  const [open, close] = SCOPE_PREFIX[scope];
  const inner = fields.map((f) => `#{${f}}`).join(FIELD_SEP) + ROW_SEP;
  return `${open}${inner}${close}`;
}

/**
 * Parse a subscription value built with `buildScopedFormat` back into typed
 * row records. Empty trailing rows (from the trailing RS) are skipped.
 *
 *   parseRows("a\x1fb\x1ec\x1fd\x1e", ["x","y"])
 *     → [{x:"a", y:"b"}, {x:"c", y:"d"}]
 */
export function parseRows<F extends string>(
  value: string,
  fields: readonly F[],
): Record<F, string>[] {
  return value
    .split(ROW_SEP)
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(FIELD_SEP);
      const row = {} as Record<F, string>;
      fields.forEach((f, i) => {
        row[f] = parts[i] ?? "";
      });
      return row;
    });
}
