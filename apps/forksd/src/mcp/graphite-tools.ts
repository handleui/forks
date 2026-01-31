/**
 * MCP tools for Graphite stack operations.
 * Provides read-only stack info and conflict resolution tools for agents.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { normalize } from "node:path";
import type {
  AbortOpts,
  ContinueOpts,
  StackInfo,
} from "@forks-sh/git/graphite";
import {
  gtAbort,
  gtContinue,
  gtLog,
  isGraphiteRepo,
} from "@forks-sh/git/graphite";
import { type AgentEvent, VALIDATION } from "@forks-sh/protocol";
import type { Store, StoreEventEmitter } from "@forks-sh/store";
import { z } from "zod";

const MAX_PATH_LENGTH = 4096;
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const APPROVAL_TOKEN_BYTES = 32; // 256 bits of entropy

const PROTECTED_PATHS = [
  "/",
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/etc",
  "/var",
  "/root",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/lib",
  "/lib64",
  "/usr/lib",
  "/opt",
  "/System", // macOS
  "/Library", // macOS
  "/Applications", // macOS
  "/private", // macOS
  "C:\\Windows", // Windows
  "C:\\Program Files", // Windows
  "C:\\Program Files (x86)", // Windows
];

const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:\\/;

const isPathSafe = (cwdPath: string): { safe: boolean; reason?: string } => {
  // Must be absolute path
  if (!(cwdPath.startsWith("/") || WINDOWS_DRIVE_PATH_REGEX.test(cwdPath))) {
    return { safe: false, reason: "Path must be absolute" };
  }

  // Normalize and resolve to catch path traversal
  const normalized = normalize(cwdPath);

  // Check for path traversal attempts in normalized path
  if (normalized.includes("..")) {
    return { safe: false, reason: "Path traversal not allowed" };
  }

  // Check against protected paths
  for (const protectedPath of PROTECTED_PATHS) {
    const normalizedProtected = protectedPath.toLowerCase();
    const normalizedInput = normalized.toLowerCase();
    if (
      normalizedInput === normalizedProtected ||
      normalizedInput.startsWith(`${normalizedProtected}/`) ||
      normalizedInput.startsWith(`${normalizedProtected}\\`)
    ) {
      return { safe: false, reason: "Access to system directory not allowed" };
    }
  }

  // Verify directory exists and is actually a directory
  try {
    if (!existsSync(normalized)) {
      return { safe: false, reason: "Directory does not exist" };
    }
    const stats = statSync(normalized);
    if (!stats.isDirectory()) {
      return { safe: false, reason: "Path is not a directory" };
    }
  } catch {
    return { safe: false, reason: "Cannot access directory" };
  }

  return { safe: true };
};

const pathSchema = z.string().min(1).max(MAX_PATH_LENGTH);
const chatIdSchema = z
  .string()
  .min(1)
  .max(VALIDATION.MAX_ID_LENGTH)
  .regex(VALIDATION.ID_PATTERN, "Invalid ID format");

export const graphiteToolSchemas = {
  graphite_stack: z.object({
    cwd: pathSchema,
  }),
  graphite_continue: z.object({
    chatId: chatIdSchema,
    cwd: pathSchema,
    all: z.boolean().optional(),
  }),
  graphite_abort: z.object({
    chatId: chatIdSchema,
    cwd: pathSchema,
    force: z.boolean().optional(),
  }),
} as const;

export type GraphiteToolName = keyof typeof graphiteToolSchemas;

export const GRAPHITE_TOOL_DEFINITIONS = [
  {
    name: "graphite_stack",
    description:
      "Get the current Graphite stack information including branches, PR numbers, and restack status. Read-only operation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cwd: {
          type: "string",
          description: "Working directory of the Graphite-enabled repository",
        },
      },
      required: ["cwd"],
    },
  },
  {
    name: "graphite_continue",
    description:
      "Continue a Graphite rebase/restack operation after resolving conflicts. Use after manually resolving merge conflicts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chatId: {
          type: "string",
          description: "The chat ID requesting approval",
        },
        cwd: {
          type: "string",
          description: "Working directory of the Graphite-enabled repository",
        },
        all: {
          type: "boolean",
          description: "Stage all changes before continuing",
        },
      },
      required: ["chatId", "cwd"],
    },
  },
  {
    name: "graphite_abort",
    description:
      "Abort an in-progress Graphite rebase/restack operation. Use to escape from a conflict state without resolving.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chatId: {
          type: "string",
          description: "The chat ID requesting approval",
        },
        cwd: {
          type: "string",
          description: "Working directory of the Graphite-enabled repository",
        },
        force: {
          type: "boolean",
          description: "Force abort even with unresolved conflicts",
        },
      },
      required: ["chatId", "cwd"],
    },
  },
];

interface ToolResponse {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

const successResponse = (data: unknown): ToolResponse => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

const errorResponse = (message: string, code?: string): ToolResponse => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        error: {
          message,
          ...(code ? { code } : {}),
        },
      }),
    },
  ],
  isError: true,
});

type GraphiteToolHandler = (data: unknown) => Promise<ToolResponse>;

type ApprovalDecision = "accepted" | "declined" | "cancelled" | "timeout";

const approvalError = (error: string, code: string) => ({
  ok: false as const,
  error,
  code,
});

const createApprovalToken = (): string =>
  randomBytes(APPROVAL_TOKEN_BYTES).toString("base64url");

const createApprovalWaiter = (
  emitter: StoreEventEmitter,
  token: string
): { promise: Promise<ApprovalDecision>; cancel: () => void } => {
  let resolved = false;
  let resolveFn: ((decision: ApprovalDecision) => void) | null = null;

  const onEvent = (event: AgentEvent): void => {
    if (event.type !== "approval") {
      return;
    }
    if (event.approval.token !== token) {
      return;
    }
    if (event.event === "requested") {
      return;
    }
    if (resolved) {
      return;
    }
    resolved = true;
    clearTimeout(timeoutId);
    emitter.off("agent", onEvent);
    resolveFn?.(event.event);
  };

  const timeoutId = setTimeout(() => {
    if (resolved) {
      return;
    }
    resolved = true;
    emitter.off("agent", onEvent);
    resolveFn?.("timeout");
  }, APPROVAL_TIMEOUT_MS);

  const promise = new Promise<ApprovalDecision>((resolve) => {
    resolveFn = resolve;
  });

  emitter.on("agent", onEvent);

  const cancel = (): void => {
    if (resolved) {
      return;
    }
    resolved = true;
    clearTimeout(timeoutId);
    emitter.off("agent", onEvent);
  };

  return { promise, cancel };
};

const resolveTimeoutDecision = (
  store: Store,
  token: string
): { ok: true } | { ok: false; error: string; code: string } => {
  const approval = store.getApprovalByToken(token);
  if (!approval) {
    return approvalError("Approval timed out", "approval_timeout");
  }

  switch (approval.status) {
    case "accepted":
      return { ok: true };
    case "declined":
      return approvalError("Approval declined", "approval_declined");
    case "cancelled":
      return approvalError("Approval cancelled", "approval_cancelled");
    case "pending":
      store.cancelApproval(approval.id);
      return approvalError("Approval timed out", "approval_timeout");
    default:
      return approvalError("Approval timed out", "approval_timeout");
  }
};

const requireApproval = async ({
  store,
  emitter,
  chatId,
  toolName,
  cwd,
  data,
}: {
  store: Store;
  emitter?: StoreEventEmitter;
  chatId: string;
  toolName: GraphiteToolName;
  cwd: string;
  data: unknown;
}): Promise<{ ok: true } | { ok: false; error: string; code: string }> => {
  if (!emitter) {
    return approvalError("Approval system unavailable", "approval_unavailable");
  }

  if (!store.getChat(chatId)) {
    return approvalError("Chat not found", "not_found");
  }

  const token = createApprovalToken();
  const requestId = `graphite-${randomUUID()}`;

  const waiter = createApprovalWaiter(emitter, token);

  try {
    store.createApproval(chatId, token, "commandExecution", {
      threadId: requestId,
      turnId: requestId,
      itemId: requestId,
      command: toolName,
      cwd,
      reason: `Graphite ${toolName.replace("graphite_", "")} requires approval`,
      data,
    });
  } catch (err) {
    waiter.cancel();
    const message =
      err instanceof Error ? err.message : "Failed to request approval";
    return approvalError(message, "approval_failed");
  }

  const decision = await waiter.promise;
  if (decision === "accepted") {
    return { ok: true };
  }

  if (decision === "timeout") {
    return resolveTimeoutDecision(store, token);
  }

  return approvalError(
    decision === "declined" ? "Approval declined" : "Approval cancelled",
    decision === "declined" ? "approval_declined" : "approval_cancelled"
  );
};

const validateGraphiteCwd = async (
  cwd: string
): Promise<{ ok: true } | { ok: false; error: string }> => {
  // Security: validate cwd path before any operations
  const pathValidation = isPathSafe(cwd);
  if (!pathValidation.safe) {
    return { ok: false, error: `Invalid cwd: ${pathValidation.reason}` };
  }

  // Verify this is a Graphite-enabled repository
  const isGraphite = await isGraphiteRepo(cwd);
  if (!isGraphite) {
    return {
      ok: false,
      error: "Not a Graphite-enabled repository. Run 'gt init' first.",
    };
  }

  return { ok: true };
};

const handleGraphiteStack: GraphiteToolHandler = async (data) => {
  const { cwd } = data as { cwd: string };

  const validation = await validateGraphiteCwd(cwd);
  if (!validation.ok) {
    return errorResponse(validation.error);
  }

  try {
    const stackInfo: StackInfo = await gtLog(cwd);
    return successResponse(stackInfo);
  } catch (err) {
    // Don't expose raw error messages to prevent information disclosure
    const isGraphiteError =
      err instanceof Error &&
      (err.message.includes("conflict") || err.message.includes("CONFLICT"));
    const message = isGraphiteError
      ? "Conflict detected in stack"
      : "Failed to get stack info";
    return errorResponse(
      message,
      isGraphiteError ? "conflict" : "command_failed"
    );
  }
};

const handleGraphiteContinue =
  (store: Store, emitter?: StoreEventEmitter): GraphiteToolHandler =>
  async (data) => {
    const { chatId, cwd, all } = data as {
      chatId: string;
      cwd: string;
      all?: boolean;
    };

    const validation = await validateGraphiteCwd(cwd);
    if (!validation.ok) {
      return errorResponse(validation.error, "invalid_cwd");
    }

    const approval = await requireApproval({
      store,
      emitter,
      chatId,
      toolName: "graphite_continue",
      cwd,
      data: { chatId, cwd, all },
    });
    if (!approval.ok) {
      return errorResponse(approval.error, approval.code);
    }

    try {
      const opts: ContinueOpts = {};
      if (all) {
        opts.all = true;
      }
      await gtContinue(cwd, opts);
      return successResponse({ success: true, message: "Continue successful" });
    } catch (err) {
      // Don't expose raw error messages to prevent information disclosure
      const isConflict =
        err instanceof Error &&
        (err.message.includes("conflict") || err.message.includes("CONFLICT"));
      const message = isConflict
        ? "Unresolved conflicts remain"
        : "Failed to continue operation";
      return errorResponse(message, isConflict ? "conflict" : "command_failed");
    }
  };

const handleGraphiteAbort =
  (store: Store, emitter?: StoreEventEmitter): GraphiteToolHandler =>
  async (data) => {
    const { chatId, cwd, force } = data as {
      chatId: string;
      cwd: string;
      force?: boolean;
    };

    const validation = await validateGraphiteCwd(cwd);
    if (!validation.ok) {
      return errorResponse(validation.error, "invalid_cwd");
    }

    const approval = await requireApproval({
      store,
      emitter,
      chatId,
      toolName: "graphite_abort",
      cwd,
      data: { chatId, cwd, force },
    });
    if (!approval.ok) {
      return errorResponse(approval.error, approval.code);
    }

    try {
      const opts: AbortOpts = {};
      if (force) {
        opts.force = true;
      }
      await gtAbort(cwd, opts);
      return successResponse({ success: true, message: "Abort successful" });
    } catch {
      // Don't expose raw error messages to prevent information disclosure
      return errorResponse("Failed to abort operation", "command_failed");
    }
  };

export const createGraphiteToolHandlers = (
  store: Store,
  emitter?: StoreEventEmitter
): Record<GraphiteToolName, GraphiteToolHandler> => ({
  graphite_stack: handleGraphiteStack,
  graphite_continue: handleGraphiteContinue(store, emitter),
  graphite_abort: handleGraphiteAbort(store, emitter),
});
