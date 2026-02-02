import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

let cachedBinaryPath: string | null = null;

/**
 * Validates that a path is safe to use as an executable.
 */
const isValidExecutablePath = (path: string): boolean => {
  if (!isAbsolute(path)) {
    return false;
  }
  try {
    const stats = statSync(path);
    return stats.isFile();
  } catch {
    return false;
  }
};

/**
 * Resolution order:
 * 1. CLAUDE_EXECUTABLE env var
 * 2. "claude" (from PATH)
 */
export const getClaudeBinaryPath = (): string => {
  if (cachedBinaryPath !== null) {
    return cachedBinaryPath;
  }

  const resolved = resolveBinaryPath();
  cachedBinaryPath = resolved;
  return resolved;
};

export const clearBinaryPathCache = (): void => {
  cachedBinaryPath = null;
};

const resolveBinaryPath = (): string => {
  const envPath = process.env.CLAUDE_EXECUTABLE;
  if (envPath) {
    if (!isValidExecutablePath(envPath)) {
      const reason = isAbsolute(envPath)
        ? "path does not exist or is not a file"
        : "path is not absolute";
      console.error(
        `[cc] CLAUDE_EXECUTABLE validation failed: ${reason} (path: ${envPath})`
      );
      throw new Error("invalid_claude_executable_path");
    }
    return envPath;
  }

  // Fall back to "claude" from PATH
  return "claude";
};

export const detectCCSource = (): "env" | "path" => {
  if (process.env.CLAUDE_EXECUTABLE) {
    return "env";
  }
  return "path";
};
