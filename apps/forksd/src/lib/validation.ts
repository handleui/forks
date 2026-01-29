/** Shared validation utilities for forksd routes */

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_ID_LENGTH = 128;

/** Validates ID format to prevent injection and ensure safe lookups */
export const isValidId = (id: string): boolean => {
  if (!id || id.length > MAX_ID_LENGTH) {
    return false;
  }
  return ID_PATTERN.test(id);
};

/**
 * Validates a relative path to prevent path traversal attacks.
 * Ensures the path:
 * - Is not empty or absolute
 * - Does not contain null bytes
 * - Does not escape the base directory via ".."
 * - Does not contain backslashes (Windows path separator)
 */
export const isValidRelativePath = (relativePath: string): boolean => {
  if (
    !relativePath ||
    relativePath.length === 0 ||
    relativePath.startsWith("/")
  ) {
    return false;
  }

  // Block null bytes which can be used in path attacks
  if (relativePath.includes("\0")) {
    return false;
  }

  // Block backslashes (potential Windows path injection on some platforms)
  if (relativePath.includes("\\")) {
    return false;
  }

  // Validate path segments to prevent directory traversal
  const parts = relativePath.split("/");
  let depth = 0;
  for (const part of parts) {
    if (part === "..") {
      depth--;
      if (depth < 0) {
        return false;
      }
    } else if (part !== "." && part !== "") {
      depth++;
    }
  }
  return true;
};
