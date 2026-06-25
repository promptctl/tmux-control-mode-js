// src/conformance/checks.ts
// The conformance catalogue: one runnable proposition per documented protocol
// surface, each certifying that the REAL library (TmuxClient + TmuxParser +
// TmuxParser-fed correlation + the byte sink path) surfaces what tmux's wire
// says it should. Only the tmux *process* is substituted — a MockTmuxServer
// speaks the exact wire via serializeMessage — so a green suite is a real
// statement about the shipped client, not about a stand-in.
//
// [LAW:decomposition] Cut along the OBSERVATION CHANNEL, which is the joint the
// client itself is cut on (see TmuxClient.handleMessage): a notification is seen
// as an event, pane bytes as a sink write, a command as execute() resolving or
// rejecting. Three runners, one per channel — NOT 28 hand-written cases.
// [LAW:one-type-per-behavior] Each runner is a single function; its instances
// differ only by the sample value it certifies (the partition in samples.ts
// decides which runner each variant flows to), so adding a variant adds an
// instance, never a case.
// [LAW:effects-at-boundaries] The check DEFINITIONS are pure descriptors; the
// only effect — constructing a mock+client and driving it — is confined to each
// `run()`. The mock delivers synchronously, so an expected-but-absent
// observation is detected the instant `run()` finishes driving, never a hang.

import type { TmuxMessage, PaneOutputMessage } from "../protocol/types.js";
import { isPaneOutput } from "../protocol/types.js";
import { serializeMessage } from "../protocol/serializer.js";
import { TmuxClient } from "../client.js";
import { MockTmuxServer } from "../mock/server.js";
import type { ChunkPayload, BytesSink } from "../pane-output.js";
import { TmuxCommandError } from "../errors.js";
import type { EmitterTmuxMessage } from "../emitter.js";
import { MESSAGE_SAMPLES, CHANNEL_OF } from "./samples.js";
import type { ObservationChannel } from "./samples.js";

// ---------------------------------------------------------------------------
// Outcome — a discriminated union, not a boolean + optional reason
// ---------------------------------------------------------------------------

/**
 * The result of running one check. The human-readable `detail` is present on
 * both arms (the dashboard shows it on a passing row too — "surfaced %window-add
 * @2"), so it is required, not optional. [LAW:types-are-the-program]
 */
export type CheckOutcome =
  | { readonly status: "pass"; readonly detail: string }
  | { readonly status: "fail"; readonly detail: string };

const pass = (detail: string): CheckOutcome => ({ status: "pass", detail });
const fail = (detail: string): CheckOutcome => ({ status: "fail", detail });

/**
 * One conformance proposition. A pure descriptor (id/channel/title/spec) plus a
 * `run()` that builds its own isolated harness — so checks are order-independent
 * and a dashboard can run them in any order or concurrently. [LAW:composability]
 */
export interface ConformanceCheck {
  /** Stable identity, e.g. `notification:window-add`. */
  readonly id: string;
  /** Which observation channel this check exercises. */
  readonly channel: ObservationChannel;
  /** Human label for the dashboard row. */
  readonly title: string;
  /** SPEC.md reference, e.g. `§23 %window-add`. */
  readonly spec: string;
  run(): Promise<CheckOutcome>;
}

// ---------------------------------------------------------------------------
// Equality oracle
// ---------------------------------------------------------------------------

