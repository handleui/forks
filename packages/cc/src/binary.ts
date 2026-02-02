/** Claude Code binary path resolution */

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

let cachedBinaryPath: string | null = null;

/**
 * Validates that a path is safe to use as an executable.
 * Returns true if:
 * - Path is absolute (prevents relative path injection)
 * - Path exists on filesystem
 * - Path resolves to a file (symlinks are followed via statSync)
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
 * Get the path to the claude binary.
 * Resolution order:
 * 1. CLAUDE_EXECUTABLE env var (validated for security)
 * 2. "claude" (from PATH)
 *
 * Result is cached after first successful resolution.
 */
export const getClaudeBinaryPath = (): string => {
  if (cachedBinaryPath !== null) {
    return cachedBinaryPath;
  }

  const resolved = resolveBinaryPath();
  cachedBinaryPath = resolved;
  return resolved;
};

/**
 * Clear the cached binary path. Useful for testing or when binary location changes.
 */
export const clearBinaryPathCache = (): void => {
  cachedBinaryPath = null;
};

const resolveBinaryPath = (): string => {
  const envPath = process.env.CLAUDE_EXECUTABLE;
  if (envPath) {
    if (!isValidExecutablePath(envPath)) {
      // Log details for debugging (not exposed to clients via forksd's sanitizeErrorMessage)
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
