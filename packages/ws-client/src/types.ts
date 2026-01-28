import type {
  AgentEvent,
  CodexEvent,
  PtyServerEvent,
} from "@forks-sh/protocol";

export type ForksdClientState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export interface ForksdClientEvents {
  connected: () => void;
  disconnected: (reason: string) => void;
  error: (error: Error) => void;
  stateChange: (state: ForksdClientState) => void;
  codex: (event: CodexEvent) => void;
  agent: (event: AgentEvent) => void;
  pty: (event: PtyServerEvent) => void;
}
