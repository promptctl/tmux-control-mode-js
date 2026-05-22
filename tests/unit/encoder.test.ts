// tests/unit/encoder.test.ts
// Unit tests for command string builders

import {
  tmuxEscape,
  buildCommand,
  refreshClientSize,
  refreshClientPaneAction,
  refreshClientSubscribe,
  refreshClientUnsubscribe,
  sendKeys,
  splitWindow,
  refreshClientSetFlags,
  refreshClientClearFlags,
  refreshClientReport,
  refreshClientQueryClipboard,
  detachClient,
} from "../../src/protocol/encoder.js";
import { PaneAction } from "../../src/protocol/types.js";

describe("tmuxEscape", () => {
  it("simple string wraps in single quotes", () => {
    expect(tmuxEscape("hello")).toBe("'hello'");
  });

  it("empty string → ''", () => {
    expect(tmuxEscape("")).toBe("''");
  });

  it("single quote in value uses shell escape pattern", () => {
    // it's → 'it'\''s'
    expect(tmuxEscape("it's")).toBe("'it'\\''s'");
  });

  it("multiple single quotes", () => {
    // a'b'c → 'a'\''b'\''c'
    expect(tmuxEscape("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it("backslash passes through unchanged inside single quotes", () => {
    expect(tmuxEscape("a\\b")).toBe("'a\\b'");
  });

  it("newline passes through in single quotes", () => {
    expect(tmuxEscape("a\nb")).toBe("'a\nb'");
  });

  it("special shell chars are inert inside single quotes", () => {
    expect(tmuxEscape("$(cmd)")).toBe("'$(cmd)'");
  });

  it("hash/format specifiers pass through", () => {
    expect(tmuxEscape("#{pane_title}")).toBe("'#{pane_title}'");
  });
});

describe("buildCommand", () => {
  it("list-sessions → 'list-sessions\\n'", () => {
    expect(buildCommand("list-sessions")).toBe("list-sessions\n");
  });

  it("new-session → 'new-session\\n'", () => {
    expect(buildCommand("new-session")).toBe("new-session\n");
  });

  it("always appends exactly one newline", () => {
    const result = buildCommand("some-command");
    expect(result.endsWith("\n")).toBe(true);
    expect(result.split("\n").length).toBe(2); // one newline splits into exactly 2 parts
  });
});

describe("refreshClientSize", () => {
  it("220x50", () => {
    expect(refreshClientSize(220, 50)).toBe("refresh-client -C 220x50\n");
  });

  it("80x24", () => {
    expect(refreshClientSize(80, 24)).toBe("refresh-client -C 80x24\n");
  });

  it("1x1", () => {
    expect(refreshClientSize(1, 1)).toBe("refresh-client -C 1x1\n");
  });
});

describe("refreshClientPaneAction", () => {
  // tmux's command parser splits unquoted arguments on ':', so the
  // pane:action token must be quoted as a single argument.
  it("pane 1, PaneAction.On — quoted pane:action token", () => {
    expect(refreshClientPaneAction(1, PaneAction.On)).toBe(
      "refresh-client -A '%1:on'\n"
    );
  });

  it("pane 5, PaneAction.Pause", () => {
    expect(refreshClientPaneAction(5, PaneAction.Pause)).toBe(
      "refresh-client -A '%5:pause'\n"
    );
  });

  it("pane 3, PaneAction.Off", () => {
    expect(refreshClientPaneAction(3, PaneAction.Off)).toBe(
      "refresh-client -A '%3:off'\n"
    );
  });

  it("pane 2, PaneAction.Continue", () => {
    expect(refreshClientPaneAction(2, PaneAction.Continue)).toBe(
      "refresh-client -A '%2:continue'\n"
    );
  });
});

describe("refreshClientSubscribe", () => {
  it("simple name, what, format are individually single-quoted", () => {
    const result = refreshClientSubscribe("my-sub", "pane", "#{pane_title}");
    expect(result).toBe(
      "refresh-client -B 'my-sub':'pane':'#{pane_title}'\n"
    );
  });

  it("name with single quote is properly escaped", () => {
    const result = refreshClientSubscribe("sub's", "pane", "#{pane_id}");
    expect(result).toContain("'sub'\\''s'");
  });

  it("format with special chars is properly quoted", () => {
    const result = refreshClientSubscribe("s", "window", "$(echo)");
    expect(result).toContain("'$(echo)'");
  });

  it("always appends exactly one newline", () => {
    const result = refreshClientSubscribe("a", "b", "c");
    expect(result.endsWith("\n")).toBe(true);
  });
});

describe("refreshClientUnsubscribe", () => {
  it("simple name is single-quoted", () => {
    expect(refreshClientUnsubscribe("my-sub")).toBe(
      "refresh-client -B 'my-sub'\n"
    );
  });

  it("name with special chars is properly escaped", () => {
    const result = refreshClientUnsubscribe("sub's");
    expect(result).toBe("refresh-client -B 'sub'\\''s'\n");
  });

  it("always appends exactly one newline", () => {
    const result = refreshClientUnsubscribe("x");
    expect(result.endsWith("\n")).toBe(true);
  });
});

describe("sendKeys", () => {
  // Keys are sent as raw UTF-8 bytes in hex via `send -H` (mirrors the
  // canonical client). No key byte ever appears literally in the command
  // line, so control bytes and shell metacharacters are inert by construction.
  it("simple target and keys → hex-byte wire string", () => {
    expect(sendKeys("%1", "hello")).toBe(
      "send-keys -H -t '%1' 68 65 6c 6c 6f\n",
    );
  });

  it("target with single quote is properly escaped", () => {
    expect(sendKeys("it's", "x")).toBe("send-keys -H -t 'it'\\''s' 78\n");
  });

  it("empty keys returns null (no valid wire form — caller no-ops)", () => {
    // `send-keys -H` with zero hex args errors ("no key specified"), so the
    // encoder enforces the precondition: empty input has no command.
    expect(sendKeys("%1", "")).toBeNull();
  });

  it("keys containing $(cmd) become inert hex bytes", () => {
    expect(sendKeys("%2", "$(rm -rf /)")).toBe(
      "send-keys -H -t '%2' 24 28 72 6d 20 2d 72 66 20 2f 29\n",
    );
  });

  it("control bytes (Enter, Ctrl-C) and a literal LF encode as hex, not raw", () => {
    // CR (0x0d), Ctrl-C (0x03), then a multi-line paste with an embedded LF
    // (0x0a) — none may appear raw in the command line.
    expect(sendKeys("%0", "\r")).toBe("send-keys -H -t '%0' 0d\n");
    expect(sendKeys("%0", "\x03")).toBe("send-keys -H -t '%0' 03\n");
    expect(sendKeys("%0", "a\nb")).toBe("send-keys -H -t '%0' 61 0a 62\n");
  });

  it("multibyte UTF-8 keys send their exact byte sequence", () => {
    // 'é' is 0xC3 0xA9; '😀' (U+1F600) is 0xF0 0x9F 0x98 0x80.
    expect(sendKeys("%0", "é")).toBe("send-keys -H -t '%0' c3 a9\n");
    expect(sendKeys("%0", "\u{1F600}")).toBe(
      "send-keys -H -t '%0' f0 9f 98 80\n",
    );
  });

  it("ends with exactly one trailing newline", () => {
    const result = sendKeys("%1", "x");
    if (result === null) throw new Error("non-empty keys must produce a command");
    expect(result.endsWith("\n")).toBe(true);
    expect(result.split("\n").length).toBe(2);
  });
});

describe("splitWindow", () => {
  it("default options → horizontal split", () => {
    expect(splitWindow()).toBe("split-window -h\n");
  });

  it("explicit empty options → horizontal split", () => {
    expect(splitWindow({})).toBe("split-window -h\n");
  });

  it("vertical: true → -v", () => {
    expect(splitWindow({ vertical: true })).toBe("split-window -v\n");
  });

  it("vertical: false → -h (explicit)", () => {
    expect(splitWindow({ vertical: false })).toBe("split-window -h\n");
  });

  it("target only", () => {
    expect(splitWindow({ target: "%2" })).toBe("split-window -h -t '%2'\n");
  });

  it("vertical and target", () => {
    expect(splitWindow({ vertical: true, target: "main" })).toBe(
      "split-window -v -t 'main'\n"
    );
  });

  it("target with single quote is properly escaped", () => {
    expect(splitWindow({ target: "it's" })).toBe(
      "split-window -h -t 'it'\\''s'\n"
    );
  });

  it("always ends with exactly one newline", () => {
    const result = splitWindow({ vertical: true, target: "x" });
    expect(result.endsWith("\n")).toBe(true);
    expect(result.split("\n").length).toBe(2);
  });
});

describe("refreshClientSetFlags", () => {
  it("single flag", () => {
    expect(refreshClientSetFlags(["pause-after"])).toBe(
      "refresh-client -f pause-after\n"
    );
  });

  it("flag with value", () => {
    expect(refreshClientSetFlags(["pause-after=2"])).toBe(
      "refresh-client -f pause-after=2\n"
    );
  });

  it("multiple flags comma-separated", () => {
    expect(refreshClientSetFlags(["pause-after=2", "no-output"])).toBe(
      "refresh-client -f pause-after=2,no-output\n"
    );
  });

  it("disable form (! prefix passes through)", () => {
    expect(refreshClientSetFlags(["!pause-after"])).toBe(
      "refresh-client -f !pause-after\n"
    );
  });

  it("ends with exactly one newline", () => {
    const r = refreshClientSetFlags(["a"]);
    expect(r.endsWith("\n")).toBe(true);
    expect(r.split("\n").length).toBe(2);
  });
});

describe("refreshClientClearFlags", () => {
  it("single flag → !flag", () => {
    expect(refreshClientClearFlags(["pause-after"])).toBe(
      "refresh-client -f !pause-after\n"
    );
  });

  it("multiple flags → !a,!b,!c", () => {
    expect(refreshClientClearFlags(["pause-after", "no-output", "read-only"])).toBe(
      "refresh-client -f !pause-after,!no-output,!read-only\n"
    );
  });
});

describe("refreshClientReport", () => {
  // The whole `pane-id:report` token is quoted as a single argument so tmux
  // doesn't split on the colon (same fix as -A).
  it("simple OSC 10 color report", () => {
    const osc = "\u001b]10;rgb:1818/1818/1818\u001b\\";
    expect(refreshClientReport(0, osc)).toBe(
      `refresh-client -r '%0:${osc}'\n`
    );
  });

  it("pane id is rendered with % prefix", () => {
    expect(refreshClientReport(5, "x")).toBe("refresh-client -r '%5:x'\n");
  });

  it("report containing single quote is properly escaped", () => {
    expect(refreshClientReport(1, "it's")).toBe(
      "refresh-client -r '%1:it'\\''s'\n"
    );
  });

  it("ends with exactly one newline", () => {
    const r = refreshClientReport(0, "a");
    expect(r.endsWith("\n")).toBe(true);
  });
});

describe("refreshClientQueryClipboard", () => {
  it("produces exact wire string", () => {
    expect(refreshClientQueryClipboard()).toBe("refresh-client -l\n");
  });
});

describe("detachClient", () => {
  it("returns a single LF", () => {
    expect(detachClient()).toBe("\n");
  });

  it("is exactly one byte", () => {
    expect(detachClient().length).toBe(1);
  });
});
