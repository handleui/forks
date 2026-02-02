/** @forks-sh/git – git operations */

import { resolve } from "node:path";
import { computeUnifiedDiff as computeUnifiedDiffImpl } from "./diff.js";
import {
  getGitDriver,
  getGitDriverKind as getGitDriverKindImpl,
  setGitDriver as setGitDriverImpl,
} from "./driver.js";
import type {
  CreateWorktreeOpts as CreateWorktreeOptsType,
  GitStatusEntry as GitStatusEntryType,
  WorktreeInfo as WorktreeInfoType,
} from "./types.js";

export const GIT_VERSION = "0.0.0";

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

export const isGitRepo = async (path: string): Promise<boolean> => {
  const driver = await getGitDriver();
  return driver.isGitRepo(normalizePath(path));
};

export const getRepoRoot = async (path: string): Promise<string> => {
  const driver = await getGitDriver();
  return driver.getRepoRoot(normalizePath(path));
};

export const getDefaultBranch = async (repoPath: string): Promise<string> => {
  const driver = await getGitDriver();
  return driver.getDefaultBranch(normalizePath(repoPath));
};

export const getCurrentBranch = async (path: string): Promise<string> => {
  const driver = await getGitDriver();
  return driver.getCurrentBranch(normalizePath(path));
};

export const branchExists = async (
  repoPath: string,
  branch: string
): Promise<boolean> => {
  if (!isValidGitRef(branch)) {
    throw new Error("Invalid branch name");
  }
  const driver = await getGitDriver();
  return driver.branchExists(normalizePath(repoPath), branch);
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
  const driver = await getGitDriver();
  await driver.createBranch(normalizePath(repoPath), branch, startPoint);
};

export const listWorktrees = async (
  repoPath: string
): Promise<WorktreeInfo[]> => {
  const driver = await getGitDriver();
  return driver.listWorktrees(normalizePath(repoPath));
};

export const createWorktree = async (
  repoPath: string,
  opts: CreateWorktreeOpts
): Promise<void> => {
  if (!isValidGitRef(opts.branch)) {
    throw new Error("Invalid branch name");
  }
  // Normalize the worktree path to prevent traversal
  const normalizedPath = normalizePath(opts.path);
  const driver = await getGitDriver();
  await driver.createWorktree(normalizePath(repoPath), {
    ...opts,
    path: normalizedPath,
  });
};

export const removeWorktree = async (
  worktreePath: string,
  opts?: { force?: boolean }
): Promise<void> => {
  // Normalize the worktree path to prevent traversal
  const normalizedPath = normalizePath(worktreePath);
  const driver = await getGitDriver();
  await driver.removeWorktree(normalizedPath, opts);
};

export const deleteBranch = async (
  repoPath: string,
  branch: string,
  force?: boolean
): Promise<void> => {
  if (!isValidGitRef(branch)) {
    throw new Error("Invalid branch name");
  }
  const driver = await getGitDriver();
  await driver.deleteBranch(normalizePath(repoPath), branch, force);
};

export const getCurrentCommit = async (repoPath: string): Promise<string> => {
  const driver = await getGitDriver();
  return driver.getCurrentCommit(normalizePath(repoPath));
};

export const resetHard = async (
  repoPath: string,
  ref: string
): Promise<void> => {
  if (!isValidGitRef(ref)) {
    throw new Error("Invalid ref");
  }
  const driver = await getGitDriver();
  await driver.resetHard(normalizePath(repoPath), ref);
};

export const getStatus = async (
  repoPath: string
): Promise<GitStatusEntry[]> => {
  const driver = await getGitDriver();
  return driver.getStatus(normalizePath(repoPath));
};

export const getChangedFiles = async (repoPath: string): Promise<string[]> => {
  const driver = await getGitDriver();
  return driver.getChangedFiles(normalizePath(repoPath));
};

export const computeUnifiedDiff = (
  original: string,
  modified: string,
  options?: { contextLines?: number }
): Promise<string> => computeUnifiedDiffImpl(original, modified, options);

export const getGitDriverKind = (): ReturnType<typeof getGitDriverKindImpl> =>
  getGitDriverKindImpl();

export const setGitDriver = (
  driver: Parameters<typeof setGitDriverImpl>[0]
): void => {
  setGitDriverImpl(driver);
};

export type CreateWorktreeOpts = CreateWorktreeOptsType;
export type GitStatusEntry = GitStatusEntryType;
export type WorktreeInfo = WorktreeInfoType;
