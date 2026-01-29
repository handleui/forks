import { randomUUID } from "node:crypto";
import type { Workspace } from "@forks-sh/protocol";
import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db.js";
import { workspaces } from "../schema.js";

interface CreateWorkspaceInput {
  name: string;
  branch: string;
  path: string;
  profileId?: string;
}

export const createWorkspaceOps = (db: DrizzleDb) => ({
  create: (projectId: string, opts: CreateWorkspaceInput): Workspace => {
    const id = randomUUID();
    const now = Date.now();
    const row = db
      .insert(workspaces)
      .values({
        id,
        projectId,
        profileId: opts.profileId ?? null,
        path: opts.path,
        branch: opts.branch,
        name: opts.name,
        status: "active",
        createdAt: now,
        lastAccessedAt: now,
      })
      .returning()
      .get();
    if (!row) {
      throw new Error("Failed to create workspace");
    }
    return mapWorkspace(row);
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
    updates: Partial<
      Pick<Workspace, "name" | "status" | "lastAccessedAt" | "profileId">
    >
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
  profileId: row.profileId ?? null,
  path: row.path,
  branch: row.branch,
  name: row.name,
  status: row.status,
  createdAt: row.createdAt,
  lastAccessedAt: row.lastAccessedAt,
});
