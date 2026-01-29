/** @forks-sh/git – git operations */

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { WorktreeInfo } from "@forks-sh/protocol";

export const GIT_VERSION = "0.0.0";

const exec = promisify(execFile);

/**
 * Git ref name validation based on git-check-ref-format rules.
 * Prevents command injection via malicious branch names.
 * Forbidden characters include control chars (0x00-0x1F, 0x7F) and special git chars.
 */
const GIT_REF_FORBIDDEN_CHARS = /[ ~^:?*[\]\\@{]/;

export const isValidGitRef = (ref: string): boolean => {
  if (!ref || ref.length === 0 || ref.length > 256) {
    return false;
  }
  // Cannot start with dash (prevents option injection)
  if (ref.startsWith("-")) {
    return false;
  }
  // Cannot end with .lock
  if (ref.endsWith(".lock")) {
    return false;
  }
  // Cannot contain consecutive slashes
  if (ref.includes("//")) {
    return false;
  }
  // Cannot contain @{
  if (ref.includes("@{")) {
    return false;
  }
  // Cannot contain control characters (0x00-0x1F and 0x7F)
  for (const char of ref) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  // Cannot contain special git characters
  if (GIT_REF_FORBIDDEN_CHARS.test(ref)) {
    return false;
  }
  // Check each component between slashes
  const components = ref.split("/");
  for (const component of components) {
    if (
      component.length === 0 ||
      component.startsWith(".") ||
      component.endsWith(".")
    ) {
      return false;
    }
  }
  return true;
};

/**
 * Validates a path is absolute and normalized.
 * Prevents path traversal attacks.
 * Note: Rejects paths with trailing slashes (e.g., "/foo/bar/" fails).
 * Use normalizePath() first if callers may pass trailing slashes.
 */
export const isValidPath = (path: string): boolean => {
  if (!path || path.length === 0 || path.length > 4096) {
    return false;
  }
  // Must be absolute
  if (!path.startsWith("/")) {
    return false;
  }
  // Resolve and compare to detect traversal attempts
  const resolved = resolve(path);
  // After resolution, the path should be equivalent (no .. or . remaining)
  return resolved === path;
};

/**
 * Normalizes a path safely, resolving any traversal components.
 */
export const normalizePath = (path: string): string => {
  return resolve(path);
};

const git = async (
  args: string[],
  cwd?: string
): Promise<{ stdout: string; stderr: string }> => {
  // Normalize cwd if provided to prevent path traversal
  const normalizedCwd = cwd ? normalizePath(cwd) : undefined;
  const result = await exec("git", args, {
    cwd: normalizedCwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};

export const isGitRepo = async (path: string): Promise<boolean> => {
  try {
    await git(["rev-parse", "--git-dir"], path);
    return true;
  } catch {
    return false;
  }
};

export const getRepoRoot = async (path: string): Promise<string> => {
  const { stdout } = await git(["rev-parse", "--show-toplevel"], path);
  return stdout;
};

export const getDefaultBranch = async (repoPath: string): Promise<string> => {
  try {
    const { stdout } = await git(
      ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
      repoPath
    );
    return stdout.replace("origin/", "");
  } catch {
    const { stdout } = await git(["branch", "--show-current"], repoPath);
    return stdout || "main";
  }
};

export const getCurrentBranch = async (path: string): Promise<string> => {
  const { stdout } = await git(["branch", "--show-current"], path);
  return stdout;
};

export const branchExists = async (
  repoPath: string,
  branch: string
): Promise<boolean> => {
  if (!isValidGitRef(branch)) {
    throw new Error("Invalid branch name");
  }
  try {
    await git(["rev-parse", "--verify", `refs/heads/${branch}`], repoPath);
    return true;
  } catch {
    return false;
  }
};

export const createBranch = async (
  repoPath: string,
  branch: string,
  startPoint?: string
): Promise<void> => {
  if (!isValidGitRef(branch)) {
    throw new Error("Invalid branch name");
  }
  if (startPoint && !isValidGitRef(startPoint)) {
    throw new Error("Invalid start point");
  }
  const args = ["branch", branch];
  if (startPoint) {
    args.push(startPoint);
  }
  await git(args, repoPath);
};

export const listWorktrees = async (
  repoPath: string
): Promise<WorktreeInfo[]> => {
  const { stdout } = await git(["worktree", "list", "--porcelain"], repoPath);
  if (!stdout) {
    return [];
  }

  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) {
        worktrees.push(current as WorktreeInfo);
      }
      current = {
        path: line.slice(9),
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
        branch: null,
        head: "",
      };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line.startsWith("locked")) {
      current.locked = true;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }

  if (current.path) {
    worktrees.push(current as WorktreeInfo);
  }

  return worktrees;
};

export interface CreateWorktreeOpts {
  path: string;
  branch: string;
  createBranch?: boolean;
}

export const createWorktree = async (
  repoPath: string,
  opts: CreateWorktreeOpts
): Promise<void> => {
  if (!isValidGitRef(opts.branch)) {
    throw new Error("Invalid branch name");
  }
  // Normalize the worktree path to prevent traversal
  const normalizedPath = normalizePath(opts.path);
  const args = ["worktree", "add"];
  if (opts.createBranch) {
    args.push("-b", opts.branch, normalizedPath);
  } else {
    args.push(normalizedPath, opts.branch);
  }
  await git(args, repoPath);
};

export const removeWorktree = async (
  worktreePath: string,
  opts?: { force?: boolean }
): Promise<void> => {
  // Normalize the worktree path to prevent traversal
  const normalizedPath = normalizePath(worktreePath);
  const args = ["worktree", "remove"];
  if (opts?.force) {
    args.push("--force");
  }
  args.push(normalizedPath);
  await git(args);
};

export const deleteBranch = async (
  repoPath: string,
  branch: string,
  force?: boolean
): Promise<void> => {
  if (!isValidGitRef(branch)) {
    throw new Error("Invalid branch name");
  }
  const flag = force ? "-D" : "-d";
  await git(["branch", flag, branch], repoPath);
};

export const getCurrentCommit = async (repoPath: string): Promise<string> => {
  const { stdout } = await git(["rev-parse", "HEAD"], repoPath);
  return stdout;
};

export const resetHard = async (
  repoPath: string,
  ref: string
): Promise<void> => {
  if (!isValidGitRef(ref)) {
    throw new Error("Invalid ref");
  }
  await git(["reset", "--hard", ref], repoPath);
};

export type { WorktreeInfo } from "@forks-sh/protocol";
