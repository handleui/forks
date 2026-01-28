/** Graphite stack routes */

import type {
  AbortOpts,
  ContinueOpts,
  CreateOpts,
  ModifyOpts,
  SubmitOpts,
  SubmitResult,
  SyncOpts,
} from "@forks-sh/git/graphite";
import {
  checkGtVersion,
  gtAbort,
  gtBottom,
  gtCheckout,
  gtContinue,
  gtCreate,
  gtDown,
  gtInit,
  gtLog,
  gtModify,
  gtSubmit,
  gtSync,
  gtTop,
  gtUp,
  isGraphiteRepo,
} from "@forks-sh/git/graphite";
import type { WorkspaceManager } from "@forks-sh/git/workspace-manager";
import type { StoreEventEmitter } from "@forks-sh/store";
import { Hono } from "hono";
import { z } from "zod";

const MAX_JSON_BYTES = 64 * 1024;

/** Strict branch validation: alphanumeric, hyphens, underscores, slashes, and dots.
 *  Cannot start with dash or dot (prevents git option injection and git ref issues)
 */
const BRANCH_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/;

type GraphiteErrorCode =
  | "graphite_not_installed"
  | "graphite_not_initialized"
  | "graphite_version_unsupported"
  | "graphite_conflict"
  | "graphite_command_failed"
  | "not_found"
  | "invalid_request"
  | "invalid_json"
  | "payload_too_large";

/**
 * Parse Graphite CLI errors into standardized error codes.
 * Intentionally does not expose raw error messages to avoid leaking internal details.
 */
const parseGtError = (err: unknown): GraphiteErrorCode => {
  if (!(err instanceof Error)) {
    return "graphite_command_failed";
  }

  const message = err.message;

  if (
    message.includes("ENOENT") ||
    message.includes("not found") ||
    message.includes("Install:")
  ) {
    return "graphite_not_installed";
  }

  if (
    message.includes("not initialized") ||
    message.includes("gt init") ||
    message.includes("graphite_repo_config")
  ) {
    return "graphite_not_initialized";
  }

  if (
    message.includes("conflict") ||
    message.includes("CONFLICT") ||
    message.includes("rebase")
  ) {
    return "graphite_conflict";
  }

  return "graphite_command_failed";
};

/**
 * Parse JSON body with proper error handling for malformed JSON.
 * Per Hono best practices, we catch SyntaxError to return a proper 400 response
 * instead of silently returning an empty object.
 */
const parseJsonBody = async <T>(req: {
  json: () => Promise<T>;
}): Promise<{ ok: true; data: T } | { ok: false; error: "invalid_json" }> => {
  try {
    const data = await req.json();
    return { ok: true, data };
  } catch (err) {
    if (err instanceof SyntaxError) {
      return { ok: false, error: "invalid_json" };
    }
    // For non-SyntaxError (unlikely), return empty object to maintain backward compat
    return { ok: true, data: {} as T };
  }
};

/** Format Zod validation errors into a readable message (matches MCP tools pattern) */
const formatZodErrors = (error: z.ZodError): string =>
  error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

const emitStackChanged = (
  emitter: StoreEventEmitter,
  projectId: string
): void => {
  emitter.emit("agent", {
    type: "graphite",
    event: "stack_changed",
    projectId,
  });
};

const emitConflict = (
  emitter: StoreEventEmitter,
  projectId: string,
  error: string
): void => {
  emitter.emit("agent", {
    type: "graphite",
    event: "conflict",
    projectId,
    error,
  });
};

const emitPrSubmitted = (
  emitter: StoreEventEmitter,
  projectId: string,
  results: SubmitResult[]
): void => {
  emitter.emit("agent", {
    type: "graphite",
    event: "pr_submitted",
    projectId,
    results,
  });
};

