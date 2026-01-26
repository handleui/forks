import { randomUUID } from "node:crypto";
import type { Task } from "@forks-sh/protocol";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DrizzleDb } from "../db.js";
import { tasks } from "../schema.js";

export const createTaskOps = (db: DrizzleDb) => ({
  create: (chatId: string, description: string): Task => {
    const id = randomUUID();
    const now = Date.now();
    const row = db
      .insert(tasks)
      .values({
        id,
        chatId,
        description,
        claimedBy: null,
        status: "pending",
        result: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return mapTask(row);
  },

  get: (id: string): Task | null => {
    const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row ? mapTask(row) : null;
  },

  list: (chatId: string, limit = 100, offset = 0): Task[] => {
    return db
      .select()
      .from(tasks)
      .where(eq(tasks.chatId, chatId))
      .orderBy(desc(tasks.createdAt))
      .limit(limit)
      .offset(offset)
      .all()
      .map(mapTask);
  },

  claim: (id: string, claimedBy: string): Task | null => {
    const now = Date.now();
    // Atomic conditional update with returning - eliminates extra SELECT
    const updated = db
      .update(tasks)
      .set({ claimedBy, status: "claimed", updatedAt: now })
      .where(
        and(
          eq(tasks.id, id),
          eq(tasks.status, "pending"),
          isNull(tasks.claimedBy)
        )
      )
      .returning()
      .get();

    return updated ? mapTask(updated) : null;
  },

  complete: (id: string, result: string, claimedBy?: string): boolean => {
    // Only allow completing tasks that are in "claimed" status
    // Optionally verify the claimer matches (if claimedBy is provided)
    const conditions = [eq(tasks.id, id), eq(tasks.status, "claimed")];
    if (claimedBy) {
      conditions.push(eq(tasks.claimedBy, claimedBy));
    }
    const updateResult = db
      .update(tasks)
      .set({ status: "completed", result, updatedAt: Date.now() })
      .where(and(...conditions))
      .run();
    return updateResult.changes > 0;
  },

  fail: (id: string, result?: string, claimedBy?: string): boolean => {
    // Only allow failing tasks that are in "claimed" status
    // Optionally verify the claimer matches (if claimedBy is provided)
    const conditions = [eq(tasks.id, id), eq(tasks.status, "claimed")];
    if (claimedBy) {
      conditions.push(eq(tasks.claimedBy, claimedBy));
    }
    const updateResult = db
      .update(tasks)
      .set({ status: "failed", result: result ?? null, updatedAt: Date.now() })
      .where(and(...conditions))
      .run();
    return updateResult.changes > 0;
  },

  update: (
    id: string,
    updates: Partial<Pick<Task, "description" | "status" | "result">>
  ): void => {
    if (Object.keys(updates).length === 0) {
      return;
    }
    db.update(tasks)
      .set({ ...updates, updatedAt: Date.now() })
      .where(eq(tasks.id, id))
      .run();
  },

  delete: (id: string): void => {
    db.delete(tasks).where(eq(tasks.id, id)).run();
  },
});

const mapTask = (row: typeof tasks.$inferSelect): Task => ({
  id: row.id,
  chatId: row.chatId,
  description: row.description,
  claimedBy: row.claimedBy,
  status: row.status,
  result: row.result,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
