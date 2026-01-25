/** @forks-sh/store – persistence */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CreateWorkspaceOpts,
  Project,
  Workspace,
} from "@forks-sh/protocol";
import Database from "better-sqlite3";
import { SCHEMA } from "./schema.js";

export const STORE_VERSION = "0.0.0";

const DEFAULT_DB_PATH = join(homedir(), ".forks", "data.db");

export interface Store {
  createProject(path: string, name: string, defaultBranch: string): Project;
  getProject(id: string): Project | null;
  getProjectByPath(path: string): Project | null;
  listProjects(): Project[];
  deleteProject(id: string): void;

  createWorkspace(
    projectId: string,
    opts: Required<CreateWorkspaceOpts> & { path: string }
  ): Workspace;
  getWorkspace(id: string): Workspace | null;
  listWorkspaces(projectId?: string): Workspace[];
  updateWorkspace(
    id: string,
    updates: Partial<Pick<Workspace, "name" | "status" | "lastAccessedAt">>
  ): void;
  deleteWorkspace(id: string): void;

  close(): void;
}

interface ProjectRow {
  id: string;
  path: string;
  name: string;
  default_branch: string;
  created_at: number;
}

interface WorkspaceRow {
  id: string;
  project_id: string;
  path: string;
  branch: string;
  name: string;
  status: string;
  created_at: number;
  last_accessed_at: number;
}

const rowToProject = (row: ProjectRow): Project => ({
  id: row.id,
  path: row.path,
  name: row.name,
  defaultBranch: row.default_branch,
  createdAt: row.created_at,
});

const rowToWorkspace = (row: WorkspaceRow): Workspace => ({
  id: row.id,
  projectId: row.project_id,
  path: row.path,
  branch: row.branch,
  name: row.name,
  status: row.status as "active" | "archived",
  createdAt: row.created_at,
  lastAccessedAt: row.last_accessed_at,
});

export const createStore = (dbPath: string = DEFAULT_DB_PATH): Store => {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent read/write performance
  db.pragma("journal_mode = WAL");
  // Enable foreign key constraint enforcement
  db.pragma("foreign_keys = ON");
  // Set busy timeout to 5 seconds to handle concurrent access gracefully
  db.pragma("busy_timeout = 5000");

  db.exec(SCHEMA);

  const stmts = {
    insertProject: db.prepare<[string, string, string, string, number]>(
      "INSERT INTO projects (id, path, name, default_branch, created_at) VALUES (?, ?, ?, ?, ?)"
    ),

    getProject: db.prepare<[string]>("SELECT * FROM projects WHERE id = ?"),

    getProjectByPath: db.prepare<[string]>(
      "SELECT * FROM projects WHERE path = ?"
    ),

    listProjects: db.prepare("SELECT * FROM projects ORDER BY created_at DESC"),

    deleteProject: db.prepare<[string]>("DELETE FROM projects WHERE id = ?"),

    insertWorkspace: db.prepare<
      [string, string, string, string, string, string, number, number]
    >(
      "INSERT INTO workspaces (id, project_id, path, branch, name, status, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ),

    getWorkspace: db.prepare<[string]>("SELECT * FROM workspaces WHERE id = ?"),

    listWorkspaces: db.prepare(
      "SELECT * FROM workspaces ORDER BY last_accessed_at DESC"
    ),

    listWorkspacesByProject: db.prepare<[string]>(
      "SELECT * FROM workspaces WHERE project_id = ? ORDER BY last_accessed_at DESC"
    ),

    deleteWorkspace: db.prepare<[string]>(
      "DELETE FROM workspaces WHERE id = ?"
    ),

    // Pre-cached update statements for workspace fields
    updateWorkspaceName: db.prepare<[string, string]>(
      "UPDATE workspaces SET name = ? WHERE id = ?"
    ),
    updateWorkspaceStatus: db.prepare<[string, string]>(
      "UPDATE workspaces SET status = ? WHERE id = ?"
    ),
    updateWorkspaceLastAccessed: db.prepare<[number, string]>(
      "UPDATE workspaces SET last_accessed_at = ? WHERE id = ?"
    ),
    updateWorkspaceAll: db.prepare<[string, string, number, string]>(
      "UPDATE workspaces SET name = ?, status = ?, last_accessed_at = ? WHERE id = ?"
    ),
  };

  return {
    createProject(path, name, defaultBranch) {
      const id = randomUUID();
      const now = Date.now();
      stmts.insertProject.run(id, path, name, defaultBranch, now);
      return { id, path, name, defaultBranch, createdAt: now };
    },

    getProject(id) {
      const row = stmts.getProject.get(id) as ProjectRow | undefined;
      return row ? rowToProject(row) : null;
    },

    getProjectByPath(path) {
      const row = stmts.getProjectByPath.get(path) as ProjectRow | undefined;
      return row ? rowToProject(row) : null;
    },

    listProjects() {
      return (stmts.listProjects.all() as ProjectRow[]).map(rowToProject);
    },

    deleteProject(id) {
      stmts.deleteProject.run(id);
    },

    createWorkspace(projectId, opts) {
      const id = randomUUID();
      const now = Date.now();
      stmts.insertWorkspace.run(
        id,
        projectId,
        opts.path,
        opts.branch,
        opts.name,
        "active",
        now,
        now
      );
      return {
        id,
        projectId,
        path: opts.path,
        branch: opts.branch,
        name: opts.name,
        status: "active" as const,
        createdAt: now,
        lastAccessedAt: now,
      };
    },

    getWorkspace(id) {
      const row = stmts.getWorkspace.get(id) as WorkspaceRow | undefined;
      return row ? rowToWorkspace(row) : null;
    },

    listWorkspaces(projectId) {
      const rows = projectId
        ? (stmts.listWorkspacesByProject.all(projectId) as WorkspaceRow[])
        : (stmts.listWorkspaces.all() as WorkspaceRow[]);
      return rows.map(rowToWorkspace);
    },

    updateWorkspace(id, updates) {
      const { name, status, lastAccessedAt } = updates;
      const hasName = name !== undefined;
      const hasStatus = status !== undefined;
      const hasLastAccessed = lastAccessedAt !== undefined;

      // Use pre-cached prepared statements for common update patterns
      if (hasName && hasStatus && hasLastAccessed) {
        stmts.updateWorkspaceAll.run(name, status, lastAccessedAt, id);
      } else if (hasName && !hasStatus && !hasLastAccessed) {
        stmts.updateWorkspaceName.run(name, id);
      } else if (!hasName && hasStatus && !hasLastAccessed) {
        stmts.updateWorkspaceStatus.run(status, id);
      } else if (!(hasName || hasStatus) && hasLastAccessed) {
        stmts.updateWorkspaceLastAccessed.run(lastAccessedAt, id);
      } else if (hasName || hasStatus || hasLastAccessed) {
        // Fallback for less common combinations - use transaction for atomicity
        const updateTx = db.transaction(() => {
          if (hasName) {
            stmts.updateWorkspaceName.run(name, id);
          }
          if (hasStatus) {
            stmts.updateWorkspaceStatus.run(status, id);
          }
          if (hasLastAccessed) {
            stmts.updateWorkspaceLastAccessed.run(lastAccessedAt, id);
          }
        });
        updateTx();
      }
    },

    deleteWorkspace(id) {
      stmts.deleteWorkspace.run(id);
    },

    close() {
      db.close();
    },
  };
};

export type {
  CreateWorkspaceOpts,
  Project,
  Workspace,
} from "@forks-sh/protocol";