export const createGraphiteRoutes = (
  manager: WorkspaceManager,
  storeEmitter: StoreEventEmitter
) => {
  const app = new Hono();

  const getProjectPath = (
    projectId: string
  ): { ok: true; path: string } | { ok: false } => {
    const project = manager.getProject(projectId);
    if (!project) {
      return { ok: false };
    }
    return { ok: true, path: project.path };
  };

  app.get("/:id/stack", async (c) => {
    const result = getProjectPath(c.req.param("id"));
    if (!result.ok) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    try {
      const stackInfo = await gtLog(result.path);
      return c.json({ ok: true, stack: stackInfo });
    } catch (err) {
      const code = parseGtError(err);
      return c.json({ ok: false, error: code }, 500);
    }
  });

  app.get("/:id/stack/status", async (c) => {
    const result = getProjectPath(c.req.param("id"));
    if (!result.ok) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    try {
      const [versionCheck, isInitialized] = await Promise.all([
        checkGtVersion(),
        isGraphiteRepo(result.path),
      ]);

      return c.json({
        ok: true,
        status: {
          installed: true,
          version: versionCheck.version,
          supported: versionCheck.supported,
          initialized: isInitialized,
        },
      });
    } catch (err) {
      const code = parseGtError(err);
      if (code === "graphite_not_installed") {
        return c.json({
          ok: true,
          status: {
            installed: false,
            version: null,
            supported: false,
            initialized: false,
          },
        });
      }
      return c.json({ ok: false, error: code }, 500);
    }
  });

  app.post("/:id/stack/init", async (c) => {
    const result = getProjectPath(c.req.param("id"));
    if (!result.ok) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_JSON_BYTES) {
      return c.json({ ok: false, error: "payload_too_large" }, 413);
    }

    const bodyResult = await parseJsonBody<unknown>(c.req);
    if (!bodyResult.ok) {
      return c.json({ ok: false, error: bodyResult.error }, 400);
    }

    const schema = z.object({
      trunk: z
        .string()
        .min(1)
        .max(256)
        .regex(BRANCH_REGEX, "Invalid trunk branch name")
        .optional(),
    });
    const parsed = schema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: "invalid_request",
          message: formatZodErrors(parsed.error),
        },
        400
      );
    }

    try {
      await gtInit(result.path, parsed.data.trunk);
      emitStackChanged(storeEmitter, c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      const code = parseGtError(err);
      return c.json({ ok: false, error: code }, 500);
    }
  });

  app.post("/:id/stack/submit", async (c) => {
    const result = getProjectPath(c.req.param("id"));
    if (!result.ok) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_JSON_BYTES) {
      return c.json({ ok: false, error: "payload_too_large" }, 413);
    }

    const bodyResult = await parseJsonBody<unknown>(c.req);
    if (!bodyResult.ok) {
      return c.json({ ok: false, error: bodyResult.error }, 400);
    }

    const schema = z.object({
      draft: z.boolean().optional(),
      stack: z.boolean().optional(),
      publish: z.boolean().optional(),
      mergeWhenReady: z.boolean().optional(),
      updateOnly: z.boolean().optional(),
      noEdit: z.boolean().optional(),
    });
    const parsed = schema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: "invalid_request",
          message: formatZodErrors(parsed.error),
        },
        400
      );
    }

    try {
      const opts: SubmitOpts = parsed.data;
      const results = await gtSubmit(result.path, opts);
      emitPrSubmitted(storeEmitter, c.req.param("id"), results);
      emitStackChanged(storeEmitter, c.req.param("id"));
      return c.json({ ok: true, results });
    } catch (err) {
      const code = parseGtError(err);
      if (code === "graphite_conflict") {
        emitConflict(
          storeEmitter,
          c.req.param("id"),
          "Merge conflict detected"
        );
      }
      return c.json({ ok: false, error: code }, 500);
    }
  });

  app.post("/:id/stack/sync", async (c) => {
    const result = getProjectPath(c.req.param("id"));
    if (!result.ok) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_JSON_BYTES) {
      return c.json({ ok: false, error: "payload_too_large" }, 413);
    }

    const bodyResult = await parseJsonBody<unknown>(c.req);
    if (!bodyResult.ok) {
      return c.json({ ok: false, error: bodyResult.error }, 400);
    }

    const schema = z.object({
      force: z.boolean().optional(),
      all: z.boolean().optional(),
      restack: z.boolean().optional(),
    });
    const parsed = schema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: "invalid_request",
          message: formatZodErrors(parsed.error),
        },
        400
      );
    }

    try {
      const opts: SyncOpts = parsed.data;
      await gtSync(result.path, opts);
      emitStackChanged(storeEmitter, c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      const code = parseGtError(err);
      if (code === "graphite_conflict") {
        emitConflict(
          storeEmitter,
          c.req.param("id"),
          "Merge conflict detected"
        );
      }
      return c.json({ ok: false, error: code }, 500);
    }
  });

  app.post("/:id/stack/create", async (c) => {
    const result = getProjectPath(c.req.param("id"));
    if (!result.ok) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_JSON_BYTES) {
      return c.json({ ok: false, error: "payload_too_large" }, 413);
    }

    const bodyResult = await parseJsonBody<unknown>(c.req);
    if (!bodyResult.ok) {
      return c.json({ ok: false, error: bodyResult.error }, 400);
    }

    const schema = z.object({
      name: z
        .string()
        .min(1)
        .max(256)
        .regex(BRANCH_REGEX, "Invalid branch name"),
      message: z.string().max(65_536).optional(),
      all: z.boolean().optional(),
      insert: z.boolean().optional(),
    });
    const parsed = schema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: "invalid_request",
          message: formatZodErrors(parsed.error),
        },
        400
      );
    }

    try {
      const opts: CreateOpts = {
        message: parsed.data.message,
        all: parsed.data.all,
        insert: parsed.data.insert,
      };
      await gtCreate(result.path, parsed.data.name, opts);
      emitStackChanged(storeEmitter, c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      const code = parseGtError(err);
      return c.json({ ok: false, error: code }, 500);
    }
  });

  app.post("/:id/stack/modify", async (c) => {
    const result = getProjectPath(c.req.param("id"));
    if (!result.ok) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_JSON_BYTES) {
      return c.json({ ok: false, error: "payload_too_large" }, 413);
    }

    const bodyResult = await parseJsonBody<unknown>(c.req);
    if (!bodyResult.ok) {
      return c.json({ ok: false, error: bodyResult.error }, 400);
    }

    const schema = z.object({
      commit: z.boolean().optional(),
      message: z.string().max(65_536).optional(),
      all: z.boolean().optional(),
    });
    const parsed = schema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: "invalid_request",
          message: formatZodErrors(parsed.error),
        },
        400
      );
    }

    try {
      const opts: ModifyOpts = parsed.data;
      await gtModify(result.path, opts);
      emitStackChanged(storeEmitter, c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      const code = parseGtError(err);
      if (code === "graphite_conflict") {
        emitConflict(
          storeEmitter,
          c.req.param("id"),
          "Merge conflict detected"
        );
      }
      return c.json({ ok: false, error: code }, 500);
    }
  });

  app.post("/:id/stack/navigate", async (c) => {
    const result = getProjectPath(c.req.param("id"));
    if (!result.ok) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_JSON_BYTES) {
      return c.json({ ok: false, error: "payload_too_large" }, 413);
    }

    const bodyResult = await parseJsonBody<unknown>(c.req);
    if (!bodyResult.ok) {
      return c.json({ ok: false, error: bodyResult.error }, 400);
    }

    const schema = z.object({
      action: z.enum(["up", "down", "top", "bottom", "checkout"]),
      // DoS protection: limit steps to prevent unbounded operations
      steps: z.number().int().positive().max(100).optional(),
      branch: z
        .string()
        .min(1)
        .max(256)
        .regex(BRANCH_REGEX, "Invalid branch name")
        .optional(),
    });
    const parsed = schema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: "invalid_request",
          message: formatZodErrors(parsed.error),
        },
        400
      );
    }

    const { action, steps, branch } = parsed.data;

    // Validate checkout requires branch
    if (action === "checkout" && !branch) {
      return c.json(
        {
          ok: false,
          error: "invalid_request",
          message: "checkout requires branch",
        },
        400
      );
    }

    try {
      switch (action) {
        case "up":
          await gtUp(result.path, steps);
          break;
        case "down":
          await gtDown(result.path, steps);
          break;
        case "top":
          await gtTop(result.path);
          break;
        case "bottom":
          await gtBottom(result.path);
          break;
        case "checkout":
          await gtCheckout(result.path, branch);
          break;
        default:
          // Exhaustive: all cases handled by zod enum validation
          break;
      }
      emitStackChanged(storeEmitter, c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      const code = parseGtError(err);
      return c.json({ ok: false, error: code }, 500);
    }
  });

  app.post("/:id/stack/continue", async (c) => {
    const result = getProjectPath(c.req.param("id"));
    if (!result.ok) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_JSON_BYTES) {
      return c.json({ ok: false, error: "payload_too_large" }, 413);
    }

    const bodyResult = await parseJsonBody<unknown>(c.req);
    if (!bodyResult.ok) {
      return c.json({ ok: false, error: bodyResult.error }, 400);
    }

    const schema = z.object({
      all: z.boolean().optional(),
    });
    const parsed = schema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: "invalid_request",
          message: formatZodErrors(parsed.error),
        },
        400
      );
    }

    try {
      const opts: ContinueOpts = parsed.data;
      await gtContinue(result.path, opts);
      emitStackChanged(storeEmitter, c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      const code = parseGtError(err);
      if (code === "graphite_conflict") {
        emitConflict(
          storeEmitter,
          c.req.param("id"),
          "Merge conflict detected"
        );
      }
      return c.json({ ok: false, error: code }, 500);
    }
  });

  app.post("/:id/stack/abort", async (c) => {
    const result = getProjectPath(c.req.param("id"));
    if (!result.ok) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_JSON_BYTES) {
      return c.json({ ok: false, error: "payload_too_large" }, 413);
    }

    const bodyResult = await parseJsonBody<unknown>(c.req);
    if (!bodyResult.ok) {
      return c.json({ ok: false, error: bodyResult.error }, 400);
    }

    const schema = z.object({
      force: z.boolean().optional(),
    });
    const parsed = schema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: "invalid_request",
          message: formatZodErrors(parsed.error),
        },
        400
      );
    }

    try {
      const opts: AbortOpts = parsed.data;
      await gtAbort(result.path, opts);
      emitStackChanged(storeEmitter, c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      const code = parseGtError(err);
      return c.json({ ok: false, error: code }, 500);
    }
  });

  return app;
};
