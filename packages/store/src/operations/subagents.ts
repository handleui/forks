import { randomUUID } from "node:crypto";
import type { Subagent } from "@forks-sh/protocol";
import { and, count, desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db.js";
import { subagents } from "../schema.js";

/** Counts of subagents grouped by status */
export interface SubagentStatusCounts {
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  interrupted: number;
}

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

  listRunningByChat: (parentChatId: string, limit = 100): Subagent[] => {
    // Safety limit to prevent unbounded queries; runner's MAX_CONCURRENT_PER_CHAT is 10
    return db
      .select()
      .from(subagents)
      .where(
        and(
          eq(subagents.parentChatId, parentChatId),
          eq(subagents.status, "running")
        )
      )
      .limit(limit)
      .all()
      .map(mapSubagent);
  },

  /** Count running subagents for a chat (optimized, no object mapping) */
  countRunningByChat: (parentChatId: string): number => {
    const result = db
      .select({ count: count() })
      .from(subagents)
      .where(
        and(
          eq(subagents.parentChatId, parentChatId),
          eq(subagents.status, "running")
        )
      )
      .get();
    return result?.count ?? 0;
  },

  /** Get aggregated status counts for a chat using SQL GROUP BY (single query) */
  getStatusCountsByChat: (parentChatId: string): SubagentStatusCounts => {
    const rows = db
      .select({
        status: subagents.status,
        count: count(),
      })
      .from(subagents)
      .where(eq(subagents.parentChatId, parentChatId))
      .groupBy(subagents.status)
      .all();

    const counts: SubagentStatusCounts = {
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      interrupted: 0,
    };

    for (const row of rows) {
      if (row.status in counts) {
        counts[row.status as keyof SubagentStatusCounts] = row.count;
      }
    }

    return counts;
  },

  update: (
    id: string,
    updates: Partial<
      Pick<Subagent, "status" | "result" | "error" | "codexThreadId">
    >
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
  codexThreadId: row.codexThreadId,
  task: row.task,
  status: row.status,
  result: row.result,
  error: row.error,
  createdAt: row.createdAt,
});
