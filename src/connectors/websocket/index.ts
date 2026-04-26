// src/connectors/websocket/index.ts
// Barrel for the WebSocket bridge.
//
// Consumers typically import from the subpath exports:
//   - `@promptctl/tmux-control-mode-js/websocket/server` — server bridge
//   - `@promptctl/tmux-control-mode-js/websocket/client` — browser proxy
//
// This root barrel is useful for Node-side code that needs both halves
// (tests, reference examples).
//
// [LAW:one-source-of-truth] Re-exports only; no logic lives here.

export {
  BridgeError,
  BridgeProtocolError,
  PROTOCOL_VERSION,
  PANE_OUTPUT_MAGIC,
  isPaneOutputFrame,
  encodePaneOutput,
  decodePaneOutput,
  encodeClientFrame,
  encodeServerFrame,
  parseClientFrame,
  parseServerFrame,
  type BridgeErrorCode,
  type BridgeErrorPayload,
  type ClientFrame,
  type ServerFrame,
  type SerializedEventMessage,
  type RpcMethod,
  type WelcomeLimits,
  type PaneOutputMessage,
} from "./protocol.js";

export {
  WEBSOCKET_OPEN,
  WEBSOCKET_CLOSING,
  WEBSOCKET_CLOSED,
  type BrowserWebSocketLike,
  type ServerWebSocketLike,
  type UpgradeRequest,
  type AuthResult,
  type AuthorizeRequest,
  type AuthorizeResult,
  type ConnectionIdentity,
  type BridgeObservabilityEvent,
  type RateLimitConfig,
  type ReconnectPolicy,
} from "./types.js";

export {
  createWebSocketBridge,
  type WebSocketBridge,
  type WebSocketBridgeOptions,
  type ConnectionContext,
} from "./server.js";

export {
  WebSocketTmuxClient,
  type WebSocketTmuxClientOptions,
  type WebSocketTmuxClientState,
} from "./client.js";
