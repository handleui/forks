import { randomUUID } from "node:crypto";
import type { CreateWorkspaceOpts, Workspace } from "@forks-sh/protocol";
import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db.js";
import { workspaces } from "../schema.js";

export const createWorkspaceOps = (db: DrizzleDb) => ({
  create: (
    projectId: string,
    opts: Required<CreateWorkspaceOpts> & { path: string }
  ): Workspace => {
    const id = randomUUID();
    const now = Date.now();
    db.insert(workspaces)
      .values({
        id,
        projectId,
        path: opts.path,
        branch: opts.branch,
        name: opts.name,
        status: "active",
        createdAt: now,
        lastAccessedAt: now,
      })
      .run();
    return {
      id,
      projectId,
      path: opts.path,
      branch: opts.branch,
      name: opts.name,
      status: "active",
      createdAt: now,
      lastAccessedAt: now,
    };
  },

  get: (id: string): Workspace | null => {
    const row = db.select().from(workspaces).where(eq(workspaces.id, id)).get();
    return row ? mapWorkspace(row) : null;
  },

  list: (projectId?: string, limit?: number): Workspace[] => {
    let query = projectId
      ? db
          .select()
          .from(workspaces)
          .where(eq(workspaces.projectId, projectId))
          .orderBy(desc(workspaces.lastAccessedAt))
      : db.select().from(workspaces).orderBy(desc(workspaces.lastAccessedAt));
    if (limit !== undefined) {
      query = query.limit(limit) as typeof query;
    }
    return query.all().map(mapWorkspace);
  },

  update: (
    id: string,
    updates: Partial<Pick<Workspace, "name" | "status" | "lastAccessedAt">>
  ): void => {
    if (Object.keys(updates).length === 0) {
      return;
    }
    db.update(workspaces).set(updates).where(eq(workspaces.id, id)).run();
  },

  delete: (id: string): void => {
    db.delete(workspaces).where(eq(workspaces.id, id)).run();
  },
});

const mapWorkspace = (row: typeof workspaces.$inferSelect): Workspace => ({
  id: row.id,
  projectId: row.projectId,
  path: row.path,
  branch: row.branch,
  name: row.name,
  status: row.status,
  createdAt: row.createdAt,
  lastAccessedAt: row.lastAccessedAt,
});
