/** Shared validation utilities for forksd routes */

import { isValidRelativePath as _isValidRelativePath } from "@forks-sh/protocol";

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
 * Re-export from @forks-sh/protocol for consistent path validation.
 * Validates relative paths to prevent path traversal attacks.
 */
export const isValidRelativePath = _isValidRelativePath;
