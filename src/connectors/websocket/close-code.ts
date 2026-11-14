// src/connectors/websocket/close-code.ts
// The close codes the bridge's socket may send, and the bridge's own.
//
// [LAW:parse-dont-validate] A `ServerCloseCode` can only come from this
// module, so `close()` — which throws on a code it may not send — is handed
// nothing unchecked. The bridge's own codes are stamped here; a consumer's
// (an auth hook's denial code) is parsed where it enters the bridge
// (Handshake).

import { parser, type ParserMaker } from "./limits.js";

declare const serverCloseCode: unique symbol;

/** A status code a WebSocket endpoint may send in a close frame: RFC 6455
 *  §7.4's registered codes less the reserved ones (1004, and 1005/1006/1015,
 *  which describe a close no frame carried), plus the 3000–4999 range for
 *  libraries and applications. Exactly the set `ws` accepts. */
export type ServerCloseCode = number & { readonly [serverCloseCode]: true };

function isServerCloseCode(value: unknown): value is ServerCloseCode {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    ((value >= 1000 && value <= 1003) ||
      (value >= 1007 && value <= 1014) ||
      (value >= 3000 && value <= 4999))
  );
}

export const serverCloseCodeParser: ParserMaker<ServerCloseCode> = parser(
  isServerCloseCode,
  "an integer in 1000–1003, 1007–1014 or 3000–4999",
);

/** The connection ended as intended: the bridge's goodbye. */
export const NORMAL_CLOSURE = 1000 as ServerCloseCode;
/** The bridge is shutting down. */
export const GOING_AWAY = 1001 as ServerCloseCode;
/** The bridge hit a condition that kept it from serving the connection. */
export const INTERNAL_ERROR = 1011 as ServerCloseCode;
/** Authentication denied the connection: the code an auth hook's denial
 *  closes with when it names none, or names one the socket may not send. */
export const AUTH_DENIED = 4401 as ServerCloseCode;
