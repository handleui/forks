/** @forks-sh/protocol – shared types and wire format */

export const CONFIG_VERSION = "0.0.0";
export const PROTOCOL_VERSION = "0.0.0";

export interface CodexThreadEvent {
  type: "codex:thread";
  threadId: string;
  event: "started" | "completed" | "error";
  data?: unknown;
}

export interface CodexTurnEvent {
  type: "codex:turn";
  threadId: string;
  turnId: string;
  event: "started" | "completed" | "interrupted";
  data?: unknown;
}

export interface CodexItemEvent {
  type: "codex:item";
  threadId: string;
  turnId: string;
  itemId: string;
  event: "started" | "completed" | "delta";
  itemType: "message" | "command" | "fileChange" | "tool";
  content?: string;
  data?: unknown;
}

export interface CodexApprovalRequestEvent {
  type: "codex:approval";
  /** Cryptographically random token for responding to this approval request */
  token: string;
  approvalType: "commandExecution" | "fileChange";
  threadId: string;
  turnId: string;
  itemId: string;
  command?: string;
  cwd?: string;
  reason?: string | null;
  data?: unknown;
}

export interface CodexLoginCompleteEvent {
  type: "codex:loginComplete";
  loginId: string;
  success: boolean;
  error?: string | null;
}

export type CodexEvent =
  | CodexThreadEvent
  | CodexTurnEvent
  | CodexItemEvent
  | CodexApprovalRequestEvent
  | CodexLoginCompleteEvent;

/** PTY Client → Server messages */
export interface PtyAttachMessage {
  type: "pty:attach";
  id: string;
}

export interface PtyDetachMessage {
  type: "pty:detach";
  id: string;
}

export interface PtyInputMessage {
  type: "pty:input";
  id: string;
  data: string;
}

export interface PtyResizeMessage {
  type: "pty:resize";
  id: string;
  cols: number;
  rows: number;
}

export type PtyClientMessage =
  | PtyAttachMessage
  | PtyDetachMessage
  | PtyInputMessage
  | PtyResizeMessage;

/** PTY Server → Client events */
export interface PtyOutputEvent {
  type: "pty:output";
  id: string;
  data: string;
}

export interface PtyAttachedEvent {
  type: "pty:attached";
  id: string;
  history?: string;
}

export interface PtyExitEvent {
  type: "pty:exit";
  id: string;
  exitCode: number;
}

export interface PtyErrorEvent {
  type: "pty:error";
  id: string;
  error: string;
}

export type PtyServerEvent =
  | PtyOutputEvent
  | PtyAttachedEvent
  | PtyExitEvent
  | PtyErrorEvent;

/** Project = a git repository we're tracking */
export interface Project {
  id: string;
  path: string;
  name: string;
  defaultBranch: string;
  createdAt: number;
}

/** Workspace = a managed git worktree */
export interface Workspace {
  id: string;
  projectId: string;
  path: string;
  branch: string;
  name: string;
  status: "active" | "archived";
  createdAt: number;
  lastAccessedAt: number;
}

/** Options for creating a new workspace */
export interface CreateWorkspaceOpts {
  name?: string;
  branch?: string;
}

/** Info about a git worktree from `git worktree list` */
export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

/** Chat = persisted conversation thread */
export interface Chat {
  id: string;
  workspaceId: string;
  codexThreadId: string | null;
  title: string | null;
  status: "active" | "completed" | "archived";
  createdAt: number;
  updatedAt: number;
}

/** Attempt = fork for poly-iteration */
export interface Attempt {
  id: string;
  chatId: string;
  codexThreadId: string | null;
  status: "running" | "completed" | "picked" | "discarded";
  result: string | null;
  error: string | null;
  createdAt: number;
}

/** Subagent = spawned task executor */
export interface Subagent {
  id: string;
  parentChatId: string;
  parentAttemptId: string | null;
  task: string;
  status: "running" | "completed" | "cancelled" | "failed";
  result: string | null;
  error: string | null;
  createdAt: number;
}

