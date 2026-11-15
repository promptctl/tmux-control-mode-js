// src/window-terminal/engine/teardown.ts
//
// Rejection handlers for the commands a window terminal sends as it goes
// away. Nothing is left to report to by then, so a failure that matters
// surfaces as an unhandled rejection; one that leaves the state the command
// asked for is the expected outcome.

import { isAlreadyUnsubscribed, isConnectionGone } from "../../browser.js";

/** A gone connection is the expected outcome. */
export function rethrowUnlessGone(err: unknown): void {
  if (!isConnectionGone(err)) throw err;
}

/** An `unsubscribe` whose name already holds no subscription is done. */
export function rethrowUnlessUnsubscribed(err: unknown): void {
  if (!isAlreadyUnsubscribed(err)) throw err;
}
