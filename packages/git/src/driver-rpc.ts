import type { GitDriver } from "./driver.js";
import { requestRpc } from "./rpc-client.js";
import type {
  CreateWorktreeOpts,
  GitStatusEntry,
  WorktreeInfo,
} from "./types.js";

export const createRpcGitDriver = (socketPath: string): GitDriver => {
  return {
    isGitRepo: async (path) => requestRpc(socketPath, "git_is_repo", { path }),

    getRepoRoot: async (path) =>
      requestRpc(socketPath, "git_repo_root", { path }),

    getDefaultBranch: async (repoPath) =>
      requestRpc(socketPath, "git_default_branch", { repoPath }),

    getCurrentBranch: async (path) =>
      requestRpc(socketPath, "git_current_branch", { path }),

    branchExists: async (repoPath, branch) =>
      requestRpc(socketPath, "git_branch_exists", { repoPath, branch }),

    createBranch: async (repoPath, branch, startPoint) =>
      requestRpc(socketPath, "git_create_branch", {
        repoPath,
        branch,
        startPoint,
      }),

    listWorktrees: async (repoPath) =>
      requestRpc<WorktreeInfo[]>(socketPath, "git_list_worktrees", {
        repoPath,
      }),

    createWorktree: async (repoPath, opts: CreateWorktreeOpts) =>
      requestRpc(socketPath, "git_create_worktree", {
        repoPath,
        path: opts.path,
        branch: opts.branch,
        createBranch: opts.createBranch ?? false,
      }),

    removeWorktree: async (worktreePath, opts) =>
      requestRpc(socketPath, "git_remove_worktree", {
        worktreePath,
        force: opts?.force ?? false,
      }),

    deleteBranch: async (repoPath, branch, force) =>
      requestRpc(socketPath, "git_delete_branch", {
        repoPath,
        branch,
        force: force ?? false,
      }),

    getCurrentCommit: async (repoPath) =>
      requestRpc(socketPath, "git_current_commit", { repoPath }),

    resetHard: async (repoPath, ref) =>
      requestRpc(socketPath, "git_reset_hard", { repoPath, gitRef: ref }),

    getStatus: async (repoPath) =>
      requestRpc<GitStatusEntry[]>(socketPath, "git_status", { repoPath }),

    getChangedFiles: async (repoPath) =>
      requestRpc<string[]>(socketPath, "git_changed_files", { repoPath }),
  };
};
