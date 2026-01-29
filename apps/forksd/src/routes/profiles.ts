/** Env profile routes */

import { createEnvManager } from "@forks-sh/git/env-manager";
import type { WorkspaceManager } from "@forks-sh/git/workspace-manager";
import type { Workspace } from "@forks-sh/protocol";
import type { Store } from "@forks-sh/store";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { isValidId, isValidRelativePath } from "../lib/validation.js";

const MAX_JSON_BYTES = 64 * 1024;

// Zod schemas defined at module level for performance (avoids re-creating on each request)
const createProfileSchema = z.object({
  name: z.string().min(1).max(128),
  files: z
    .array(
      z.object({
        sourcePath: z.string().min(1).max(512),
        targetPath: z.string().min(1).max(512),
      })
    )
    .min(1)
    .max(100),
});

const applyProfileSchema = z.object({
  profileId: z.string().uuid(),
});

/** Validates all file paths in profile files to prevent path traversal */
const validateProfileFilePaths = (
  files: Array<{ sourcePath: string; targetPath: string }>
): boolean => {
  for (const file of files) {
    if (!isValidRelativePath(file.sourcePath)) {
      return false;
    }
    if (!isValidRelativePath(file.targetPath)) {
      return false;
    }
  }
  return true;
};

const envManager = createEnvManager();

const clearCurrentProfileSymlinks = (
  store: Store,
  workspace: Workspace
): void => {
  if (!workspace.profileId) {
    return;
  }
  const currentProfile = store.getEnvProfile(workspace.profileId);
  if (!currentProfile) {
    return;
  }
  envManager.clearProfile(
    workspace.path,
    currentProfile.files.map((f) => f.targetPath)
  );
};

const validateJsonRequest = (
  c: Context
): { valid: true } | { valid: false; status: 413 | 415 } => {
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > MAX_JSON_BYTES) {
    return { valid: false, status: 413 };
  }
  const contentType = c.req.header("content-type");
  if (!contentType?.includes("application/json")) {
    return { valid: false, status: 415 };
  }
  return { valid: true };
};

export const createProfileRoutes = (
  store: Store,
  manager: WorkspaceManager
) => {
  const app = new Hono();

  app.get("/projects/:id/profiles", (c) => {
    const projectId = c.req.param("id");
    if (!isValidId(projectId)) {
      return c.json({ ok: false, error: "invalid_id" }, 400);
    }
    const project = manager.getProject(projectId);
    if (!project) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const profiles = store.listEnvProfiles(projectId);
    return c.json({ ok: true, profiles });
  });

  app.post("/projects/:id/profiles", async (c) => {
    const projectId = c.req.param("id");
    if (!isValidId(projectId)) {
      return c.json({ ok: false, error: "invalid_id" }, 400);
    }
    const project = manager.getProject(projectId);
    if (!project) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const reqValidation = validateJsonRequest(c);
    if (!reqValidation.valid) {
      const error =
        reqValidation.status === 413
          ? "payload_too_large"
          : "invalid_content_type";
      return c.json({ ok: false, error }, reqValidation.status);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = createProfileSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_request" }, 400);
    }

    // Validate paths to prevent path traversal attacks before storing in database
    if (!validateProfileFilePaths(parsed.data.files)) {
      return c.json({ ok: false, error: "invalid_path" }, 400);
    }

    try {
      const profile = store.createEnvProfile(
        projectId,
        parsed.data.name,
        parsed.data.files
      );
      return c.json({ ok: true, profile }, 201);
    } catch {
      return c.json({ ok: false, error: "profile_creation_failed" }, 400);
    }
  });

  app.get("/profiles/:id", (c) => {
    const profileId = c.req.param("id");
    if (!isValidId(profileId)) {
      return c.json({ ok: false, error: "invalid_id" }, 400);
    }
    const profile = store.getEnvProfile(profileId);
    if (!profile) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    return c.json({ ok: true, profile });
  });

  app.delete("/profiles/:id", (c) => {
    const profileId = c.req.param("id");
    if (!isValidId(profileId)) {
      return c.json({ ok: false, error: "invalid_id" }, 400);
    }
    const profile = store.getEnvProfile(profileId);
    if (!profile) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    try {
      store.deleteEnvProfile(profileId);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false, error: "delete_failed" }, 500);
    }
  });

  app.post("/projects/:id/detect-env", (c) => {
    const projectId = c.req.param("id");
    if (!isValidId(projectId)) {
      return c.json({ ok: false, error: "invalid_id" }, 400);
    }
    const project = manager.getProject(projectId);
    if (!project) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const suggestions = envManager.detectEnvFiles(project.path);
    return c.json({ ok: true, suggestions });
  });

  app.post("/workspaces/:id/apply-profile", async (c) => {
    const workspaceId = c.req.param("id");
    if (!isValidId(workspaceId)) {
      return c.json({ ok: false, error: "invalid_id" }, 400);
    }
    const workspace = manager.getWorkspace(workspaceId);
    if (!workspace) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }

    const reqValidation = validateJsonRequest(c);
    if (!reqValidation.valid) {
      const error =
        reqValidation.status === 413
          ? "payload_too_large"
          : "invalid_content_type";
      return c.json({ ok: false, error }, reqValidation.status);
    }

    const body = await c.req.json().catch(() => ({}));
    const parsed = applyProfileSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid_request" }, 400);
    }

    const project = manager.getProject(workspace.projectId);
    if (!project) {
      return c.json({ ok: false, error: "project_not_found" }, 404);
    }

    const newProfile = store.getEnvProfile(parsed.data.profileId);
    if (!newProfile) {
      return c.json({ ok: false, error: "profile_not_found" }, 404);
    }

    if (newProfile.projectId !== workspace.projectId) {
      return c.json({ ok: false, error: "profile_project_mismatch" }, 403);
    }

    clearCurrentProfileSymlinks(store, workspace);

    const applyResult = envManager.applyProfile(
      workspace.path,
      project.path,
      newProfile.files
    );

    if (!applyResult.success) {
      return c.json(
        {
          ok: false,
          error: "apply_profile_failed",
          details: applyResult.errors,
        },
        400
      );
    }

    store.updateWorkspace(workspaceId, { profileId: parsed.data.profileId });

    const updatedWorkspace = manager.getWorkspace(workspaceId);
    return c.json({
      ok: true,
      workspace: updatedWorkspace,
      applied: applyResult.applied,
      skipped: applyResult.skipped,
    });
  });

  return app;
};
