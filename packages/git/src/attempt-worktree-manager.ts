/** AttemptWorktreeManager - manages git worktrees for parallel attempts */

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Workspace } from "@forks-sh/protocol";
import {
  createWorktree,
  deleteBranch,
  isValidGitRef,
  removeWorktree,
} from "./index.js";

const ATTEMPTS_ROOT = resolve(join(homedir(), ".forks", "attempts"));

const PATH_COMPONENT_PATTERN = /^[a-zA-Z0-9_-]+$/;

export interface AttemptWorktreeResult {
  path: string;
  branch: string;
}

export interface AttemptWorktreeManager {
  create(
    attemptId: string,
    workspace: Workspace
  ): Promise<AttemptWorktreeResult>;
  cleanup(
    worktreePath: string,
    branch: string,
    repoPath: string
  ): Promise<void>;
  cleanupForWorkspace(
    workspaceId: string,
    keepAttemptIds: string[]
  ): Promise<void>;
  getAttemptPath(workspaceId: string, attemptId: string): string;
}

/**
 * Validates that a path is within the attempts root directory.
 * Uses resolve() to normalize paths and prevent traversal attacks.
 * @param path - The path to validate (must be absolute)
 * @returns true if path is safely within ATTEMPTS_ROOT
 */
const isWithinAttemptsRoot = (path: string): boolean => {
  const normalizedPath = resolve(path);
  // Must start with ATTEMPTS_ROOT followed by a path separator
  // This prevents attacks like ATTEMPTS_ROOT + "/../escape"
  return (
    normalizedPath.startsWith(`${ATTEMPTS_ROOT}/`) &&
    normalizedPath.length > ATTEMPTS_ROOT.length + 1
  );
};

/**
 * Validates that an ID is safe for use in file paths.
 * Prevents path traversal by rejecting special characters.
 * @param id - The ID to validate (workspaceId or attemptId)
 * @returns true if ID is safe for path construction
 */
const isValidPathComponent = (id: string): boolean => {
  if (!id || id.length === 0 || id.length > 256) {
    return false;
  }
  if (!PATH_COMPONENT_PATTERN.test(id)) {
    return false;
  }
  if (id === "." || id === "..") {
    return false;
  }
  return true;
};

const forceRemoveWorktree = async (worktreePath: string): Promise<void> => {
  try {
    await removeWorktree(worktreePath, { force: true });
  } catch {
    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  }
};

export const createAttemptWorktreeManager = (): AttemptWorktreeManager => {
  mkdirSync(ATTEMPTS_ROOT, { recursive: true });

  return {
    async create(attemptId, workspace) {
      // Validate path components before construction to prevent traversal
      if (!isValidPathComponent(workspace.id)) {
        throw new Error("Invalid workspace ID");
      }
      if (!isValidPathComponent(attemptId)) {
        throw new Error("Invalid attempt ID");
      }

      const branch = `attempt/${attemptId}`;
      // Use resolve() to get canonical path after join
      const attemptPath = resolve(join(ATTEMPTS_ROOT, workspace.id, attemptId));

      if (!isValidGitRef(branch)) {
        throw new Error("Invalid branch name");
      }

      // Defense-in-depth: verify resolved path is within attempts root
      if (!isWithinAttemptsRoot(attemptPath)) {
        throw new Error("Invalid attempt path");
      }

      const workspaceDir = resolve(join(ATTEMPTS_ROOT, workspace.id));
      if (
        !isWithinAttemptsRoot(workspaceDir) &&
        workspaceDir !== ATTEMPTS_ROOT
      ) {
        throw new Error("Invalid workspace directory");
      }
      mkdirSync(workspaceDir, { recursive: true });

      await createWorktree(workspace.path, {
        path: attemptPath,
        branch,
        createBranch: true,
      });

      return { path: attemptPath, branch };
    },

    async cleanup(worktreePath, branch, repoPath) {
      // Normalize path to prevent traversal attacks
      const normalizedPath = resolve(worktreePath);
      if (!isWithinAttemptsRoot(normalizedPath)) {
        throw new Error("Invalid worktree path");
      }

      // Validate branch name before deletion (defense-in-depth)
      if (!isValidGitRef(branch)) {
        throw new Error("Invalid branch name");
      }

      // Run worktree removal and branch deletion in parallel for better performance
      // Branch deletion may fail if worktree still references it, but we use force flag
      await Promise.all([
        forceRemoveWorktree(normalizedPath),
        deleteBranch(repoPath, branch, true).catch(() => {
          // Branch may already be deleted or never existed
        }),
      ]);
    },

    async cleanupForWorkspace(workspaceId, keepAttemptIds) {
      // Validate workspaceId before path construction
      if (!isValidPathComponent(workspaceId)) {
        throw new Error("Invalid workspace ID");
      }

      const workspaceAttemptsDir = resolve(join(ATTEMPTS_ROOT, workspaceId));

      if (!existsSync(workspaceAttemptsDir)) {
        return;
      }

      // Defense-in-depth: verify resolved path is within attempts root
      if (!isWithinAttemptsRoot(workspaceAttemptsDir)) {
        throw new Error("Invalid workspace attempts path");
      }

      const keepSet = new Set(keepAttemptIds);
      const entries = readdirSync(workspaceAttemptsDir, {
        withFileTypes: true,
      });
      const dirsToRemove = entries
        .filter((e) => e.isDirectory() && !keepSet.has(e.name))
        .map((e) => resolve(join(workspaceAttemptsDir, e.name)))
        .filter(isWithinAttemptsRoot);

      await Promise.all(dirsToRemove.map(forceRemoveWorktree));

      const remaining = readdirSync(workspaceAttemptsDir);
      if (remaining.length === 0) {
        rmSync(workspaceAttemptsDir, { recursive: true, force: true });
      }
    },

    getAttemptPath(workspaceId, attemptId) {
      // Validate path components before construction
      if (!isValidPathComponent(workspaceId)) {
        throw new Error("Invalid workspace ID");
      }
      if (!isValidPathComponent(attemptId)) {
        throw new Error("Invalid attempt ID");
      }
      return resolve(join(ATTEMPTS_ROOT, workspaceId, attemptId));
    },
  };
};
