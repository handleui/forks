import { randomUUID } from "node:crypto";
import type { Plan } from "@forks-sh/protocol";
import { and, desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db.js";
import { plans } from "../schema.js";

/** Input validation constants - must match tools.ts */
const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 10_000;

/** Validate ID format and length */
const validateId = (id: string, fieldName: string): void => {
  if (!id || id.length > MAX_ID_LENGTH) {
    throw new Error(`Invalid ${fieldName}: must be 1-${MAX_ID_LENGTH} chars`);
  }
};

/** Validate text content length */
const validateText = (text: string, fieldName: string): void => {
  if (!text || text.length > MAX_TEXT_LENGTH) {
    throw new Error(`Invalid ${fieldName}: must be 1-${MAX_TEXT_LENGTH} chars`);
  }
};

export const createPlanOps = (db: DrizzleDb) => ({
  propose: (
    projectId: string,
    chatId: string,
    agentId: string,
    title: string,
    content: string
  ): Plan => {
    // Input validation at store layer (defense in depth)
    validateId(projectId, "projectId");
    validateId(chatId, "chatId");
    validateId(agentId, "agentId");
    validateText(title, "title");
    validateText(content, "content");

    // Check if a pending plan already exists for this chat
    const existing = db
      .select()
      .from(plans)
      .where(and(eq(plans.chatId, chatId), eq(plans.status, "pending")))
      .get();
    if (existing) {
      throw new Error(`Pending plan already exists for chat ${chatId}`);
    }

    const id = randomUUID();
    const now = Date.now();
    const row = db
      .insert(plans)
      .values({
        id,
        projectId,
        chatId,
        agentId,
        title,
        content,
        status: "pending",
        feedback: null,
        createdAt: now,
        respondedAt: null,
      })
      .returning()
      .get();
    return mapPlan(row);
  },

  get: (id: string): Plan | null => {
    const row = db.select().from(plans).where(eq(plans.id, id)).get();
    return row ? mapPlan(row) : null;
  },

  getPendingByChat: (chatId: string): Plan | null => {
    const row = db
      .select()
      .from(plans)
      .where(and(eq(plans.chatId, chatId), eq(plans.status, "pending")))
      .get();
    return row ? mapPlan(row) : null;
  },

  respond: (id: string, approved: boolean, feedback?: string): Plan | null => {
    validateId(id, "planId");
    if (feedback !== undefined) {
      validateText(feedback, "feedback");
    }

    const now = Date.now();
    const updated = db
      .update(plans)
      .set({
        status: approved ? "approved" : "rejected",
        feedback: feedback ?? null,
        respondedAt: now,
      })
      .where(and(eq(plans.id, id), eq(plans.status, "pending")))
      .returning()
      .get();
    return updated ? mapPlan(updated) : null;
  },

  list: (
    projectId: string,
    status?: Plan["status"],
    limit = 100,
    offset = 0
  ): Plan[] => {
    const conditions = [eq(plans.projectId, projectId)];
    if (status) {
      conditions.push(eq(plans.status, status));
    }
    return db
      .select()
      .from(plans)
      .where(and(...conditions))
      .orderBy(desc(plans.createdAt))
      .limit(limit)
      .offset(offset)
      .all()
      .map(mapPlan);
  },

  cancel: (id: string): Plan | null => {
    validateId(id, "planId");
    const now = Date.now();
    const updated = db
      .update(plans)
      .set({
        status: "cancelled",
        respondedAt: now,
      })
      .where(and(eq(plans.id, id), eq(plans.status, "pending")))
      .returning()
      .get();
    return updated ? mapPlan(updated) : null;
  },

  delete: (id: string): void => {
    db.delete(plans).where(eq(plans.id, id)).run();
  },
});

const mapPlan = (row: typeof plans.$inferSelect): Plan => ({
  id: row.id,
  projectId: row.projectId,
  chatId: row.chatId,
  agentId: row.agentId,
  title: row.title,
  content: row.content,
  status: row.status,
  feedback: row.feedback,
  createdAt: row.createdAt,
  respondedAt: row.respondedAt,
});
