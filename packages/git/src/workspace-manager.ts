import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  CreateWorkspaceOpts,
  Project,
  Workspace,
} from "@forks-sh/protocol";
import type { Store } from "@forks-sh/store";
import { createEnvManager } from "./env-manager.js";
import {
  branchExists,
  createWorktree,
  getDefaultBranch,
  getRepoRoot,
  isGitRepo,
  isValidGitRef,
  listWorktrees,
  removeWorktree,
} from "./index.js";

const WORKSPACES_ROOT = join(homedir(), ".forks", "workspaces");

const generateId = (): string => randomBytes(4).toString("hex");

/** Runs a command asynchronously without blocking the event loop. */
const runCommandAsync = (
  cmd: string,
  args: string[],
  cwd: string
): Promise<void> =>
  new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: "inherit" });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);

/** Runs post-workspace-creation hooks (env profile, install) */
const runPostCreationHooks = async (
  worktreePath: string,
  projectPath: string,
  workspaceId: string,
  opts: CreateWorkspaceOpts,
  project: { runInstall: boolean },
  store: Store,
  envMgr: EnvManager
): Promise<void> => {
  // Apply environment profile symlinks if a profile is specified
  if (opts.profileId) {
    const profile = store.getEnvProfile(opts.profileId);
    if (profile) {
      const result = envMgr.applyProfile(
        worktreePath,
        projectPath,
        profile.files
      );
      if (!result.success) {
        // Profile application failed - clear the profileId from workspace
        // to avoid inconsistent state where workspace claims to have a profile
        // that wasn't actually applied
        console.error(
          `[workspace-manager] Profile application failed for workspace ${workspaceId}:`,
          result.errors.join(", ")
        );
        store.updateWorkspace(workspaceId, { profileId: null });
      }
    }
  }

  // Run install command if project has runInstall enabled and hooks aren't skipped
  // Note: Install failure is non-fatal - workspace is usable but may need manual install
  if (project.runInstall && !opts.skipHooks) {
    try {
      await runCommandAsync("bun", ["install"], worktreePath);
    } catch (err) {
      // Log install failure but don't fail workspace creation
      // The workspace is still functional, user can run install manually
      console.error(
        `[workspace-manager] bun install failed for workspace ${workspaceId}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
};

interface ApplyResult {
  success: boolean;
  applied: string[];
  skipped: string[];
  errors: string[];
}

interface EnvManager {
  applyProfile(
    workspacePath: string,
    projectPath: string,
    files: { sourcePath: string; targetPath: string }[]
  ): ApplyResult;
  clearProfile(workspacePath: string, targetPaths: string[]): void;
}

export interface WorkspaceManager {
  addProject(repoPath: string): Promise<Project>;
  getProject(id: string): Project | null;
  getProjectByPath(path: string): Project | null;
  listProjects(): Project[];
  deleteProject(id: string): Promise<void>;

  createWorkspace(
    projectId: string,
    opts?: CreateWorkspaceOpts
  ): Promise<Workspace>;
  getWorkspace(id: string): Workspace | null;
  openWorkspace(workspaceId: string): Workspace;
  updateWorkspace(
    workspaceId: string,
    updates: { name?: string; status?: "active" | "archived" }
  ): void;
  archiveWorkspace(workspaceId: string): void;
  deleteWorkspace(workspaceId: string): Promise<void>;

  getProjectWorkspaces(projectId: string): Workspace[];
  getRecentWorkspaces(limit?: number): Workspace[];

  syncWorktrees(projectId: string): Promise<void>;

  close(): void;
}

export const createWorkspaceManager = (store: Store): WorkspaceManager => {
  mkdirSync(WORKSPACES_ROOT, { recursive: true });
  const envManager = createEnvManager();

  return {
    async addProject(repoPath) {
      const isRepo = await isGitRepo(repoPath);
      if (!isRepo) {
        throw new Error(`Not a git repository: ${repoPath}`);
      }

      const root = await getRepoRoot(repoPath);
      const existing = store.getProjectByPath(root);
      if (existing) {
        return existing;
      }

      const name = basename(root);
      const defaultBranch = await getDefaultBranch(root);

      return store.createProject(root, name, defaultBranch);
    },

    getProject(id) {
      return store.getProject(id);
    },

    getProjectByPath(path) {
      return store.getProjectByPath(path);
    },

    listProjects() {
      return store.listProjects();
    },

    async deleteProject(id) {
      const workspaces = store.listWorkspaces(id);
      for (const ws of workspaces) {
        await this.deleteWorkspace(ws.id);
      }
      store.deleteProject(id);
    },

    async createWorkspace(projectId, opts = {}) {
      const project = store.getProject(projectId);
      if (!project) {
        throw new Error(`Project not found: ${projectId}`);
      }

      const workspaceId = generateId();
      const branch = opts.branch ?? `forks/${workspaceId}`;
      const name = opts.name ?? branch;

      // Validate branch name to prevent command injection
      if (!isValidGitRef(branch)) {
        throw new Error("Invalid branch name");
      }

      const projectSlug = slugify(project.name);
      const worktreePath = join(WORKSPACES_ROOT, projectSlug, workspaceId);

      // Verify worktree path stays within WORKSPACES_ROOT to prevent path traversal
      // Use separator-aware check to prevent bypass with paths like WORKSPACES_ROOT-evil/
      if (!worktreePath.startsWith(`${WORKSPACES_ROOT}/`)) {
        throw new Error("Invalid workspace path");
      }

      mkdirSync(join(WORKSPACES_ROOT, projectSlug), { recursive: true });

      const needsNewBranch = !(await branchExists(project.path, branch));

      await createWorktree(project.path, {
        path: worktreePath,
        branch,
        createBranch: needsNewBranch,
      });

      const workspace = store.createWorkspace(projectId, {
        name,
        branch,
        path: worktreePath,
        profileId: opts.profileId,
      });

      await runPostCreationHooks(
        worktreePath,
        project.path,
        workspaceId,
        opts,
        project,
        store,
        envManager
      );

      return workspace;
    },

    getWorkspace(id) {
      return store.getWorkspace(id);
    },

    openWorkspace(workspaceId) {
      const workspace = store.getWorkspace(workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`);
      }

      store.updateWorkspace(workspaceId, { lastAccessedAt: Date.now() });
      return { ...workspace, lastAccessedAt: Date.now() };
    },

    updateWorkspace(workspaceId, updates) {
      const workspace = store.getWorkspace(workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`);
      }

      store.updateWorkspace(workspaceId, updates);
    },

    archiveWorkspace(workspaceId) {
      const workspace = store.getWorkspace(workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`);
      }

      store.updateWorkspace(workspaceId, { status: "archived" });
    },

    async deleteWorkspace(workspaceId) {
      const workspace = store.getWorkspace(workspaceId);
      if (!workspace) {
        throw new Error(`Workspace not found: ${workspaceId}`);
      }

      // Verify workspace path is within WORKSPACES_ROOT to prevent path traversal
      // Use separator-aware check to prevent bypass with paths like WORKSPACES_ROOT-evil/
      if (!workspace.path.startsWith(`${WORKSPACES_ROOT}/`)) {
        throw new Error("Invalid workspace path");
      }

      // Clear environment profile symlinks before deleting the worktree
      if (workspace.profileId) {
        const profile = store.getEnvProfile(workspace.profileId);
        if (profile) {
          envManager.clearProfile(
            workspace.path,
            profile.files.map((f) => f.targetPath)
          );
        }
      }

      if (existsSync(workspace.path)) {
        try {
          await removeWorktree(workspace.path, { force: true });
        } catch {
          rmSync(workspace.path, { recursive: true, force: true });
        }
      }

      store.deleteWorkspace(workspaceId);
    },

    getProjectWorkspaces(projectId) {
      return store.listWorkspaces(projectId);
    },

    getRecentWorkspaces(limit = 10) {
      return store.listWorkspaces().slice(0, limit);
    },

    async syncWorktrees(projectId) {
      const project = store.getProject(projectId);
      if (!project) {
        throw new Error(`Project not found: ${projectId}`);
      }

      const dbWorkspaces = store.listWorkspaces(projectId);
      const gitWorktrees = await listWorktrees(project.path);
      const gitPaths = new Set(gitWorktrees.map((w) => w.path));

      for (const ws of dbWorkspaces) {
        if (!(gitPaths.has(ws.path) || existsSync(ws.path))) {
          store.deleteWorkspace(ws.id);
        }
      }
    },

    close() {
      store.close();
    },
  };
};
