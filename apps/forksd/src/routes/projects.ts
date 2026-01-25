/** Project routes */

import { homedir } from "node:os";
import { normalize, resolve } from "node:path";
import type { WorkspaceManager } from "@forks-sh/git/workspace-manager";
import { Hono } from "hono";
import { z } from "zod";

const MAX_JSON_BYTES = 64 * 1024;

/** Strict branch validation: alphanumeric, hyphens, underscores, slashes, and dots.
 *  Cannot start with dash or dot (prevents git option injection and git ref issues)
 */
const BRANCH_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/;

/** Paths that should never be added as projects */
const SENSITIVE_PATHS = [
  "/etc",
  "/var",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/boot",
  "/root",
  "/sys",
  "/proc",
  "/dev",
  "/run",
  "/tmp",
  "/private/etc",
  "/private/var",
  "/System",
  "/Library",
  "/Applications",
];

/** Home directory subdirs that should be protected */
const SENSITIVE_HOME_DIRS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".kube",
  ".docker",
  ".npm",
  ".password-store",
  ".local/share/keyrings",
  "Library/Keychains",
];

const isSensitivePath = (inputPath: string): boolean => {
  const normalized = normalize(resolve(inputPath));
  const home = homedir();

  // Check absolute sensitive paths
  for (const sensitive of SENSITIVE_PATHS) {
    if (normalized === sensitive || normalized.startsWith(`${sensitive}/`)) {
      return true;
    }
  }

  // Check sensitive home directories
  for (const dir of SENSITIVE_HOME_DIRS) {
    const fullPath = resolve(home, dir);
    if (normalized === fullPath || normalized.startsWith(`${fullPath}/`)) {
      return true;
    }
  }

  // Block the home directory itself (too broad)
  if (normalized === home) {
    return true;
  }

  return false;
};

export const createProjectRoutes = (manager: WorkspaceManager) => {
  const app = new Hono();

  app.get("/", (c) => {
    const projects = manager.listProjects();
    return c.json({ ok: true, projects });
  });

  app.post("/", async (c) => {
    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_JSON_BYTES) {
      return c.json({ ok: false, error: "payload_too_large" }, 413);
    }
    const contentType = c.req.header("content-type");
    if (!contentType?.includes("application/json")) {
      return c.json({ ok: false, error: "invalid_content_type" }, 415);
    }

    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({ path: z.string().min(1).max(1024) });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_request" }, 400);
    }

    // Validate path is not sensitive
    if (isSensitivePath(parsed.data.path)) {
      return c.json({ ok: false, error: "path_not_allowed" }, 403);
    }

    try {
      const project = await manager.addProject(parsed.data.path);
      return c.json({ ok: true, project });
    } catch (err) {
      // Sanitize error message - don't leak internal paths or details
      const message = err instanceof Error ? err.message : "";
      if (message.includes("Not a git repository")) {
        return c.json({ ok: false, error: "not_a_git_repository" }, 400);
      }
      return c.json({ ok: false, error: "failed_to_add_project" }, 400);
    }
  });

  app.get("/:id", (c) => {
    const project = manager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    return c.json({ ok: true, project });
  });

  app.delete("/:id", async (c) => {
    const project = manager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    try {
      await manager.deleteProject(c.req.param("id"));
      return c.json({ ok: true });
    } catch {
      // Don't leak internal error details
      return c.json({ ok: false, error: "delete_failed" }, 500);
    }
  });

  app.get("/:id/workspaces", (c) => {
    const project = manager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const workspaces = manager.getProjectWorkspaces(c.req.param("id"));
    return c.json({ ok: true, workspaces });
  });

  app.post("/:id/workspaces", async (c) => {
    const project = manager.getProject(c.req.param("id"));
    if (!project) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (contentLength > MAX_JSON_BYTES) {
      return c.json({ ok: false, error: "payload_too_large" }, 413);
    }

    const body = await c.req.json().catch(() => ({}));
    const schema = z.object({
      name: z.string().min(1).max(128).optional(),
      branch: z
        .string()
        .min(1)
        .max(256)
        .regex(BRANCH_REGEX, "Invalid branch name format")
        .refine((b) => !b.includes(".."), "Branch name cannot contain ..")
        .refine(
          (b) => !b.endsWith(".lock"),
          "Branch name cannot end with .lock"
        )
        .optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_request" }, 400);
    }

    try {
      const workspace = await manager.createWorkspace(
        c.req.param("id"),
        parsed.data
      );
      return c.json({ ok: true, workspace });
    } catch {
      // Don't leak internal error details
      return c.json({ ok: false, error: "workspace_creation_failed" }, 400);
    }
  });

  return app;
};
