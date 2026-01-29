import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";

const require = createRequire(import.meta.url);

// Cache the resolved binary path - it won't change during runtime
let cachedBinaryPath: string | null = null;

/**
 * Validates that a path is safe to use as an executable.
 * Returns true if:
 * - Path is absolute (prevents relative path injection)
 * - Path exists on filesystem
 * - Path resolves to a file (symlinks are followed via statSync)
 *
 * Note: Symlinks to executable files are accepted since statSync follows symlinks.
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
 * Resolution order (matches official Codex SDK pattern):
 * 1. CODEX_EXECUTABLE env var (official Codex SDK env var for override)
 * 2. Bundled @openai/codex package
 *
 * Result is cached after first successful resolution.
 */
export const getCodexBinaryPath = (): string => {
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
  // 1. Dev/testing override (official Codex env var)
  const envPath = process.env.CODEX_EXECUTABLE;
  if (envPath) {
    if (!isValidExecutablePath(envPath)) {
      // Log details for debugging (not exposed to clients)
      const reason = isAbsolute(envPath)
        ? "path does not exist or is not a file"
        : "path is not absolute";
      console.error(
        `[codex] CODEX_EXECUTABLE validation failed: ${reason} (path: ${envPath})`
      );
      throw new Error("invalid_codex_executable_path");
    }
    return envPath;
  }

  // 2. Bundled package
  try {
    const pkg = require.resolve("@openai/codex/package.json");
    const bundledPath = join(dirname(pkg), "bin", "codex.js");
    if (!isValidExecutablePath(bundledPath)) {
      throw new Error("invalid_bundled_codex_path");
    }
    return bundledPath;
  } catch (err) {
    if (err instanceof Error && err.message === "invalid_bundled_codex_path") {
      throw err;
    }
    throw new Error("codex_not_found");
  }
};
