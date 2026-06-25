// examples/web-multiplexer/web/data-sniff-engine.test.ts
//
// Unit tests for the pure structured-data sniffer. The engine is a pure
// function of (byte chunks) → (block feed), so every behaviour is pinned here
// in isolation — no firehose, no MobX, no DOM. [LAW:behavior-not-structure]
// the assertions are over the detected grids and feed contents (the contract),
// never over private run/JSON carry-over (the mechanism).

import { describe, it, expect } from "vitest";
import {
  DataSniffEngine,
  scanJsonValue,
  jsonToTable,
  classifyRow,
  runToTable,
  splitCsv,
} from "./data-sniff-engine.ts";

const PANE = 7;

describe("scanJsonValue", () => {
  it("recognises a complete single-line object", () => {
    expect(scanJsonValue('{"a":1}')).toEqual({
      status: "complete",
      text: '{"a":1}',
    });
  });

  it("anchors at the first non-space bracket and ignores trailing text", () => {
    expect(scanJsonValue('  [1, 2]  trailing')).toEqual({
      status: "complete",
      text: "[1, 2]",
    });
  });

  it("reports open when the value runs past the end (multi-line)", () => {
    expect(scanJsonValue('{"a":')).toEqual({ status: "open" });
  });

  it("is string-aware — a bracket inside a string does not close the value", () => {
    expect(scanJsonValue('{"k":"}"}')).toEqual({
      status: "complete",
      text: '{"k":"}"}',
    });
  });

  it("handles escaped quotes inside strings", () => {
    expect(scanJsonValue('{"k":"a\\"b}"}')).toEqual({
      status: "complete",
      text: '{"k":"a\\"b}"}',
    });
  });

  it("returns none when the line does not begin with a bracket", () => {
    expect(scanJsonValue("name = {value}")).toEqual({ status: "none" });
    expect(scanJsonValue("")).toEqual({ status: "none" });
  });
});

describe("jsonToTable", () => {
  it("turns an array of objects into a union-keyed table", () => {
    const t = jsonToTable('[{"a":1,"b":2},{"a":3,"c":4}]');
    expect(t).toEqual({
      columns: ["a", "b", "c"],
      rows: [
        ["1", "2", ""],
        ["3", "", "4"],
      ],
    });
  });

  it("turns an array of arrays into a positional table padded to max width", () => {
    expect(jsonToTable("[[1,2],[3,4,5]]")).toEqual({
      columns: null,
      rows: [
        ["1", "2", ""],
        ["3", "4", "5"],
      ],
    });
  });

  it("turns an array of scalars into a single value column", () => {
    expect(jsonToTable('["x", 2, true]')).toEqual({
      columns: ["value"],
      rows: [["x"], ["2"], ["true"]],
    });
  });

  it("turns a multi-key object into a key/value table", () => {
    expect(jsonToTable('{"host":"a","port":22}')).toEqual({
      columns: ["key", "value"],
      rows: [
        ["host", "a"],
        ["port", "22"],
      ],
    });
  });

  it("renders nested values as compact JSON cells", () => {
    const t = jsonToTable('[{"a":{"x":1},"b":[1,2]}]');
    expect(t?.rows[0]).toEqual(['{"x":1}', "[1,2]"]);
  });

  it("rejects values that are not tabular-worthy", () => {
    expect(jsonToTable("42")).toBeNull();
    expect(jsonToTable('"hello"')).toBeNull();
    expect(jsonToTable("[]")).toBeNull();
    expect(jsonToTable('{"only":1}')).toBeNull(); // single-key object
    expect(jsonToTable("{not json}")).toBeNull();
  });
});

