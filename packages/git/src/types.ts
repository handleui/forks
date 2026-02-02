export interface CreateWorktreeOpts {
  path: string;
  branch: string;
  createBranch?: boolean;
}

export type GitStatusKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "typechange"
  | "untracked"
  | "conflicted";

export interface GitStatusEntry {
  path: string;
  status: GitStatusKind;
}
export type { WorktreeInfo } from "@forks-sh/protocol";
