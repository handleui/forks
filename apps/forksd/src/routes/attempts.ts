/** Attempt routes */

import { createAttemptWorktreeManager } from "@forks-sh/git/attempt-worktree-manager";
import { type AttemptResult, VALIDATION } from "@forks-sh/protocol";
import type { Store } from "@forks-sh/store";
import { Hono } from "hono";

// Shared attempt worktree manager instance for cleanup
const attemptWorktreeManager = createAttemptWorktreeManager();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const isValidId = (id: string): boolean => {
  if (!id || id.length > VALIDATION.MAX_ID_LENGTH) {
    return false;
  }
  return VALIDATION.ID_PATTERN.test(id);
};

const parseIntParam = (
  value: string | undefined,
  defaultValue: number,
  max: number
): number => {
  if (!value) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return defaultValue;
  }
  return Math.min(parsed, max);
};

export const createAttemptRoutes = (store: Store) => {
  const app = new Hono();

  app.get("/chats/:chatId/attempts", (c) => {
    const chatId = c.req.param("chatId");
    if (!isValidId(chatId)) {
      return c.json({ ok: false, error: "invalid_chat_id" }, 400);
    }
    // Verify chat exists to prevent information leakage about attempt existence
    const chat = store.getChat(chatId);
    if (!chat) {
      return c.json({ ok: false, error: "chat_not_found" }, 404);
    }
    const limit = parseIntParam(c.req.query("limit"), DEFAULT_LIMIT, MAX_LIMIT);
    const offset = parseIntParam(
      c.req.query("offset"),
      0,
      Number.MAX_SAFE_INTEGER
    );
    const attempts = store.listAttempts(chatId, limit, offset);
    return c.json({ ok: true, attempts, limit, offset });
  });

  app.get("/attempts/:id", (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      return c.json({ ok: false, error: "invalid_id" }, 400);
    }
    const attempt = store.getAttempt(id);
    if (!attempt) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    let parsedResult: AttemptResult | null = null;
    if (attempt.result) {
      try {
        const parsed: unknown = JSON.parse(attempt.result);
        // Validate the parsed result has expected shape
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "summary" in parsed &&
          typeof (parsed as { summary: unknown }).summary === "string"
        ) {
          // Validate unifiedDiff is string or null to prevent type confusion
          const obj = parsed as { summary: string; unifiedDiff?: unknown };
          parsedResult = {
            summary: obj.summary,
            unifiedDiff:
              typeof obj.unifiedDiff === "string" ? obj.unifiedDiff : null,
          };
        } else {
          // Invalid JSON structure - treat as legacy plain text
          parsedResult = { summary: attempt.result, unifiedDiff: null };
        }
      } catch {
        // Legacy plain text result - wrap in AttemptResult format
        parsedResult = { summary: attempt.result, unifiedDiff: null };
      }
    }
    return c.json({ ok: true, attempt: { ...attempt, parsedResult } });
  });

  // Pick an attempt (marks as winner, discards siblings, applies changes, cleans up worktrees)
  app.post("/attempts/:id/pick", async (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      return c.json({ ok: false, error: "invalid_id" }, 400);
    }
    // Get attempt first to verify existence
    const attempt = store.getAttempt(id);
    if (!attempt) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    // Pick the attempt (atomically updates status only if currently "completed")
    const picked = store.pickAttempt(id);
    if (!picked) {
      return c.json({ ok: false, error: "pick_failed" }, 400);
    }

    // Get workspace to resolve the repo path
    const chat = store.getChat(picked.chatId);
    const workspace = chat ? store.getWorkspace(chat.workspaceId) : null;

    // Apply picked attempt's changes to workspace using git reset --hard
    if (workspace && picked.branch) {
      try {
        const { resetHard, isValidGitRef } = await import("@forks-sh/git");
        // Defense-in-depth: validate branch from DB before use in git command
        if (isValidGitRef(picked.branch)) {
          await resetHard(workspace.path, picked.branch);
        } else {
          console.error(
            "[routes/attempts] Invalid branch name from database:",
            picked.branch
          );
        }
      } catch (err) {
        console.error(
          "[routes/attempts] Failed to reset workspace to picked attempt branch:",
          err
        );
        // Don't fail the pick - the attempt is already marked as picked
      }
    }

    // Discard sibling attempts in a single batch query
    store.discardOtherAttempts(picked.chatId, id);

    // Re-fetch attempts for worktree cleanup (need current state after batch update)
    const allAttempts = store.listAttempts(picked.chatId, MAX_LIMIT, 0);

    // Clean up ALL worktrees (including picked attempt) in background (non-blocking)
    // The picked attempt's changes have been applied to main workspace via reset --hard,
    // so its worktree is no longer needed. Non-picked attempts are also cleaned up.
    if (workspace) {
      const worktreesToCleanup = allAttempts
        .filter((a) => a.worktreePath && a.branch)
        .map((a) => ({
          id: a.id,
          worktreePath: a.worktreePath as string,
          branch: a.branch as string,
        }));

      // Fire and forget - cleanup runs in parallel in background
      if (worktreesToCleanup.length > 0) {
        const repoPath = workspace.path;
        const cleanupPromises = worktreesToCleanup.map((wt) =>
          attemptWorktreeManager
            .cleanup(wt.worktreePath, wt.branch, repoPath)
            .catch((err) => {
              console.error(
                `[routes/attempts] Failed to cleanup worktree for attempt ${wt.id}:`,
                err
              );
            })
        );
        // Run all cleanups in parallel but don't await - let them complete in background
        Promise.all(cleanupPromises).catch(() => {
          // Already logged individual errors above
        });
      }
    }

    return c.json({ ok: true, attempt: picked });
  });

  // Manually discard an attempt
  app.post("/attempts/:id/discard", (c) => {
    const id = c.req.param("id");
    if (!isValidId(id)) {
      return c.json({ ok: false, error: "invalid_id" }, 400);
    }
    const attempt = store.getAttempt(id);
    if (!attempt) {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
    // Only allow discarding completed or running attempts (not already picked/discarded)
    if (attempt.status !== "completed" && attempt.status !== "running") {
      return c.json(
        { ok: false, error: "invalid_status", currentStatus: attempt.status },
        400
      );
    }
    store.updateAttempt(id, { status: "discarded" });
    return c.json({ ok: true });
  });

  return app;
};
