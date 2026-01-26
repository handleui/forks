import { randomUUID } from "node:crypto";
import type { Subagent } from "@forks-sh/protocol";
import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db.js";
import { subagents } from "../schema.js";

export const createSubagentOps = (db: DrizzleDb) => ({
  create: (
    parentChatId: string,
    task: string,
    parentAttemptId?: string
  ): Subagent => {
    const id = randomUUID();
    const now = Date.now();
    const row = db
      .insert(subagents)
      .values({
        id,
        parentChatId,
        parentAttemptId: parentAttemptId ?? null,
        task,
        status: "running",
        result: null,
        error: null,
        createdAt: now,
      })
      .returning()
      .get();
    if (!row) {
      throw new Error("Failed to create subagent");
    }
    return mapSubagent(row);
  },

  get: (id: string): Subagent | null => {
    const row = db.select().from(subagents).where(eq(subagents.id, id)).get();
    return row ? mapSubagent(row) : null;
  },

  listByChat: (parentChatId: string, limit = 100, offset = 0): Subagent[] => {
    return db
      .select()
      .from(subagents)
      .where(eq(subagents.parentChatId, parentChatId))
      .orderBy(desc(subagents.createdAt))
      .limit(limit)
      .offset(offset)
      .all()
      .map(mapSubagent);
  },

  listByAttempt: (
    parentAttemptId: string,
    limit = 100,
    offset = 0
  ): Subagent[] => {
    return db
      .select()
      .from(subagents)
      .where(eq(subagents.parentAttemptId, parentAttemptId))
      .orderBy(desc(subagents.createdAt))
      .limit(limit)
      .offset(offset)
      .all()
      .map(mapSubagent);
  },

  update: (
    id: string,
    updates: Partial<Pick<Subagent, "status" | "result" | "error">>
  ): void => {
    if (Object.keys(updates).length === 0) {
      return;
    }
    db.update(subagents).set(updates).where(eq(subagents.id, id)).run();
  },

  delete: (id: string): void => {
    db.delete(subagents).where(eq(subagents.id, id)).run();
  },
});

const mapSubagent = (row: typeof subagents.$inferSelect): Subagent => ({
  id: row.id,
  parentChatId: row.parentChatId,
  parentAttemptId: row.parentAttemptId,
  task: row.task,
  status: row.status,
  result: row.result,
  error: row.error,
  createdAt: row.createdAt,
});
