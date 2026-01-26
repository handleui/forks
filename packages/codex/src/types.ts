/** @forks-sh/codex – Codex adapter types */

import type {
  ApprovalRequest as ApprovalRequestType,
  ApprovalResponse as ApprovalResponseType,
  AuthStatus as AuthStatusType,
  ExecResult as ExecResultType,
  LoginResult as LoginResultType,
  ThreadForkResponse as ThreadForkResponseType,
} from "./backend/interface.js";

export type {
  ApprovalCallback,
  ApprovalRequest,
  ApprovalResponse,
  AuthStatus,
  CommandExecutionApprovalRequest,
  ExecOpts,
  ExecResult,
  FileChangeApprovalRequest,
  LoginResult,
  ThreadForkOpts,
  ThreadForkResponse,
} from "./backend/interface.js";

type ApprovalRequest = ApprovalRequestType;
type ApprovalResponse = ApprovalResponseType;
type AuthStatus = AuthStatusType;
type ExecResult = ExecResultType;
type LoginResult = LoginResultType;
type ThreadForkResponse = ThreadForkResponseType;

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
}

export interface CodexAdapter {
  startThread(): CodexThread;
  sendTurn(threadId: string, input: string): Promise<RunId>;
  run(threadId: string, input: string): Promise<RunResult>;
  onEvent(callback: (event: CodexEvent) => void): () => void;
  onApprovalRequest(callback: (request: ApprovalRequest) => void): () => void;
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
