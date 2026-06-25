// src/conformance/index.ts
// Public entry for the protocol conformance suite — the catalogue of checks that
// certify the library surfaces every documented notification and command, run
// against an in-process mock so it is tmux-free and runs anywhere (Node, CI,
// browser tab). "The demo IS the conformance suite": the same catalogue powers
// the web dashboard and the unit gate.
//
// [LAW:one-source-of-truth] Re-exports only. Pure: the heaviest import is the
// real TmuxClient, whose entire closure is browser-safe (the transport is a
// type-only seam), so the same build runs in tests and the dashboard.

export { buildConformanceChecks } from "./checks.js";
export type { ConformanceCheck, CheckOutcome } from "./checks.js";

export { MESSAGE_SAMPLES, CHANNEL_OF } from "./samples.js";
export type { ObservationChannel } from "./samples.js";
