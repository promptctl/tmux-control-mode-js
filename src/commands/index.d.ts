import type { TmuxConnection } from "../client.js";
import type { CommandResponse } from "../protocol/types.js";
import { PaneAction } from "../protocol/types.js";
import type { SplitOptions } from "../protocol/encoder.js";
export { PaneAction };
export type { SplitOptions };
export declare function listWindows(
  client: TmuxConnection,
): Promise<CommandResponse>;
export declare function listPanes(
  client: TmuxConnection,
): Promise<CommandResponse>;
export declare function sendKeys(
  client: TmuxConnection,
  target: string,
  keys: string,
): Promise<CommandResponse>;
export declare function splitWindow(
  client: TmuxConnection,
  options?: SplitOptions,
): Promise<CommandResponse>;
export declare function setSize(
  client: TmuxConnection,
  width: number,
  height: number,
): Promise<CommandResponse>;
export declare function setPaneAction(
  client: TmuxConnection,
  paneId: number,
  action: PaneAction,
): Promise<CommandResponse>;
export declare function subscribeRaw(
  client: TmuxConnection,
  name: string,
  what: string,
  format: string,
): Promise<CommandResponse>;
export declare function unsubscribe(
  client: TmuxConnection,
  name: string,
): Promise<CommandResponse>;
export declare function setFlags(
  client: TmuxConnection,
  flags: readonly string[],
): Promise<CommandResponse>;
export declare function clearFlags(
  client: TmuxConnection,
  flags: readonly string[],
): Promise<CommandResponse>;
export declare function requestReport(
  client: TmuxConnection,
  paneId: number,
  report: string,
): Promise<CommandResponse>;
export declare function queryClipboard(
  client: TmuxConnection,
): Promise<CommandResponse>;
//# sourceMappingURL=index.d.ts.map
