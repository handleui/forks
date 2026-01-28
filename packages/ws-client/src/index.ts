/** @forks-sh/ws-client – WebSocket client for forksd */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

// Re-export protocol types consumers will need
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
  ForksdClient,
  type ForksdClientOptions,
  WebSocketNotReadyError,
} from "./client.js";
export type { ForksdClientEvents, ForksdClientState } from "./types.js";

export const WS_CLIENT_VERSION = pkg.version;
