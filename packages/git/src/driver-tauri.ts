import type { GitDriver } from "./driver.js";
import type {
  CreateWorktreeOpts,
  GitStatusEntry,
  WorktreeInfo,
} from "./types.js";

interface TauriCore {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
}

let tauriCorePromise: Promise<TauriCore> | null = null;

const loadTauriCore = (): Promise<TauriCore> => {
  if (!tauriCorePromise) {
    const moduleName = "@tauri-apps/api/core";
    tauriCorePromise = import(moduleName).then((core) => ({
      invoke: core.invoke,
    }));
  }
  return tauriCorePromise;
};

const invokeGit = async <T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> => {
  const { invoke } = await loadTauriCore();
  return invoke<T>(command, args);
};

export const createTauriGitDriver = (): GitDriver => ({
  isGitRepo: async (path) => invokeGit("git_is_repo", { path }),

  getRepoRoot: async (path) => invokeGit("git_repo_root", { path }),

  getDefaultBranch: async (repoPath) =>
    invokeGit("git_default_branch", { repoPath }),

  getCurrentBranch: async (path) => invokeGit("git_current_branch", { path }),

  branchExists: async (repoPath, branch) =>
    invokeGit("git_branch_exists", { repoPath, branch }),

  createBranch: async (repoPath, branch, startPoint) =>
    invokeGit("git_create_branch", { repoPath, branch, startPoint }),

  listWorktrees: async (repoPath) =>
    invokeGit<WorktreeInfo[]>("git_list_worktrees", { repoPath }),

  createWorktree: async (repoPath, opts: CreateWorktreeOpts) =>
    invokeGit("git_create_worktree", {
      repoPath,
      path: opts.path,
      branch: opts.branch,
      createBranch: opts.createBranch ?? false,
    }),

  removeWorktree: async (worktreePath, opts) =>
    invokeGit("git_remove_worktree", {
      worktreePath,
      force: opts?.force ?? false,
    }),

  deleteBranch: async (repoPath, branch, force) =>
    invokeGit("git_delete_branch", {
      repoPath,
      branch,
      force: force ?? false,
    }),

  getCurrentCommit: async (repoPath) =>
    invokeGit("git_current_commit", { repoPath }),

  resetHard: async (repoPath, ref) =>
    invokeGit("git_reset_hard", { repoPath, gitRef: ref }),

  getStatus: async (repoPath) =>
    invokeGit<GitStatusEntry[]>("git_status", { repoPath }),

  getChangedFiles: async (repoPath) =>
    invokeGit<string[]>("git_changed_files", { repoPath }),
});
