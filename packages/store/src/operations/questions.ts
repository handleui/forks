import { randomUUID } from "node:crypto";
import type { Question } from "@forks-sh/protocol";
import { and, desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db.js";
import { questions } from "../schema.js";
import { validateId, validateText } from "../validation.js";

export const createQuestionOps = (db: DrizzleDb) => ({
  ask: (chatId: string, agentId: string, content: string): Question => {
    // Input validation at store layer (defense in depth)
    validateId(chatId, "chatId");
    validateId(agentId, "agentId");
    validateText(content, "content");

    // Check if a pending question already exists for this chat
    const existing = db
      .select()
      .from(questions)
      .where(and(eq(questions.chatId, chatId), eq(questions.status, "pending")))
      .get();
    if (existing) {
      throw new Error(`Pending question already exists for chat ${chatId}`);
    }

    const id = randomUUID();
    const now = Date.now();
    const row = db
      .insert(questions)
      .values({
        id,
        chatId,
        agentId,
        content,
        status: "pending",
        answer: null,
        createdAt: now,
        respondedAt: null,
      })
      .returning()
      .get();
    return mapQuestion(row);
  },

  get: (id: string): Question | null => {
    const row = db.select().from(questions).where(eq(questions.id, id)).get();
    return row ? mapQuestion(row) : null;
  },

  getPendingByChat: (chatId: string): Question | null => {
    const row = db
      .select()
      .from(questions)
      .where(and(eq(questions.chatId, chatId), eq(questions.status, "pending")))
      .get();
    return row ? mapQuestion(row) : null;
  },

  answer: (id: string, answer: string): Question | null => {
    validateId(id, "questionId");
    validateText(answer, "answer");

    const now = Date.now();
    const updated = db
      .update(questions)
      .set({
        status: "answered",
        answer,
        respondedAt: now,
      })
      .where(and(eq(questions.id, id), eq(questions.status, "pending")))
      .returning()
      .get();
    return updated ? mapQuestion(updated) : null;
  },

  list: (chatId: string, limit = 100, offset = 0): Question[] => {
    return db
      .select()
      .from(questions)
      .where(eq(questions.chatId, chatId))
      .orderBy(desc(questions.createdAt))
      .limit(limit)
      .offset(offset)
      .all()
      .map(mapQuestion);
  },

  cancel: (id: string): Question | null => {
    validateId(id, "questionId");
    const now = Date.now();
    const updated = db
      .update(questions)
      .set({
        status: "cancelled",
        respondedAt: now,
      })
      .where(and(eq(questions.id, id), eq(questions.status, "pending")))
      .returning()
      .get();
    return updated ? mapQuestion(updated) : null;
  },

  delete: (id: string): void => {
    db.delete(questions).where(eq(questions.id, id)).run();
  },
});

const mapQuestion = (row: typeof questions.$inferSelect): Question => ({
  id: row.id,
  chatId: row.chatId,
  agentId: row.agentId,
  content: row.content,
  status: row.status,
  answer: row.answer,
  createdAt: row.createdAt,
  respondedAt: row.respondedAt,
});
