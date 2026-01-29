/** Plan routes */

import type { Store } from "@forks-sh/store";
import { Hono } from "hono";
import { z } from "zod";

const MAX_JSON_BYTES = 64 * 1024;
const MAX_LIMIT = 100;
const MAX_ID_LENGTH = 128;
const VALID_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "cancelled",
] as const;
type PlanStatus = (typeof VALID_STATUSES)[number];

/** ID pattern: alphanumeric, hyphens, underscores only (matches index.ts) */
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** UUID pattern for plan/chat IDs (more strict than general ID) */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isValidId = (id: string): boolean => {
  if (!id || id.length > MAX_ID_LENGTH) {
    return false;
  }
  // Accept both UUID format (from randomUUID) and general alphanumeric IDs
  return UUID_PATTERN.test(id) || ID_PATTERN.test(id);
};

const isValidStatus = (s: string): s is PlanStatus =>
  (VALID_STATUSES as readonly string[]).includes(s);

const isValidPaginationNum = (n: number | undefined): boolean =>
  n === undefined || (Number.isFinite(n) && Number.isInteger(n) && n >= 0);

export const createPlanRoutes = (store: Store) => {
  const app = new Hono();

  // GET /plans?projectId=X&status=pending&limit=N&offset=N - list plans
  app.get("/", (c) => {
    const projectId = c.req.query("projectId");
    const statusParam = c.req.query("status");
    const rawLimit = c.req.query("limit");
    const rawOffset = c.req.query("offset");

    if (!projectId) {
      return c.json({ ok: false, error: "projectId_required" }, 400);
    }
    if (!isValidId(projectId)) {
      return c.json({ ok: false, error: "invalid_projectId" }, 400);
    }
    if (statusParam && !isValidStatus(statusParam)) {
      return c.json({ ok: false, error: "invalid_status" }, 400);
    }

    const status = statusParam as PlanStatus | undefined;
    const limit = rawLimit ? Number(rawLimit) : undefined;
    const offset = rawOffset ? Number(rawOffset) : undefined;

    if (!isValidPaginationNum(limit)) {
      return c.json({ ok: false, error: "invalid_limit" }, 400);
    }
    if (!isValidPaginationNum(offset)) {
      return c.json({ ok: false, error: "invalid_offset" }, 400);
    }

    const cappedLimit =
      limit !== undefined ? Math.min(limit, MAX_LIMIT) : undefined;
    const plans = store.listPlans(projectId, status, cappedLimit, offset);
    return c.json({ ok: true, plans });
  });

  // GET /plans/:id - get single plan
  app.get("/:id", (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      return c.json({ ok: false, error: "invalid_plan_id" }, 400);
    }
    const plan = store.getPlan(id);
    if (!plan) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    return c.json({ ok: true, plan });
  });

  // PATCH /plans/:id - respond to plan (approve/reject)
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      return c.json({ ok: false, error: "invalid_plan_id" }, 400);
    }

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (!Number.isFinite(contentLength) || contentLength > MAX_JSON_BYTES) {
      return c.json({ ok: false, error: "payload_too_large" }, 413);
    }
    const contentType = c.req.header("content-type");
    if (!contentType?.includes("application/json")) {
      return c.json({ ok: false, error: "invalid_content_type" }, 415);
    }

    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      approved: z.boolean(),
      feedback: z.string().max(10_000).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_request" }, 400);
    }

    // respondToPlan is atomic - only updates if status is "pending"
    // This prevents race conditions with concurrent approval requests
    const plan = store.respondToPlan(
      id,
      parsed.data.approved,
      parsed.data.feedback
    );
    if (!plan) {
      return c.json({ ok: false, error: "not_found_or_not_pending" }, 404);
    }
    return c.json({ ok: true, plan });
  });

  // DELETE /plans/:id - delete plan
  // Note: deletePlan is idempotent - deleting non-existent plan is a no-op
  // We skip the existence check to avoid an extra database query
  app.delete("/:id", (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      return c.json({ ok: false, error: "invalid_plan_id" }, 400);
    }
    store.deletePlan(id);
    return c.json({ ok: true });
  });

  return app;
};

export const createChatModeRoutes = (store: Store) => {
  const app = new Hono();

  // PATCH /chats/:id/mode - update chat collaboration mode
  app.patch("/:id/mode", async (c) => {
    const chatId = c.req.param("id");
    if (!isValidId(chatId)) {
      return c.json({ ok: false, error: "invalid_chat_id" }, 400);
    }

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (!Number.isFinite(contentLength) || contentLength > MAX_JSON_BYTES) {
      return c.json({ ok: false, error: "payload_too_large" }, 413);
    }
    const contentType = c.req.header("content-type");
    if (!contentType?.includes("application/json")) {
      return c.json({ ok: false, error: "invalid_content_type" }, 415);
    }

    // Validate chat exists before parsing body (fail fast)
    const existingChat = store.getChat(chatId);
    if (!existingChat) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      mode: z.enum(["plan", "execute"]).nullable(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_request" }, 400);
    }

    store.updateChat(chatId, { collaborationMode: parsed.data.mode });
    const updated = store.getChat(chatId);
    return c.json({ ok: true, chat: updated });
  });

  return app;
};
