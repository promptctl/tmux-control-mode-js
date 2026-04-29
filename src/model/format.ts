// src/model/format.ts
// Canonical format-string field lists and parse helpers for TmuxModel.
//
// [LAW:one-source-of-truth] Field names live here and nowhere else.
// `subscribeSessions/Windows/Panes` consume these tuples directly so the
// row records they hand back are typed by the same constant.
//
// [LAW:single-enforcer] Both subscription delivery and `list-*` bootstrap
// rows go through `parseRecords` — one parser, one shape, no second path
// where formats can drift.

import { FIELD_SEP, ROW_SEP, parseRows } from "../subscriptions.js";

// ---------------------------------------------------------------------------
// Field tuples
// ---------------------------------------------------------------------------
//
// `as const` on the tuple narrows the literal types so TmuxClient's
// `subscribeSessions<F extends string>` can infer the record key type.

export const SESSION_FIELDS = [
  "session_id",
  "session_name",
  "session_attached",
] as const;

export const WINDOW_FIELDS = [
  "session_id",
  "window_id",
  "window_index",
  "window_name",
  "window_active",
  "window_zoomed_flag",
] as const;

export const PANE_FIELDS = [
  "window_id",
  "pane_id",
  "pane_index",
  "pane_active",
  "pane_width",
  "pane_height",
  "pane_title",
] as const;

export type SessionField = (typeof SESSION_FIELDS)[number];
export type WindowField = (typeof WINDOW_FIELDS)[number];
export type PaneField = (typeof PANE_FIELDS)[number];

export type SessionRow = Record<SessionField, string>;
export type WindowRow = Record<WindowField, string>;
export type PaneRow = Record<PaneField, string>;

// ---------------------------------------------------------------------------
// list-* line formats
//
// `list-sessions/-windows/-panes` deliver one row per output line, so the
// field-only format (no row separator) suffices. Single-quoting protects
// the format from shell-style splitting tmux applies to its argv.
// ---------------------------------------------------------------------------

function lineFormat(fields: readonly string[]): string {
  return `'${fields.map((f) => `#{${f}}`).join(FIELD_SEP)}'`;
}

export const SESSION_LINE_FORMAT = lineFormat(SESSION_FIELDS);
export const WINDOW_LINE_FORMAT = lineFormat(WINDOW_FIELDS);
export const PANE_LINE_FORMAT = lineFormat(PANE_FIELDS);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Convert `list-*` output (one row per line) into the same record shape
 * that subscription delivery yields. Rejoining with `ROW_SEP` lets the
 * library reuse `parseRows` so there is exactly one parser.
 *
 * [LAW:single-enforcer] No bespoke split logic — the wire shape converges
 * on the subscription format.
 */
export function parseListLines<F extends string>(
  lines: readonly string[],
  fields: readonly F[],
): Record<F, string>[] {
  // Drop blank lines (tmux occasionally emits a trailing empty line) and
  // rejoin so parseRows ignores the trailing separator.
  const wire = lines.filter((l) => l.length > 0).map((l) => l + ROW_SEP).join("");
  return parseRows(wire, fields);
}

// ---------------------------------------------------------------------------
// Numeric id parsing
// ---------------------------------------------------------------------------

/**
 * tmux delivers ids prefixed by their sigil: `$1` for sessions, `@1` for
 * windows, `%1` for panes. Strip the sigil and parse the rest as base-10.
 * Returns `null` when the input is not a recognisable id.
 */
export function parseTmuxId(raw: string): number | null {
  if (raw.length === 0) return null;
  const stripped = raw.replace(/^[$@%]/, "");
  const n = parseInt(stripped, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a numeric field that may legitimately be empty (tmux occasionally
 * delivers `""` for `pane_width`/`pane_height` while a pane is being
 * resized). Returns `null` for empty/non-numeric input rather than
 * silently substituting a default — see the `width: number | null` rationale
 * in `types.ts`.
 */
export function parseNumberOrNull(raw: string): number | null {
  if (raw.length === 0) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
