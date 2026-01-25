/** @forks-sh/protocol – shared types and wire format */

export const CONFIG_VERSION = "0.0.0";
export const PROTOCOL_VERSION = "0.0.0";

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
