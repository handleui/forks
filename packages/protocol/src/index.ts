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
