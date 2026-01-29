import { VALIDATION } from "@forks-sh/protocol";

/** Validate ID format and length (defense-in-depth, also validated at MCP layer) */
export const validateId = (id: string, fieldName: string): void => {
  if (!id || id.length > VALIDATION.MAX_ID_LENGTH) {
    throw new Error(
      `Invalid ${fieldName}: must be 1-${VALIDATION.MAX_ID_LENGTH} chars`
    );
  }
  if (!VALIDATION.ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${fieldName}: must match pattern [a-zA-Z0-9_-]`);
  }
};

/** Validate text content length (defense-in-depth, also validated at MCP layer) */
export const validateText = (text: string, fieldName: string): void => {
  if (!text || text.length > VALIDATION.MAX_TEXT_LENGTH) {
    throw new Error(
      `Invalid ${fieldName}: must be 1-${VALIDATION.MAX_TEXT_LENGTH} chars`
    );
  }
};

/**
 * Validate text content length, allowing empty strings.
 * Use for optional text fields where empty is valid.
 */
export const validateOptionalText = (text: string, fieldName: string): void => {
  if (text.length > VALIDATION.MAX_TEXT_LENGTH) {
    throw new Error(
      `Invalid ${fieldName}: must be at most ${VALIDATION.MAX_TEXT_LENGTH} chars`
    );
  }
};
