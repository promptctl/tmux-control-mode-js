// src/commands/index.ts
// Free functions over TmuxConnection — the public tmux command surface.
//
// [LAW:types-are-the-program] All tmux commands are free functions over the
// 5-method TmuxConnection interface. Nothing in this module requires the full
// TmuxClient class. Anything that needs to issue tmux commands types against
// TmuxConnection, not TmuxClient.
// [LAW:one-source-of-truth] Command string construction delegates entirely to
// src/protocol/encoder.ts. This module is pure dispatch: typed params in,
// CommandResponse out.
// [LAW:single-enforcer] execute() is the sole dispatch path; these functions
// are thin wrappers, not an alternate escape hatch.
import { PaneAction } from "../protocol/types.js";
import { refreshClientSize, refreshClientPaneAction, refreshClientSubscribe, refreshClientUnsubscribe, refreshClientSetFlags, refreshClientClearFlags, refreshClientReport, refreshClientQueryClipboard, sendKeys as encodeSendKeys, splitWindow as encodeSplitWindow, } from "../protocol/encoder.js";
export { PaneAction };
const SYNTHETIC_OK = Object.freeze({
    commandNumber: -1,
    timestamp: 0,
    success: true,
    output: [],
});
export function listWindows(client) {
    return client.execute("list-windows -a -F '#{window_id} #{session_id}'");
}
export function listPanes(client) {
    return client.execute("list-panes -a -F '#{pane_id} #{window_id} #{session_id}'");
}
// [LAW:types-are-the-program] The encoder returns null for empty keys
// (no valid wire form exists). A null-keyed send is a no-op — resolved
// immediately with a synthetic success so callers never see a branch.
export function sendKeys(client, target, keys) {
    const cmd = encodeSendKeys(target, keys);
    if (cmd === null)
        return Promise.resolve(SYNTHETIC_OK);
    return client.execute(cmd);
}
export function splitWindow(client, options) {
    return client.execute(encodeSplitWindow(options));
}
export function setSize(client, width, height) {
    return client.execute(refreshClientSize(width, height));
}
export function setPaneAction(client, paneId, action) {
    return client.execute(refreshClientPaneAction(paneId, action));
}
export function subscribeRaw(client, name, what, format) {
    return client.execute(refreshClientSubscribe(name, what, format));
}
export function unsubscribe(client, name) {
    return client.execute(refreshClientUnsubscribe(name));
}
export function setFlags(client, flags) {
    return client.execute(refreshClientSetFlags(flags));
}
export function clearFlags(client, flags) {
    return client.execute(refreshClientClearFlags(flags));
}
export function requestReport(client, paneId, report) {
    return client.execute(refreshClientReport(paneId, report));
}
export function queryClipboard(client) {
    return client.execute(refreshClientQueryClipboard());
}
//# sourceMappingURL=index.js.map