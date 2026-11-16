// src/connectors/websocket/handshake.ts
// [LAW:decomposition] Hello-phase timeout + authenticate() hook wrapper
// extracted from Connection. Owns `helloDeadline`; Connection holds no
// handshake timer state.
import {
  AUTH_DENIED,
  INTERNAL_ERROR,
  serverCloseCodeParser,
  type ServerCloseCode,
} from "./close-code.js";
import type { DurationMs } from "./limits.js";
import type { AuthResult, UpgradeRequest } from "./types.js";

/** An auth hook's result, parsed: a denial carries the code its close may
 *  send. */
export type AuthVerdict =
  | Extract<AuthResult, { ok: true }>
  | {
      readonly ok: false;
      readonly closeCode: ServerCloseCode;
      readonly reason: string;
    };

// [LAW:parse-dont-validate] A hook's code is the consumer's, so it is parsed
// here, where the hook's result enters the bridge. A code the socket may not
// send is the hook's defect, raised like a throw from the hook.
const parseCloseCode = serverCloseCodeParser((message) => new Error(message));

export class Handshake {
  private deadline: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly timeoutMs: DurationMs,
    private readonly request: UpgradeRequest | undefined,
    private readonly authHook:
      | ((req: UpgradeRequest) => Promise<AuthResult> | AuthResult)
      | undefined,
  ) {}

  // Arm the hello-timeout; `onTimeout` fires if hello isn't received in time.
  arm(onTimeout: () => void): void {
    this.deadline = setTimeout(onTimeout, this.timeoutMs);
    this.deadline.unref?.();
  }

  // Disarm the hello-timeout (called when hello is received).
  clear(): void {
    if (this.deadline !== null) {
      clearTimeout(this.deadline);
      this.deadline = null;
    }
  }

  // Run the authenticate hook. A denial it returns is its decision and closes
  // with its code. A hook that throws is a fault, not a decision: the peer is
  // still denied, under INTERNAL_ERROR, which a client retries — an auth
  // backend's outage must not refuse a connection for good (isRefusal). A
  // code the socket may not send is the hook's own defect, the same on every
  // retry, so it is a denial naming the defect under AUTH_DENIED.
  async authenticate(): Promise<AuthVerdict> {
    if (this.authHook === undefined) return { ok: true, identity: undefined };
    const req: UpgradeRequest = this.request ?? { headers: {} };
    let result: AuthResult;
    try {
      result = await this.authHook(req);
    } catch (err) {
      return {
        ok: false,
        closeCode: INTERNAL_ERROR,
        reason: `authenticate failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (result.ok) return result;
    try {
      return {
        ok: false,
        closeCode: parseCloseCode(
          `close code for denial "${result.reason}"`,
          result.code ?? AUTH_DENIED,
        ),
        reason: result.reason,
      };
    } catch (err) {
      return {
        ok: false,
        closeCode: AUTH_DENIED,
        reason: `authenticate failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
