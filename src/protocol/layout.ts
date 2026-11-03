// src/protocol/layout.ts
// Parser for tmux's classic window layout string (layout-custom.c), the form
// %layout-change carries. Pure — no Node.js dependencies.
//
// Grammar:
//   layout := checksum "," cell
//   cell   := W "x" H "," X "," Y ( "," paneId | "{" cells "}" | "[" cells "]" )
//   cells  := cell ( "," cell )*
// `{}` is a left-right split, `[]` a top-bottom split; only leaf cells name a
// pane. The checksum is tmux's 16-bit rotate-and-add over the bytes after
// the first comma, written as four lowercase hex digits.

import type {
  PaneGeometry,
  WindowLayout,
  WindowLayoutFields,
} from "./types.js";

/** Thrown inside the parser only; `parseWindowLayout` turns it into the failure arm. */
class LayoutSyntaxError extends Error {}

/** tmux `layout_checksum`: 16-bit rotate-right-by-one, then add the byte. */
function layoutChecksum(body: string): number {
  let csum = 0;
  for (let i = 0; i < body.length; i++) {
    csum = ((csum >> 1) + ((csum & 1) << 15) + body.charCodeAt(i)) & 0xffff;
  }
  return csum;
}

/** Recursive-descent cursor over the layout body. */
class LayoutReader {
  private pos = 0;
  constructor(private readonly src: string) {}

  atEnd(): boolean {
    return this.pos === this.src.length;
  }

  peek(): string {
    return this.src.charAt(this.pos);
  }

  expect(ch: string): void {
    if (this.src.charAt(this.pos) !== ch) {
      throw new LayoutSyntaxError(
        `expected '${ch}' at offset ${this.pos}, found ${this.describeHere()}`,
      );
    }
    this.pos++;
  }

  uint(): number {
    const start = this.pos;
    while (this.pos < this.src.length && isDigit(this.src.charAt(this.pos))) {
      this.pos++;
    }
    if (this.pos === start) {
      throw new LayoutSyntaxError(
        `expected a number at offset ${start}, found ${this.describeHere()}`,
      );
    }
    return parseInt(this.src.slice(start, this.pos), 10);
  }

  private describeHere(): string {
    return this.atEnd() ? "end of input" : `'${this.peek()}'`;
  }
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

const SPLIT_CLOSE: Readonly<Record<string, string>> = { "{": "}", "[": "]" };

/** Parse one cell, appending every leaf pane it contains to `out` in layout order. */
function readCell(r: LayoutReader, out: PaneGeometry[]): void {
  const width = r.uint();
  r.expect("x");
  const height = r.uint();
  r.expect(",");
  const x = r.uint();
  r.expect(",");
  const y = r.uint();

  const next = r.peek();
  const close = SPLIT_CLOSE[next];
  if (close === undefined) {
    r.expect(",");
    out.push({ paneId: r.uint(), width, height, x, y });
    return;
  }
  r.expect(next);
  readCell(r, out);
  while (r.peek() === ",") {
    r.expect(",");
    readCell(r, out);
  }
  r.expect(close);
}

/**
 * Parse a classic tmux layout string into the geometry of every pane it
 * holds, in layout order (depth first).
 *
 * [LAW:parse-dont-validate] The result is either the complete pane list or
 * the `malformed` arm with a reason. A bad checksum, trailing bytes, or any
 * grammar deviation never yields a partial or guessed list.
 */
export function parseWindowLayout(raw: string): WindowLayout {
  const comma = raw.indexOf(",");
  const checksum = raw.slice(0, comma);
  const body = raw.slice(comma + 1);
  if (comma === -1 || !/^[0-9a-f]{4}$/.test(checksum)) {
    return { kind: "malformed", reason: `no layout checksum in "${raw}"` };
  }
  const expected = layoutChecksum(body);
  if (parseInt(checksum, 16) !== expected) {
    return {
      kind: "malformed",
      reason: `checksum ${checksum} does not match body (expected ${expected.toString(16).padStart(4, "0")}) in "${raw}"`,
    };
  }
  const panes: PaneGeometry[] = [];
  const reader = new LayoutReader(body);
  try {
    readCell(reader, panes);
    if (!reader.atEnd()) {
      throw new LayoutSyntaxError(`trailing input after the root cell`);
    }
  } catch (err) {
    if (!(err instanceof LayoutSyntaxError)) throw err;
    return { kind: "malformed", reason: `${err.message} in "${raw}"` };
  }
  return { kind: "parsed", panes };
}

/**
 * The one constructor for a message's layout fields: keeps the raw strings
 * and derives their geometry.
 */
export function windowLayoutFields(
  windowLayout: string,
  windowVisibleLayout: string,
  windowFlags: string,
): WindowLayoutFields {
  return {
    windowLayout,
    windowVisibleLayout,
    windowFlags,
    layout: parseWindowLayout(windowLayout),
    visibleLayout: parseWindowLayout(windowVisibleLayout),
  };
}