// [LAW:one-source-of-truth] Two messages conform iff they serialize to the same
// wire line. The canonical identity of a message is its wire form, which the
// library already owns — so the check reuses serializeMessage rather than
// hand-rolling a structural deep-equal (and rather than JSON.stringify, whose
// key order would make equal messages compare unequal).
function sameMessage(a: TmuxMessage, b: TmuxMessage): boolean {
  return serializeMessage(a) === serializeMessage(b);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Channel runners
// ---------------------------------------------------------------------------

/**
 * NOTIFICATION channel: emit the sample's wire line through the mock and assert
 * the client surfaces an equal message on the matching event. The mock flushes
 * synchronously, so after `emit()` returns the listener has already run — a
 * missing event is an immediate, loud failure, never a timeout. We capture only
 * the FIRST matching event so an incidental later event (none expected here)
 * cannot overwrite the observation.
 */
function notificationCheck(sample: EmitterTmuxMessage): ConformanceCheck {
  const type = sample.type;
  return {
    id: `notification:${type}`,
    channel: "notification",
    title: `%${type} → "${type}" event`,
    spec: `§23 %${type}`,
    run: async () => {
      const server = new MockTmuxServer();
      const client = new TmuxClient(server);
      let captured: TmuxMessage | undefined;
      client.on(type, (ev) => {
        captured ??= ev;
      });
      server.emit(sample);
      if (captured === undefined) {
        return fail(
          `no "${type}" event emitted for ${serializeMessage(sample)}`,
        );
      }
      return sameMessage(captured, sample)
        ? pass(`surfaced ${serializeMessage(captured)}`)
        : fail(
            `surfaced ${serializeMessage(captured)}, expected ${serializeMessage(sample)}`,
          );
    },
  };
}

/**
 * PANE-OUTPUT channel: pane bytes never travel through the emitter; they reach a
 * BytesSink with the octal escapes already decoded. Attach a capturing sink at
 * the default server scope, emit the sample, and assert exactly one chunk with
 * the decoded bytes and the right pane.
 */
function paneOutputCheck(sample: PaneOutputMessage): ConformanceCheck {
  // The type carries the guarantee: only output/extended-output reach here (the
  // caller narrows via isPaneOutput), and both carry decoded `data` + `paneId`.
  const type = sample.type;
  const data = sample.data;
  const paneId = sample.paneId;
  return {
    id: `pane-output:${type}`,
    channel: "pane-output",
    title: `%${type} → decoded bytes at sink`,
    spec: `§23 %${type}`,
    run: async () => {
      const server = new MockTmuxServer();
      const client = new TmuxClient(server);
      const chunks: ChunkPayload[] = [];
      const sink: BytesSink = {
        write: (c) => chunks.push(c),
        end: () => {
          // No-op: this check captures writes only; end carries no payload.
        },
      };
      const detach = client.attachBytesSink(sink);
      server.emit(sample);
      detach();
      if (chunks.length !== 1) {
        return fail(`expected 1 sink chunk, got ${chunks.length}`);
      }
      const got = chunks[0];
      if (got.paneId !== paneId) {
        return fail(`chunk paneId ${got.paneId}, expected ${paneId}`);
      }
      return sameBytes(got.data, data)
        ? pass(`delivered ${data.length} byte(s) to pane %${paneId}`)
        : fail(`decoded bytes differ for pane %${paneId}`);
    },
  };
}

// COMMAND channel: %begin/%end/%error are the correlation guard frames; they are
// observed by execute() resolving or rejecting, not as standalone events. These
// three checks certify that contract end-to-end through the real FIFO.

function commandCheck(
  id: string,
  title: string,
  scenario: ConstructorParameters<typeof MockTmuxServer>[0],
  command: string,
  verify: (
    result:
      | { readonly ok: true; readonly output: readonly string[] }
      | { readonly ok: false; readonly error: TmuxCommandError },
  ) => CheckOutcome,
): ConformanceCheck {
  return {
    id,
    channel: "command",
    title,
    spec: "§4 %begin/%end/%error",
    run: async () => {
      const server = new MockTmuxServer(scenario);
      const client = new TmuxClient(server);
      try {
        const response = await client.execute(command);
        return verify({ ok: true, output: response.output });
      } catch (error) {
        if (error instanceof TmuxCommandError) {
          return verify({ ok: false, error });
        }
        return fail(`threw a non-protocol error: ${String(error)}`);
      }
    },
  };
}

function commandChecks(): readonly ConformanceCheck[] {
  return [
    commandCheck(
      "command:ok",
      "command resolves on %end",
      {},
      "list-sessions",
      (r) =>
        r.ok
          ? pass("execute() resolved with success")
          : fail("rejected; expected resolve"),
    ),
    commandCheck(
      "command:output",
      "command captures guard-block output lines",
      { respond: () => ({ kind: "ok", output: ["line-one", "line-two"] }) },
      "list-windows",
      (r) =>
        !r.ok
          ? fail("rejected; expected resolve")
          : r.output.length === 2 &&
              r.output[0] === "line-one" &&
              r.output[1] === "line-two"
            ? pass(`captured ${r.output.length} output line(s)`)
            : fail(`captured wrong output: ${JSON.stringify(r.output)}`),
    ),
    commandCheck(
      "command:error",
      "command rejects on %error",
      { respond: () => ({ kind: "error", output: ["unknown command"] }) },
      "definitely-not-a-command",
      (r) =>
        r.ok
          ? fail("resolved; expected reject")
          : r.error.response.success === false
            ? pass("execute() rejected with TmuxCommandError")
            : fail("rejected but success flag was not false"),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Catalogue assembly
// ---------------------------------------------------------------------------

/**
 * Build the full deterministic conformance catalogue: every documented
 * notification, both pane-output variants, and the command-correlation contract.
 *
 * [LAW:dataflow-not-control-flow] The command-guard variants (begin/end/error)
 * are excluded as a DATA step — a filter on the channel partition — not an
 * in-loop skip; they carry no per-sample check because their contract is the
 * three commandChecks(). Every remaining sample then maps to exactly one check:
 * the map body always runs and always produces one. isPaneOutput selects the
 * runner by the same partition TmuxClient.handleMessage routes on, narrowing the
 * sample so each runner receives a precisely-typed value with no cast.
 */
export function buildConformanceChecks(): ConformanceCheck[] {
  const perSample = Object.values(MESSAGE_SAMPLES)
    .filter((sample) => CHANNEL_OF[sample.type] !== "command")
    .map((sample) =>
      isPaneOutput(sample)
        ? paneOutputCheck(sample)
        : notificationCheck(sample),
    );
  return [...perSample, ...commandChecks()];
}
