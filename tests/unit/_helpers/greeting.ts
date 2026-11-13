// tests/unit/_helpers/greeting.ts
// tmux answers the command it was started with in one %begin/%end guard pair
// before any caller-issued command's own guard block (SPEC.md §5). TmuxClient
// reaches "ready" when that pair closes.
//
// [LAW:one-source-of-truth] Every fake-transport test that feeds raw
// %begin/%end lines to a freshly constructed TmuxClient replays this frame
// first, or it is asserting against a wire trace no real tmux ever produces.
// flags=0: no client wrote that command on its stdin (SPEC.md §5). The reply
// to a caller's command carries flags=1.
export const STARTUP_GREETING = "%begin 0 0 0\n%end 0 0 0\n";
