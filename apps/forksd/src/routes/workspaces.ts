/** Workspace routes */

import type { WorkspaceManager } from "@forks-sh/git/workspace-manager";
import { Hono } from "hono";
import { z } from "zod";

const MAX_JSON_BYTES = 64 * 1024;
const MAX_RECENT_LIMIT = 100;
const DEFAULT_RECENT_LIMIT = 10;

export const createWorkspaceRoutes = (manager: WorkspaceManager) => {
  const app = new Hono();

  app.get("/recent", (c) => {
    const rawLimit = c.req.query("limit");
    const parsed = Number(rawLimit ?? DEFAULT_RECENT_LIMIT);
    // Validate: must be positive integer, capped at MAX_RECENT_LIMIT
    const limit =
      Number.isFinite(parsed) && parsed > 0
        ? Math.min(Math.floor(parsed), MAX_RECENT_LIMIT)
        : DEFAULT_RECENT_LIMIT;
    const workspaces = manager.getRecentWorkspaces(limit);
    return c.json({ ok: true, workspaces });
  });

  app.get("/:id", (c) => {
    const workspace = manager.getWorkspace(c.req.param("id"));
    if (!workspace) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    return c.json({ ok: true, workspace });
  });

  app.post("/:id/open", (c) => {
    try {
      const workspace = manager.openWorkspace(c.req.param("id"));
      return c.json({ ok: true, workspace });
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("not found")) {
        return c.json({ ok: false, error: "not_found" }, 404);
      }
      // Don't leak internal error details
      return c.json({ ok: false, error: "operation_failed" }, 500);
    }
  });

  app.patch("/:id", async (c) => {
    const workspace = manager.getWorkspace(c.req.param("id"));
    if (!workspace) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_JSON_BYTES) {
      return c.json({ ok: false, error: "payload_too_large" }, 413);
    }

    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      name: z.string().min(1).max(128).optional(),
      status: z.enum(["active", "archived"]).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_request" }, 400);
    }

    const updates: { name?: string; status?: "active" | "archived" } = {};
    if (parsed.data.name) {
      updates.name = parsed.data.name;
    }
    if (parsed.data.status) {
      updates.status = parsed.data.status;
    }

    if (Object.keys(updates).length > 0) {
      manager.updateWorkspace(c.req.param("id"), updates);
    }

    const updated = manager.getWorkspace(c.req.param("id"));
    return c.json({ ok: true, workspace: updated });
  });

  app.delete("/:id", async (c) => {
    try {
      await manager.deleteWorkspace(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("not found")) {
        return c.json({ ok: false, error: "not_found" }, 404);
      }
      // Don't leak internal error details
      return c.json({ ok: false, error: "delete_failed" }, 500);
    }
  });

  return app;
};
