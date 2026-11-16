// tmuxSocketDir names the directory tmux itself would use: TMUX_TMPDIR when
// set and non-empty, /tmp otherwise.

import { afterEach, describe, expect, it, vi } from "vitest";
import { tmuxSocketDir } from "../../src/transport/sockets.js";

const uid = process.getuid?.();

describe.skipIf(uid === undefined)("tmuxSocketDir", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is under TMUX_TMPDIR when it is set", () => {
    vi.stubEnv("TMUX_TMPDIR", "/var/run/elsewhere");
    expect(tmuxSocketDir()).toBe(`/var/run/elsewhere/tmux-${uid}`);
  });

  it("is under /tmp when TMUX_TMPDIR is unset", () => {
    vi.stubEnv("TMUX_TMPDIR", undefined);
    expect(tmuxSocketDir()).toBe(`/tmp/tmux-${uid}`);
  });

  it("is under /tmp when TMUX_TMPDIR is empty, as tmux treats it", () => {
    vi.stubEnv("TMUX_TMPDIR", "");
    expect(tmuxSocketDir()).toBe(`/tmp/tmux-${uid}`);
  });
});
