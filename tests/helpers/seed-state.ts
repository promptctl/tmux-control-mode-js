// tests/helpers/seed-state.ts
//
// The `display-message` reply PaneStream takes with each capture, as a
// tmux >= 3.2 writes it: every format of SEED_STATE_FORMAT, in its order.
// Fakes answer the state command with this so a capture parses as a real
// one does. `drawnSeed` reads a seed back the way a terminal shows it.

import { Terminal } from "@xterm/headless";
import {
  SEED_STATE_FIELDS,
  type SeedStateField,
} from "../../src/window-terminal/engine/seed-builder.js";
import type { Grid } from "../../src/window-terminal/engine/terminal-sink.js";

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

/**
 * What a terminal of `size` shows after drawing `seed`: every buffer line,
 * scrollback first, and the cursor on the screen.
 */
export async function drawnSeed(
  seed: string | Uint8Array,
  size: Grid,
): Promise<{ rows: string[]; cursor: { col: number; row: number } }> {
  const term = new Terminal({ ...size, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(seed, resolve));
  const buf = term.buffer.active;
  return {
    rows: Array.from(
      { length: buf.length },
      (_, y) => buf.getLine(y)?.translateToString(true) ?? "",
    ),
    cursor: { col: buf.cursorX, row: buf.cursorY },
  };
}
