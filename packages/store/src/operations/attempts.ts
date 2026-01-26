import { randomUUID } from "node:crypto";
import type { Attempt } from "@forks-sh/protocol";
import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db.js";
import { attempts } from "../schema.js";

export const createAttemptOps = (db: DrizzleDb) => ({
  create: (chatId: string, codexThreadId?: string): Attempt => {
    const id = randomUUID();
    const now = Date.now();
    db.insert(attempts)
      .values({
        id,
        chatId,
        codexThreadId: codexThreadId ?? null,
        status: "running",
        result: null,
        createdAt: now,
      })
      .run();
    return {
      id,
      chatId,
      codexThreadId: codexThreadId ?? null,
      status: "running",
      result: null,
      createdAt: now,
    };
  },

  createBatch: (
    chatId: string,
    count: number,
    codexThreadId?: string
  ): Attempt[] => {
    const now = Date.now();
    const valuesToInsert = Array.from({ length: count }, () => ({
      id: randomUUID(),
      chatId,
      codexThreadId: codexThreadId ?? null,
      status: "running" as const,
      result: null,
      createdAt: now,
    }));
    db.insert(attempts).values(valuesToInsert).run();
    return valuesToInsert.map((v) => ({
      id: v.id,
      chatId: v.chatId,
      codexThreadId: v.codexThreadId,
      status: v.status,
      result: v.result,
      createdAt: v.createdAt,
    }));
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
    updates: Partial<Pick<Attempt, "status" | "result" | "codexThreadId">>
  ): void => {
    if (Object.keys(updates).length === 0) {
      return;
    }
    db.update(attempts).set(updates).where(eq(attempts.id, id)).run();
  },

  delete: (id: string): void => {
    db.delete(attempts).where(eq(attempts.id, id)).run();
  },
});

const mapAttempt = (row: typeof attempts.$inferSelect): Attempt => ({
  id: row.id,
  chatId: row.chatId,
  codexThreadId: row.codexThreadId,
  status: row.status,
  result: row.result,
  createdAt: row.createdAt,
});
