import { randomUUID } from "node:crypto";
import type { Approval } from "@forks-sh/protocol";
import { and, desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db.js";
import { approvals } from "../schema.js";
import { validateId, validateText } from "../validation.js";

// Approval tokens are 32 bytes of randomBytes encoded as base64url = exactly 43 characters
const APPROVAL_TOKEN_LENGTH = 43;

export interface ApprovalCreateParams {
  threadId: string;
  turnId: string;
  itemId: string;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  data?: unknown;
}

export const createApprovalOps = (db: DrizzleDb) => ({
  create: (
    chatId: string,
    token: string,
    approvalType: "commandExecution" | "fileChange",
    params: ApprovalCreateParams
  ): Approval => {
    validateId(chatId, "chatId");
    validateId(token, "token");
    if (token.length !== APPROVAL_TOKEN_LENGTH) {
      throw new Error(
        `Invalid token: must be exactly ${APPROVAL_TOKEN_LENGTH} chars`
      );
    }
    validateId(params.threadId, "threadId");
    validateId(params.turnId, "turnId");
    validateId(params.itemId, "itemId");
    if (params.command !== undefined && params.command !== null) {
      validateText(params.command, "command");
    }
    if (params.reason !== undefined && params.reason !== null) {
      validateText(params.reason, "reason");
    }

    const id = randomUUID();
    const now = Date.now();
    const dataJson = params.data ? JSON.stringify(params.data) : null;

    const row = db
      .insert(approvals)
      .values({
        id,
        chatId,
        token,
        approvalType,
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        command: params.command ?? null,
        cwd: params.cwd ?? null,
        reason: params.reason ?? null,
        status: "pending",
        data: dataJson,
        createdAt: now,
        respondedAt: null,
      })
      .returning()
      .get();

    return mapApproval(row);
  },

  get: (id: string): Approval | null => {
    const row = db.select().from(approvals).where(eq(approvals.id, id)).get();
    return row ? mapApproval(row) : null;
  },

  getByToken: (token: string): Approval | null => {
    // Early-exit on invalid token length to prevent unnecessary DB queries
    // and provide consistent timing for invalid tokens
    if (!token || token.length !== APPROVAL_TOKEN_LENGTH) {
      return null;
    }
    const row = db
      .select()
      .from(approvals)
      .where(eq(approvals.token, token))
      .get();
    return row ? mapApproval(row) : null;
  },

  list: (
    chatId: string,
    status?: Approval["status"],
    limit = 100,
    offset = 0
  ): Approval[] => {
    const conditions = [eq(approvals.chatId, chatId)];
    if (status) {
      conditions.push(eq(approvals.status, status));
    }

    return db
      .select()
      .from(approvals)
      .where(and(...conditions))
      .orderBy(desc(approvals.createdAt))
      .limit(limit)
      .offset(offset)
      .all()
      .map(mapApproval);
  },

  getPendingByChat: (chatId: string): Approval[] => {
    return db
      .select()
      .from(approvals)
      .where(and(eq(approvals.chatId, chatId), eq(approvals.status, "pending")))
      .orderBy(desc(approvals.createdAt))
      .all()
      .map(mapApproval);
  },

  respond: (id: string, accepted: boolean): Approval | null => {
    validateId(id, "approvalId");

    const now = Date.now();
    const newStatus = accepted ? "accepted" : "declined";

    const updated = db
      .update(approvals)
      .set({
        status: newStatus,
        respondedAt: now,
      })
      .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
      .returning()
      .get();

    return updated ? mapApproval(updated) : null;
  },

  cancel: (id: string): Approval | null => {
    validateId(id, "approvalId");

    const now = Date.now();
    const updated = db
      .update(approvals)
      .set({
        status: "cancelled",
        respondedAt: now,
      })
      .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
      .returning()
      .get();

    return updated ? mapApproval(updated) : null;
  },

  delete: (id: string): void => {
    db.delete(approvals).where(eq(approvals.id, id)).run();
  },
});

/** Safely parse JSON data, returning null on parse errors */
const parseJsonData = (data: string | null): unknown => {
  if (!data) {
    return null;
  }
  try {
    return JSON.parse(data) as unknown;
  } catch {
    // If parsing fails, return the raw string to avoid data loss
    return data;
  }
};

const mapApproval = (row: typeof approvals.$inferSelect): Approval => ({
  id: row.id,
  chatId: row.chatId,
  token: row.token,
  approvalType: row.approvalType,
  threadId: row.threadId,
  turnId: row.turnId,
  itemId: row.itemId,
  command: row.command,
  cwd: row.cwd,
  reason: row.reason,
  status: row.status,
  data: parseJsonData(row.data),
  createdAt: row.createdAt,
  respondedAt: row.respondedAt,
});