/** Task = idempotent work item */
export interface Task {
  id: string;
  chatId: string;
  description: string;
  claimedBy: string | null;
  status: "pending" | "claimed" | "completed" | "failed";
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Plan = proposed implementation plan awaiting approval */
export interface Plan {
  id: string;
  projectId: string;
  chatId: string;
  agentId: string;
  title: string;
  content: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  feedback: string | null;
  createdAt: number;
  respondedAt: number | null;
}

/** Question = agent question awaiting user answer */
export interface Question {
  id: string;
  chatId: string;
  agentId: string;
  content: string;
  status: "pending" | "answered" | "cancelled";
  answer: string | null;
  createdAt: number;
  respondedAt: number | null;
}

/** Event for chat state changes */
export interface ChatEvent {
  type: "chat";
  event: "created" | "resumed" | "completed" | "archived";
  chat: Chat;
}

/** Event for attempt state changes */
export interface AttemptEvent {
  type: "attempt";
  event: "spawned" | "completed" | "picked" | "discarded";
  attempt: Attempt;
}

/** Event for batch attempt spawns (reduces WebSocket message count) */
export interface AttemptBatchEvent {
  type: "attempt_batch";
  event: "spawned";
  attempts: Attempt[];
}

/** Event for subagent state changes */
export interface SubagentEvent {
  type: "subagent";
  event: "spawned" | "progress" | "completed" | "cancelled" | "failed";
  subagent: Subagent;
  progress?: string;
}

/** Event for task state changes */
export interface TaskEvent {
  type: "task";
  event: "created" | "claimed" | "completed" | "failed";
  task: Task;
}

/** Event for plan state changes */
export interface PlanEvent {
  type: "plan";
  event: "proposed" | "approved" | "rejected" | "cancelled";
  plan: Plan;
}

/** Event for question state changes */
export interface QuestionEvent {
  type: "question";
  event: "asked" | "answered" | "cancelled";
  question: Question;
}

/** Terminal = managed terminal session */
export interface Terminal {
  id: string;
  workspaceId: string | null;
  createdBy: "agent" | "user";
  label: string | null;
  cwd: string;
  visibility: "visible" | "background";
  status: "running" | "exited";
  exitCode: number | null;
  command?: string[];
  createdAt: number;
}

/** Event for terminal state changes */
export interface TerminalEvent {
  type: "terminal";
  event: "created" | "promoted" | "closed" | "output";
  terminal: Terminal;
  output?: string;
}

/** Approval = pending command/file change awaiting user decision */
export interface Approval {
  id: string;
  chatId: string;
  token: string;
  approvalType: "commandExecution" | "fileChange";
  threadId: string;
  turnId: string;
  itemId: string;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  status: "pending" | "accepted" | "declined" | "cancelled";
  data?: string | null;
  createdAt: number;
  respondedAt?: number | null;
}

/** Event for approval state changes */
export interface ApprovalEvent {
  type: "approval";
  event: "requested" | "accepted" | "declined" | "cancelled";
  approval: Approval;
}

/** Union of all agent orchestration events */
export type AgentEvent =
  | ChatEvent
  | AttemptEvent
  | AttemptBatchEvent
  | SubagentEvent
  | TaskEvent
  | PlanEvent
  | QuestionEvent
  | TerminalEvent
  | ApprovalEvent;

/** MCP tool input types */
export interface AttemptSpawnInput {
  chatId: string;
  count: number;
  task: string;
}

export interface AttemptPickInput {
  attemptId: string;
}

export interface AttemptStatusInput {
  chatId: string;
}

export interface SubagentSpawnInput {
  chatId: string;
  task: string;
}

export interface SubagentStatusInput {
  subagentId: string;
}

export interface SubagentCancelInput {
  subagentId: string;
}

export interface PlanProposeInput {
  chatId: string;
  title: string;
  plan: string;
}

export interface PlanRespondInput {
  planId: string;
  approved: boolean;
  feedback?: string;
}

export interface PlanStatusInput {
  planId: string;
}

export interface PlanListInput {
  projectId: string;
  status?: "pending" | "approved" | "rejected" | "cancelled";
  limit?: number;
  offset?: number;
}

export interface PlanCancelInput {
  planId: string;
}

export interface AskQuestionInput {
  chatId: string;
  question: string;
}

export interface AskRespondInput {
  questionId: string;
  answer: string;
}

export interface QuestionStatusInput {
  questionId: string;
}

export interface QuestionListInput {
  chatId: string;
  limit?: number;
  offset?: number;
}

export interface QuestionCancelInput {
  questionId: string;
}

export interface TaskClaimInput {
  taskId: string;
}

export interface TaskCompleteInput {
  taskId: string;
  result: string;
}

export interface TaskListInput {
  chatId: string;
}

export interface ApprovalRespondInput {
  approvalId: string;
  decision: "accept" | "acceptForSession" | "decline";
}

export interface ApprovalListInput {
  chatId: string;
  status?: Approval["status"];
  limit?: number;
}

export interface ApprovalStatusInput {
  approvalId: string;
}

export interface ApprovalCancelInput {
  approvalId: string;
}

/** MCP tool response types */
export interface ToolSuccessResponse<T = unknown> {
  ok: true;
  data: T;
}

export interface ToolErrorResponse {
  ok: false;
  error: string;
  code?: string;
}
