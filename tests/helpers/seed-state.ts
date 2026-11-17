// tests/helpers/seed-state.ts
//
// The `display-message` reply PaneStream takes with each capture, as a
// tmux >= 3.2 writes it: every field of stateCmd, in order. Fakes answer the
// state command with this so a capture parses as a real one does.

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
  return [
    cursor.col,
    cursor.row,
    alternate ? 1 : 0,
    1, // cursor_flag
    0, // insert_flag
    0, // keypad_cursor_flag
    0, // keypad_flag
    1, // wrap_flag
    rows,
    historySize,
    0, // scroll_region_upper
    rows - 1, // scroll_region_lower
    cols,
  ].join(";");
}
