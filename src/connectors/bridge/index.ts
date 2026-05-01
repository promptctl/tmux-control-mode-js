// src/connectors/bridge/index.ts
// Public API for the `./connectors/bridge` subpath export.
// [LAW:one-source-of-truth] Consumer-facing exports declared here only.

export { BridgeModelClient } from "./model-client.js";
export { paneSessionClientFromBridge } from "./pane-client.js";
