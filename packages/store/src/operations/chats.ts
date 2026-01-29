import { randomUUID } from "node:crypto";
import type { Chat } from "@forks-sh/protocol";
import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db.js";
import { chats } from "../schema.js";
import { validateId } from "../validation.js";

export const createChatOps = (db: DrizzleDb) => ({
  create: (workspaceId: string, codexThreadId?: string): Chat => {
    // Input validation at store layer (defense-in-depth)
    validateId(workspaceId, "workspaceId");
    if (codexThreadId !== undefined) {
      validateId(codexThreadId, "codexThreadId");
    }

    const id = randomUUID();
    const now = Date.now();
    const row = db
      .insert(chats)
      .values({
        id,
        workspaceId,
        codexThreadId: codexThreadId ?? null,
        title: null,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    if (!row) {
      throw new Error("Failed to create chat");
    }
    return mapChat(row);
  },

  get: (id: string): Chat | null => {
    const row = db.select().from(chats).where(eq(chats.id, id)).get();
    return row ? mapChat(row) : null;
  },

  list: (workspaceId: string, limit = 100, offset = 0): Chat[] => {
    return db
      .select()
      .from(chats)
      .where(eq(chats.workspaceId, workspaceId))
      .orderBy(desc(chats.updatedAt))
      .limit(limit)
      .offset(offset)
      .all()
      .map(mapChat);
  },

  update: (
    id: string,
    updates: Partial<
      Pick<Chat, "title" | "status" | "codexThreadId" | "collaborationMode">
    >
  ): void => {
    if (Object.keys(updates).length === 0) {
      return;
    }
    db.update(chats)
      .set({ ...updates, updatedAt: Date.now() })
      .where(eq(chats.id, id))
      .run();
  },

  delete: (id: string): void => {
    db.delete(chats).where(eq(chats.id, id)).run();
  },
});

const mapChat = (row: typeof chats.$inferSelect): Chat => ({
  id: row.id,
  workspaceId: row.workspaceId,
  codexThreadId: row.codexThreadId,
  title: row.title,
  status: row.status,
  collaborationMode: row.collaborationMode,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});
