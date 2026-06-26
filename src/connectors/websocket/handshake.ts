// src/connectors/websocket/handshake.ts
// [LAW:decomposition] Hello-phase timeout + authenticate() hook wrapper
// extracted from Connection. Owns `helloDeadline`; Connection holds no
// handshake timer state.
import type { AuthResult, UpgradeRequest } from "./types.js";

export class Handshake {
  private deadline: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly timeoutMs: number,
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

  // Run the authenticate hook; catches throws and maps them to AuthResult.
  async authenticate(): Promise<AuthResult> {
    if (this.authHook === undefined) return { ok: true, identity: undefined };
    const req: UpgradeRequest = this.request ?? { headers: {} };
    try {
      return await this.authHook(req);
    } catch (err) {
      return {
        ok: false,
        reason: `authenticate threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
