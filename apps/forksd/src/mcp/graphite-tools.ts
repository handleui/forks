/**
 * MCP tools for Graphite stack operations.
 * Provides read-only stack info and conflict resolution tools for agents.
 */

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
import { z } from "zod";

const MAX_PATH_LENGTH = 4096;

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

export const graphiteToolSchemas = {
  graphite_stack: z.object({
    cwd: pathSchema,
  }),
  graphite_continue: z.object({
    cwd: pathSchema,
    all: z.boolean().optional(),
  }),
  graphite_abort: z.object({
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
        cwd: {
          type: "string",
          description: "Working directory of the Graphite-enabled repository",
        },
        all: {
          type: "boolean",
          description: "Stage all changes before continuing",
        },
      },
      required: ["cwd"],
    },
  },
  {
    name: "graphite_abort",
    description:
      "Abort an in-progress Graphite rebase/restack operation. Use to escape from a conflict state without resolving.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cwd: {
          type: "string",
          description: "Working directory of the Graphite-enabled repository",
        },
        force: {
          type: "boolean",
          description: "Force abort even with unresolved conflicts",
        },
      },
      required: ["cwd"],
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

const errorResponse = (message: string): ToolResponse => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

type GraphiteToolHandler = (data: unknown) => Promise<ToolResponse>;

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
    return errorResponse(message);
  }
};

const handleGraphiteContinue: GraphiteToolHandler = async (data) => {
  const { cwd, all } = data as { cwd: string; all?: boolean };

  const validation = await validateGraphiteCwd(cwd);
  if (!validation.ok) {
    return errorResponse(validation.error);
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
    return errorResponse(message);
  }
};

const handleGraphiteAbort: GraphiteToolHandler = async (data) => {
  const { cwd, force } = data as { cwd: string; force?: boolean };

  const validation = await validateGraphiteCwd(cwd);
  if (!validation.ok) {
    return errorResponse(validation.error);
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
    return errorResponse("Failed to abort operation");
  }
};

export const graphiteToolHandlers: Record<
  GraphiteToolName,
  GraphiteToolHandler
> = {
  graphite_stack: handleGraphiteStack,
  graphite_continue: handleGraphiteContinue,
  graphite_abort: handleGraphiteAbort,
};

export const createGraphiteToolHandlers = (): Record<
  GraphiteToolName,
  GraphiteToolHandler
> => graphiteToolHandlers;
