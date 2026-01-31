export type {
  AgentEvent,
  CodexApprovalRequestEvent,
  CodexEvent,
  CodexItemEvent,
  CodexLoginCompleteEvent,
  CodexThreadEvent,
  CodexTurnEvent,
  PtyClientMessage,
  PtyServerEvent,
} from "@forks-sh/protocol";
// biome-ignore lint/performance/noBarrelFile: this is the package entry point
export {
  BrowserNotSupportedError,
  ForksdClient,
  type ForksdClientOptions,
  WebSocketNotReadyError,
} from "./browser-client.js";
export type { ForksdClientEvents, ForksdClientState } from "./types.js";

export const WS_CLIENT_VERSION = "0.1.0";
