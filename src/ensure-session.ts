// src/ensure-session.ts
// Idempotent session-bootstrap helper.
//
// Every Electron / WebSocket / CLI consumer needs the same dance: make sure
// a tmux session by a given name exists on the server the client is talking
// to, attach if it does, create if it doesn't, and never kill it on exit.
// Before this helper, every consumer rolled its own (execSync has-session +
// new-session -d) — the racy pattern this module replaces.
//
// Contract.
// - Single command does the work: `new-session -A -d -s NAME -P -F …`.
//   tmux's `-A` flag makes new-session attach-if-exists / create-if-absent
//   atomically — the JS side never branches on a pre-check.
// - The `created` flag falls out of tmux's own behavior: `-P -F` only emits
//   on the create branch, so empty output means the session pre-existed.
//   No timestamp comparison, no second probe before the create.
// - On the pre-existed branch we recover the session_id with a follow-up
//   `display-message` query. This is post-creation recovery, not a
//   pre-check — the create call has already succeeded by the time we ask.
// - Errors propagate verbatim. No silent fallbacks (per scripting-discipline).
//
// [LAW:single-enforcer] Sole owner of the create-or-attach contract for
// named sessions. Consumers MUST go through this helper instead of
// re-implementing the dance with execSync + has-session.
// [LAW:dataflow-not-control-flow] The same `new-session -A` runs every
// invocation. Variability lives in the tmux response (empty vs. session_id
// line), not in branching JS that conditionally creates or attaches.

import type { TmuxClient } from "./client.js";
import { tmuxEscape } from "./protocol/encoder.js";

export interface EnsureSessionOptions {
  /** tmux session name. Cannot contain `:` or `.` per tmux's own rules. */
  readonly name: string;
  /** Working directory for the new session's first window (`-c`). */
  readonly cwd?: string;
  /** Name for the new session's first window (`-n`). */
  readonly windowName?: string;
}

export interface EnsureSessionResult {
  /** True iff this call took the create branch; false iff the session pre-existed. */
  readonly created: boolean;
  /** tmux session_id (e.g. `$0`). Sourced from tmux, not assumed from `name`. */
  readonly sessionId: string;
}

export async function ensureSession(
  client: TmuxClient,
  opts: EnsureSessionOptions,
): Promise<EnsureSessionResult> {
  const createResp = await client.execute(buildNewSessionCommand(opts));
  const firstLine = createResp.output[0]?.trim() ?? "";
  if (firstLine.length > 0) {
    return { created: true, sessionId: firstLine };
  }
  const idResp = await client.execute(
    `display-message -p -t ${tmuxEscape(opts.name)} '#{session_id}'`,
  );
  const sessionId = idResp.output[0]?.trim() ?? "";
  if (sessionId.length === 0) {
    throw new Error(
      `ensureSession: tmux returned empty session_id for "${opts.name}"`,
    );
  }
  return { created: false, sessionId };
}

function buildNewSessionCommand(opts: EnsureSessionOptions): string {
  const parts = ["new-session", "-A", "-d", "-s", tmuxEscape(opts.name)];
  if (opts.cwd !== undefined) parts.push("-c", tmuxEscape(opts.cwd));
  if (opts.windowName !== undefined) parts.push("-n", tmuxEscape(opts.windowName));
  parts.push("-P", "-F", "'#{session_id}'");
  return parts.join(" ");
}
