// src/window-terminal/engine/token.ts
//
// Tokens that name this page's tmux subscriptions. tmux keys `refresh-client
// -B` subscriptions by name per control client, and through a WebSocket bridge
// every browser shares the bridge's one control client — so a name must be
// unique across every page on that bridge, not just within one page, or one
// page's unsubscribe silently ends another's subscription.
//
// [LAW:no-shared-mutable-globals] The counter's only writer is `uniqueToken`;
//   the random prefix separates pages, the counter separates instances within
//   one.

const PAGE = Math.random().toString(36).slice(2, 10);
let next = 0;

export function uniqueToken(): string {
  return `${PAGE}${(next++).toString(36)}`;
}
