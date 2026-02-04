/** Claude Code backend interface */

import type { CCEvent, CCPermissionMode, ProcessExitInfo } from "../types.js";

export type SessionId = string;
export type TurnId = string;

export interface SessionStartOpts {
  /** Working directory */
  cwd?: string | null;
  /** Model to use (opus, sonnet, haiku) */
  model?: string | null;
  /** Custom system prompt (replaces default) */
  systemPrompt?: string | null;
  /** Append to default system prompt */
  appendSystemPrompt?: string | null;
  /** Base instructions for the session */
  baseInstructions?: string | null;
  /** Permission mode for this session */
  permissionMode?: CCPermissionMode | null;
}

export interface SessionStartResponse {
  sessionId: SessionId;
}

export interface TurnOpts {
  /** Working directory for this turn */
  cwd?: string | null;
  /** Model override for this turn */
  model?: string | null;
  /** Maximum agentic turns */
  maxTurns?: number | null;
  /** Permission mode override for this turn */
  permissionMode?: CCPermissionMode | null;
}

export interface TurnStartResponse {
  turnId: TurnId;
}

export type NotificationHandler = (notification: CCEvent) => void;
export type ExitHandler = (info: ProcessExitInfo) => void;

export interface CCBackend {
  /**
   * Initialize the backend (verify claude binary exists)
   */
  initialize(): Promise<void>;

  /**
   * Start a new session (generates a session ID)
   */
  startSession(opts?: SessionStartOpts): Promise<SessionStartResponse>;

  /**
   * Send a turn to the session
   * Events are emitted via onNotification callback
   */
  startTurn(
    sessionId: SessionId,
    input: string,
    opts?: TurnOpts
  ): Promise<TurnStartResponse>;

  /**
   * Interrupt the current turn
   */
  interruptTurn(sessionId: SessionId): Promise<void>;

  /**
   * Subscribe to notifications (mapped events)
   */
  onNotification(handler: NotificationHandler): () => void;

  /**
   * Subscribe to process exit events
   */
  onExit(handler: ExitHandler): () => void;

  /**
   * Shutdown the backend
   */
  shutdown(): Promise<void>;
}

export interface BackendOptions {
  claudePath?: string;
  model?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  maxTurns?: number;
  env?: Record<string, string>;
  /**
   * @deprecated Use permissionMode instead
   * Skip Claude Code permission checks (--dangerously-skip-permissions).
   * Defaults to true for backwards compatibility.
   */
  skipPermissions?: boolean;
  /**
   * Permission mode for Claude Code sessions.
   * Defaults to "bypassPermissions" for backwards compatibility.
   *
   * SECURITY: "bypassPermissions" allows Claude to execute any tool without approval.
   * Only safe for local-only apps where the user controls all inputs.
   */
  permissionMode?: CCPermissionMode;
}