describe("splitCsv", () => {
  it("splits plain fields", () => {
    expect(splitCsv("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("keeps commas inside quoted fields", () => {
    expect(splitCsv('a,"b,c",d')).toEqual(["a", "b,c", "d"]);
  });

  it("unescapes doubled quotes inside quoted fields", () => {
    expect(splitCsv('"he said ""hi""",x')).toEqual(['he said "hi"', "x"]);
  });
});

describe("classifyRow", () => {
  it("classifies comma, tab, pipe, and whitespace rows", () => {
    expect(classifyRow("a,b,c")?.kind).toBe("csv");
    expect(classifyRow("a\tb\tc")?.kind).toBe("tsv");
    expect(classifyRow("| a | b |")?.kind).toBe("table");
    expect(classifyRow("NAME      AGE")?.kind).toBe("ws");
  });

  it("classifies box/markdown rules as separators", () => {
    expect(classifyRow("|---|---|")?.kind).toBe("sep");
    expect(classifyRow("├────┼────┤")?.kind).toBe("sep");
    expect(classifyRow("+------+------+")?.kind).toBe("sep");
  });

  it("returns null for prose and blank lines", () => {
    expect(classifyRow("the quick brown fox")).toBeNull();
    expect(classifyRow("   ")).toBeNull();
  });
});

describe("runToTable", () => {
  it("treats row 0 as a header when a separator rule followed it", () => {
    expect(
      runToTable({
        kind: "table",
        cols: 2,
        rows: [
          ["name", "age"],
          ["alice", "30"],
        ],
        lines: ["| name | age |", "|---|---|", "| alice | 30 |"],
        sawSeparator: true,
      }),
    ).toEqual({ columns: ["name", "age"], rows: [["alice", "30"]] });
  });

  it("infers a header when row 0 is all-text and a later row has numbers", () => {
    expect(
      runToTable({
        kind: "csv",
        cols: 2,
        rows: [
          ["name", "age"],
          ["alice", "30"],
        ],
        lines: ["name,age", "alice,30"],
        sawSeparator: false,
      }),
    ).toEqual({ columns: ["name", "age"], rows: [["alice", "30"]] });
  });

  it("keeps data positional when no header is evident", () => {
    expect(
      runToTable({
        kind: "csv",
        cols: 2,
        rows: [
          ["1", "2"],
          ["3", "4"],
        ],
        lines: ["1,2", "3,4"],
        sawSeparator: false,
      }),
    ).toEqual({ columns: null, rows: [["1", "2"], ["3", "4"]] });
  });
});

// ---------------------------------------------------------------------------
// Streaming engine
// ---------------------------------------------------------------------------

describe("DataSniffEngine", () => {
  it("emits a single-line JSON log object as one block", () => {
    const e = new DataSniffEngine(100);
    const added = e.pushBytes(PANE, '{"level":"info","msg":"hi"}\n');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ paneId: PANE, format: "json" });
    expect(added[0].table.columns).toEqual(["key", "value"]);
  });

  it("assembles multi-line JSON spread across chunks into one block", () => {
    const e = new DataSniffEngine(100);
    expect(e.pushBytes(PANE, '[\n  {"a":1},\n')).toHaveLength(0);
    const added = e.pushBytes(PANE, '  {"a":2}\n]\n');
    expect(added).toHaveLength(1);
    expect(added[0].format).toBe("json");
    expect(added[0].table.rows).toEqual([["1"], ["2"]]);
  });

  it("emits a CSV block once a non-conforming line breaks the run", () => {
    const e = new DataSniffEngine(100);
    expect(e.pushBytes(PANE, "name,age\nalice,30\nbob,25\n")).toHaveLength(0);
    const added = e.pushBytes(PANE, "done.\n");
    expect(added).toHaveLength(1);
    expect(added[0].format).toBe("csv");
    expect(added[0].table).toEqual({
      columns: ["name", "age"],
      rows: [
        ["alice", "30"],
        ["bob", "25"],
      ],
    });
  });

  it("flush() finalizes a run that is still complete at end of stream", () => {
    const e = new DataSniffEngine(100);
    expect(e.pushBytes(PANE, "a,b\n1,2\n3,4\n")).toHaveLength(0);
    const flushed = e.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].format).toBe("csv");
  });

  it("does not emit JSON that never closes", () => {
    const e = new DataSniffEngine(100);
    e.pushBytes(PANE, '{"a":1,\n"b":2\n'); // no closing brace
    expect(e.flush()).toHaveLength(0);
    expect(e.blocks).toHaveLength(0);
  });

  it("requires three rows before trusting a whitespace-aligned table", () => {
    const e = new DataSniffEngine(100);
    e.pushBytes(PANE, "NAME      AGE\nalice     30\n");
    expect(e.flush()).toHaveLength(0); // only two rows — not trusted
    e.clear();
    e.pushBytes(PANE, "NAME      AGE\nalice     30\nbob       25\n");
    const flushed = e.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].format).toBe("table");
    expect(flushed[0].table.columns).toEqual(["NAME", "AGE"]);
  });

  it("detects a markdown/pipe table with a separator-marked header", () => {
    const e = new DataSniffEngine(100);
    e.pushBytes(PANE, "| name | age |\n|------|-----|\n| alice | 30 |\n");
    const flushed = e.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0].table).toEqual({
      columns: ["name", "age"],
      rows: [["alice", "30"]],
    });
  });

  it("strips ANSI escape sequences before parsing", () => {
    const e = new DataSniffEngine(100);
    // CSV with a colour code wrapping the first cell of each row.
    const added = e.pushBytes(
      PANE,
      "\x1b[32mname\x1b[0m,age\n\x1b[32malice\x1b[0m,30\nbob,25\nx\n",
    );
    expect(added).toHaveLength(1);
    expect(added[0].table.columns).toEqual(["name", "age"]);
  });

  it("does not mistake prose with stray brackets/commas for structured data", () => {
    const e = new DataSniffEngine(100);
    e.pushBytes(
      PANE,
      "Reading config {default} now.\nIt works, mostly fine here.\nAll good.\n",
    );
    // "It works, mostly fine here." is one comma → 2 csv cells, but it's a lone
    // row with no consecutive partner, so no run is emitted.
    expect(e.flush()).toHaveLength(0);
  });

  it("evicts oldest blocks past capacity (FIFO)", () => {
    const e = new DataSniffEngine(2);
    for (let i = 0; i < 4; i++) {
      e.pushBytes(PANE, `{"k${i}":1,"x":2}\n`);
    }
    expect(e.blocks).toHaveLength(2);
    expect(e.blocks[0].raw).toContain("k2");
    expect(e.blocks[1].raw).toContain("k3");
  });

  it("tracks the count of panes that have produced bytes", () => {
    const e = new DataSniffEngine(100);
    e.pushBytes(1, "hello\n");
    e.pushBytes(2, "world\n");
    expect(e.sniffedPaneCount).toBe(2);
  });

  it("clear() drops the feed and per-pane carry-over", () => {
    const e = new DataSniffEngine(100);
    e.pushBytes(PANE, '{"a":1,"b":2}\n');
    e.clear();
    expect(e.blocks).toHaveLength(0);
    expect(e.sniffedPaneCount).toBe(0);
  });
});
