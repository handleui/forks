import { randomUUID } from "node:crypto";
import { type Task, VALIDATION } from "@forks-sh/protocol";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { DrizzleDb } from "../db.js";
import { tasks } from "../schema.js";

/** Validate ID format and length */
const validateId = (id: string, fieldName: string): void => {
  if (!id || id.length > VALIDATION.MAX_ID_LENGTH) {
    throw new Error(
      `Invalid ${fieldName}: must be 1-${VALIDATION.MAX_ID_LENGTH} chars`
    );
  }
  if (!VALIDATION.ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${fieldName}: must match pattern [a-zA-Z0-9_-]`);
  }
};

/** Validate text content length */
const validateText = (text: string, fieldName: string): void => {
  if (!text || text.length > VALIDATION.MAX_TEXT_LENGTH) {
    throw new Error(
      `Invalid ${fieldName}: must be 1-${VALIDATION.MAX_TEXT_LENGTH} chars`
    );
  }
};

export const createTaskOps = (db: DrizzleDb) => ({
  create: (chatId: string, description: string, planId?: string): Task => {
    // Input validation at store layer (defense in depth)
    validateId(chatId, "chatId");
    validateText(description, "description");
    if (planId !== undefined) {
      validateId(planId, "planId");
    }

    const id = randomUUID();
    const now = Date.now();
    const row = db
      .insert(tasks)
      .values({
        id,
        chatId,
        planId: planId ?? null,
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

  listByPlan: (planId: string, limit = 100, offset = 0): Task[] => {
    return db
      .select()
      .from(tasks)
      .where(eq(tasks.planId, planId))
      .orderBy(desc(tasks.createdAt))
      .limit(limit)
      .offset(offset)
      .all()
      .map(mapTask);
  },

  countByPlan: (planId: string): number => {
    const result = db
      .select({ count: count() })
      .from(tasks)
      .where(eq(tasks.planId, planId))
      .get();
    return result?.count ?? 0;
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

  complete: (id: string, result: string, claimedBy?: string): Task | null => {
    const conditions = [eq(tasks.id, id), eq(tasks.status, "claimed")];
    if (claimedBy) {
      conditions.push(eq(tasks.claimedBy, claimedBy));
    }
    const updated = db
      .update(tasks)
      .set({ status: "completed", result, updatedAt: Date.now() })
      .where(and(...conditions))
      .returning()
      .get();
    return updated ? mapTask(updated) : null;
  },

  fail: (id: string, result?: string, claimedBy?: string): Task | null => {
    const conditions = [eq(tasks.id, id), eq(tasks.status, "claimed")];
    if (claimedBy) {
      conditions.push(eq(tasks.claimedBy, claimedBy));
    }
    const updated = db
      .update(tasks)
      .set({ status: "failed", result: result ?? null, updatedAt: Date.now() })
      .where(and(...conditions))
      .returning()
      .get();
    return updated ? mapTask(updated) : null;
  },

  // HACK: result field has dual purpose - stores completion result OR unclaim reason.
  // status='pending' with non-null result indicates task was unclaimed with context.
  unclaim: (id: string, reason?: string, claimedBy?: string): Task | null => {
    const conditions = [eq(tasks.id, id), eq(tasks.status, "claimed")];
    if (claimedBy) {
      conditions.push(eq(tasks.claimedBy, claimedBy));
    }
    const updated = db
      .update(tasks)
      .set({
        status: "pending",
        claimedBy: null,
        result: reason ?? null,
        updatedAt: Date.now(),
      })
      .where(and(...conditions))
      .returning()
      .get();
    return updated ? mapTask(updated) : null;
  },

  update: (
    id: string,
    updates: Partial<Pick<Task, "description" | "status" | "result">>
  ): Task | null => {
    if (Object.keys(updates).length === 0) {
      // No updates - fetch current state
      const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
      return row ? mapTask(row) : null;
    }
    const updated = db
      .update(tasks)
      .set({ ...updates, updatedAt: Date.now() })
      .where(eq(tasks.id, id))
      .returning()
      .get();
    return updated ? mapTask(updated) : null;
  },

  delete: (id: string): void => {
    db.delete(tasks).where(eq(tasks.id, id)).run();
  },
});

const mapTask = (row: typeof tasks.$inferSelect): Task => ({
  id: row.id,
  chatId: row.chatId,
  planId: row.planId,
  description: row.description,
  claimedBy: row.claimedBy,
  status: row.status,
  result: row.result,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
