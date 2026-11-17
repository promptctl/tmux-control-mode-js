// tests/helpers/seed-state.ts
//
// The `display-message` reply PaneStream takes with each capture, as a
// tmux >= 3.2 writes it: every format of SEED_STATE_FORMAT, in its order.
// Fakes answer the state command with this so a capture parses as a real
// one does.

import {
  SEED_STATE_FIELDS,
  type SeedStateField,
} from "../../src/window-terminal/engine/seed-builder.js";

export interface SeedStateFields {
  readonly cols?: number;
  readonly rows?: number;
  readonly cursor?: { readonly col: number; readonly row: number };
  readonly alternate?: boolean;
  readonly historySize?: number;
}

/**
 * A full state line: cursor visible, autowrap on, other modes off, scroll
 * region the whole screen. Defaults to an 80x24 main-screen pane with the
 * cursor at the origin and no history.
 */
export function seedStateLine({
  cols = 80,
  rows = 24,
  cursor = { col: 0, row: 0 },
  alternate = false,
  historySize = 0,
}: SeedStateFields = {}): string {
  const values: Record<SeedStateField, number> = {
    cursor_x: cursor.col,
    cursor_y: cursor.row,
    alternate_on: alternate ? 1 : 0,
    cursor_flag: 1,
    insert_flag: 0,
    keypad_cursor_flag: 0,
    keypad_flag: 0,
    wrap_flag: 1,
    origin_flag: 0,
    pane_height: rows,
    history_size: historySize,
    scroll_region_upper: 0,
    scroll_region_lower: rows - 1,
    pane_width: cols,
  };
  return SEED_STATE_FIELDS.map((f) => values[f]).join(";");
}

/** What a seed writes between rows: SCOSC, SGR 49, LF, SCORC, CR, CUD. */
export const SEED_NEWLINE = "\x1b[s\x1b[49m\n\x1b[u\r\x1b[B";
