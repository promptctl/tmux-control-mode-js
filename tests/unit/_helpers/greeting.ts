// tests/unit/_helpers/greeting.ts
// tmux emits one unsolicited %begin/%end guard pair on attach, before any
// caller-issued command's own guard block (SPEC.md §5). TmuxClient consumes
// that pair internally (see TmuxClient.awaitingGreeting) and does not reach
// "ready" — or correlate any caller command — until it closes.
//
// [LAW:one-source-of-truth] Every fake-transport test that feeds raw
// %begin/%end lines to a freshly constructed TmuxClient must replay this
// frame first, or it is asserting against a wire trace no real tmux ever
// produces (its own first %begin/%end would otherwise be mistaken for the
// greeting and silently swallowed).
// flags=1 (CMDQ_STATE_CONTROL, SPEC.md §4) — every control-client guard block
// carries it, including this unsolicited one.
export const STARTUP_GREETING = "%begin 0 0 1\n%end 0 0 1\n";
