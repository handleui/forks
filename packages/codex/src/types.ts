/** @forks-sh/codex – Codex adapter types */

import type {
  ApprovalRequest,
  ApprovalResponse,
  AuthStatus,
  ExecResult,
  LoginResult,
  ThreadForkResponse,
} from "./backend/interface.js";

export type {
  ApprovalCallback,
  ApprovalRequest,
  ApprovalResponse,
  AuthStatus,
  CollaborationMode,
  CommandExecutionApprovalRequest,
  ExecOpts,
  ExecResult,
  FileChangeApprovalRequest,
  LoginResult,
  ThreadForkOpts,
  ThreadForkResponse,
} from "./backend/interface.js";

export interface CodexThread {
  readonly id: string | null;
}

export type RunId = string;

export interface RunResult {
  items: unknown[];
  finalResponse: string;
  usage: unknown | null;
}

export interface CodexEvent {
  type: string;
  [key: string]: unknown;
}

export interface LoginCompleteEvent {
  type: "account/login/completed";
  loginId: string;
  success: boolean;
  error?: string | null;
}

export interface AdapterStatus {
  installed: boolean;
  authenticated: boolean;
  ready: boolean;
  error?: string;
  exitCode?: number | null;
}

export interface ThreadStartOpts {
  /** Base instructions to inject into the thread context */
  baseInstructions?: string | null;
}

export interface SendTurnOpts {
  /** Working directory for this turn */
  cwd?: string | null;
  collaborationMode?: import("./backend/interface.js").CollaborationMode | null;
}

export interface ProcessExitInfo {
  code: number | null;
  error?: string;
}

export interface CodexAdapter {
  startThread(opts?: ThreadStartOpts): CodexThread;
  sendTurn(
    threadId: string,
    input: string,
    opts?: SendTurnOpts
  ): Promise<RunId>;
  run(threadId: string, input: string): Promise<RunResult>;
  onEvent(callback: (event: CodexEvent) => void): () => void;
  onApprovalRequest(callback: (request: ApprovalRequest) => void): () => void;
  onExit(callback: (info: ProcessExitInfo) => void): () => void;
  /** Respond using the cryptographically random token (not the internal numeric ID) */
  respondToApproval(token: string, response: ApprovalResponse): boolean;
  cancel(runId: string): Promise<void>;
  getStatus(): Promise<AdapterStatus>;
  setWorkingDirectory(cwd: string): void;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  checkAuth(): Promise<AuthStatus>;
  startLogin(type: "apiKey" | "chatgpt", apiKey?: string): Promise<LoginResult>;
  forkThread(
    threadId: string,
    opts?: { cwd?: string | null }
  ): Promise<ThreadForkResponse>;
  execCommand(
    cmd: string[],
    opts?: { cwd?: string | null; timeoutMs?: number | null }
  ): Promise<ExecResult>;
}

export interface CodexAdapterOptions {
  codexPathOverride?: string;
  env?: Record<string, string>;
}
