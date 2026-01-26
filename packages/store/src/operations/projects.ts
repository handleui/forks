import { randomUUID } from "node:crypto";
import type { Project } from "@forks-sh/protocol";
import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db.js";
import { projects } from "../schema.js";

export const createProjectOps = (db: DrizzleDb) => ({
  create: (path: string, name: string, defaultBranch: string): Project => {
    const id = randomUUID();
    const now = Date.now();
    db.insert(projects)
      .values({ id, path, name, defaultBranch, createdAt: now })
      .run();
    return { id, path, name, defaultBranch, createdAt: now };
  },

  get: (id: string): Project | null => {
    const row = db.select().from(projects).where(eq(projects.id, id)).get();
    return row ?? null;
  },

  getByPath: (path: string): Project | null => {
    const row = db.select().from(projects).where(eq(projects.path, path)).get();
    return row ?? null;
  },

  list: (): Project[] => {
    return db.select().from(projects).orderBy(desc(projects.createdAt)).all();
  },

  delete: (id: string): void => {
    db.delete(projects).where(eq(projects.id, id)).run();
  },
});
