import type { ClientInfo } from "../protocol/ClientInfo.js";
import type { CollaborationMode } from "../protocol/CollaborationMode.js";
import type { ReasoningEffort } from "../protocol/ReasoningEffort.js";
import type { ReasoningSummary } from "../protocol/ReasoningSummary.js";
import type { ServerNotification } from "../protocol/ServerNotification.js";
import type { JsonValue } from "../protocol/serde_json/JsonValue.js";
import type {
  Account,
  AskForApproval,
  CommandExecutionRequestApprovalParams,
  CommandExecutionRequestApprovalResponse,
  FileChangeRequestApprovalParams,
  FileChangeRequestApprovalResponse,
  SandboxMode,
  SandboxPolicy,
  ThreadForkResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  TurnStartResponse,
  UserInput,
} from "../protocol/v2/index.js";

export type ApprovalRequestType = "commandExecution" | "fileChange";

export interface CommandExecutionApprovalRequest {
  id: number;
  /** Cryptographically random token for external API use (prevents ID enumeration) */
  token: string;
  type: "commandExecution";
  params: CommandExecutionRequestApprovalParams;
}

export interface FileChangeApprovalRequest {
  id: number;
  /** Cryptographically random token for external API use (prevents ID enumeration) */
  token: string;
  type: "fileChange";
  params: FileChangeRequestApprovalParams;
}

export type ApprovalRequest =
  | CommandExecutionApprovalRequest
  | FileChangeApprovalRequest;

export type ApprovalResponse =
  | CommandExecutionRequestApprovalResponse
  | FileChangeRequestApprovalResponse;

export type ApprovalCallback = (request: ApprovalRequest) => void;

export type { CollaborationMode } from "../protocol/CollaborationMode.js";
export type { Thread, ThreadForkResponse, Turn } from "../protocol/v2/index.js";

export type ThreadId = string;
export type TurnId = string;

export interface ServerInfo {
  userAgent: string;
}

export interface ThreadStartOpts {
  model?: string | null;
  modelProvider?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: { [key in string]?: JsonValue } | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  experimentalRawEvents?: boolean;
}

export interface ThreadResumeOpts {
  path?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: { [key in string]?: JsonValue } | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
}

export interface ThreadForkOpts {
  path?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: { [key in string]?: JsonValue } | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
}

export interface TurnOpts {
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandboxPolicy?: SandboxPolicy | null;
  model?: string | null;
  effort?: ReasoningEffort | null;
  summary?: ReasoningSummary | null;
  outputSchema?: JsonValue | null;
  collaborationMode?: CollaborationMode | null;
}

export interface AuthStatus {
  account: Account | null;
  requiresOpenaiAuth: boolean;
}

export type LoginResult =
  | { type: "apiKey" }
  | { type: "chatgpt"; loginId: string; authUrl: string };

export interface ExecOpts {
  timeoutMs?: number | null;
  cwd?: string | null;
  sandboxPolicy?: SandboxPolicy | null;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type Notification = ServerNotification;

export interface CodexBackend {
  initialize(clientInfo: ClientInfo): Promise<ServerInfo>;
  startThread(opts?: ThreadStartOpts): Promise<ThreadStartResponse>;
  resumeThread(
    threadId: string,
    opts?: ThreadResumeOpts
  ): Promise<ThreadResumeResponse>;
  forkThread(
    threadId: string,
    opts?: ThreadForkOpts
  ): Promise<ThreadForkResponse>;
  startTurn(
    threadId: string,
    input: UserInput[],
    opts?: TurnOpts
  ): Promise<TurnStartResponse>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  checkAuth(refreshToken?: boolean): Promise<AuthStatus>;
  startLogin(type: "apiKey" | "chatgpt", apiKey?: string): Promise<LoginResult>;
  execCommand(cmd: string[], opts?: ExecOpts): Promise<ExecResult>;
  onNotification(cb: (n: Notification) => void): () => void;
  onApprovalRequest(cb: ApprovalCallback): () => void;
  /** Respond using the cryptographically random token (not the internal numeric ID) */
  respondToApproval(token: string, response: ApprovalResponse): boolean;
  shutdown(): Promise<void>;
}

export interface BackendOptions {
  codexPath?: string;
  timeoutMs?: number;
  maxRetries?: number;
  env?: Record<string, string>;
}
