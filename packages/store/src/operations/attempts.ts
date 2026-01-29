import { randomUUID } from "node:crypto";
import type { Attempt } from "@forks-sh/protocol";
import { and, desc, eq, lt, ne } from "drizzle-orm";
import type { DrizzleDb } from "../db.js";
import { attempts } from "../schema.js";
import { validateId, validateText } from "../validation.js";

// Maximum batch size for internal use. The MCP layer enforces VALIDATION.MAX_ATTEMPT_COUNT (10)
// for external requests, but internal operations may use higher limits for administrative tasks.
const MAX_BATCH_SIZE = 100;

export const createAttemptOps = (db: DrizzleDb) => ({
  /**
   * Creates a single attempt for an interactive session.
   * Does not accept a task parameter as interactive sessions have dynamic user prompts.
   */
  create: (chatId: string, codexThreadId?: string): Attempt => {
    // Input validation at store layer (defense-in-depth)
    validateId(chatId, "chatId");
    if (codexThreadId !== undefined) {
      validateId(codexThreadId, "codexThreadId");
    }

    const id = randomUUID();
    const now = Date.now();
    const row = db
      .insert(attempts)
      .values({
        id,
        chatId,
        codexThreadId: codexThreadId ?? null,
        worktreePath: null,
        branch: null,
        status: "running",
        result: null,
        error: null,
        createdAt: now,
      })
      .returning()
      .get();
    if (!row) {
      throw new Error("Failed to create attempt");
    }
    return mapAttempt(row);
  },

  /**
   * Creates multiple attempts for poly-iteration (parallel execution of the same task).
   * Accepts a task parameter since all attempts in a batch execute the same predefined task.
   */
  createBatch: (
    chatId: string,
    count: number,
    task: string,
    codexThreadId?: string
  ): Attempt[] => {
    // Input validation at store layer (defense-in-depth)
    validateId(chatId, "chatId");
    validateText(task, "task");
    // Validate codexThreadId if provided (defense-in-depth for internal IDs)
    if (codexThreadId !== undefined) {
      validateId(codexThreadId, "codexThreadId");
    }

    // Limit batch size to prevent DoS
    const safeCount = Math.min(Math.max(0, count), MAX_BATCH_SIZE);
    if (safeCount === 0) {
      return [];
    }

    const now = Date.now();
    const valuesToInsert = Array.from({ length: safeCount }, () => ({
      id: randomUUID(),
      chatId,
      codexThreadId: codexThreadId ?? null,
      worktreePath: null,
      branch: null,
      task,
      status: "pending" as const,
      result: null,
      error: null,
      createdAt: now,
    }));
    const rows = db.transaction((tx) =>
      tx.insert(attempts).values(valuesToInsert).returning().all()
    );
    return rows.map(mapAttempt);
  },

  get: (id: string): Attempt | null => {
    const row = db.select().from(attempts).where(eq(attempts.id, id)).get();
    return row ? mapAttempt(row) : null;
  },

  list: (chatId: string, limit = 100, offset = 0): Attempt[] => {
    return db
      .select()
      .from(attempts)
      .where(eq(attempts.chatId, chatId))
      .orderBy(desc(attempts.createdAt))
      .limit(limit)
      .offset(offset)
      .all()
      .map(mapAttempt);
  },

  update: (
    id: string,
    updates: Partial<
      Pick<
        Attempt,
        | "status"
        | "result"
        | "error"
        | "codexThreadId"
        | "worktreePath"
        | "branch"
      >
    >
  ): void => {
    if (Object.keys(updates).length === 0) {
      return;
    }
    db.update(attempts).set(updates).where(eq(attempts.id, id)).run();
  },

  pick: (id: string): Attempt | null => {
    const updated = db
      .update(attempts)
      .set({ status: "picked" })
      .where(and(eq(attempts.id, id), eq(attempts.status, "completed")))
      .returning()
      .get();

    return updated ? mapAttempt(updated) : null;
  },

  delete: (id: string): void => {
    db.delete(attempts).where(eq(attempts.id, id)).run();
  },

  pruneOldAttempts: (olderThan: Date): number => {
    // Only prune discarded attempts - preserve picked (winners) and completed (pending pick)
    const deleted = db
      .delete(attempts)
      .where(
        and(
          lt(attempts.createdAt, olderThan.getTime()),
          eq(attempts.status, "discarded")
        )
      )
      .returning({ id: attempts.id })
      .all();
    return deleted.length;
  },

  discardOthers: (chatId: string, pickedAttemptId: string): void => {
    db.update(attempts)
      .set({ status: "discarded" })
      .where(and(eq(attempts.chatId, chatId), ne(attempts.id, pickedAttemptId)))
      .run();
  },
});

const mapAttempt = (row: typeof attempts.$inferSelect): Attempt => ({
  id: row.id,
  chatId: row.chatId,
  codexThreadId: row.codexThreadId,
  worktreePath: row.worktreePath,
  branch: row.branch,
  task: row.task,
  status: row.status,
  result: row.result,
  error: row.error,
  createdAt: row.createdAt,
});
