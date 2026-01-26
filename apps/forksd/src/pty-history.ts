/**
 * Ring buffer for terminal output history.
 * Stores the last N bytes of terminal output for @terminal context.
 *
 * Performance optimizations:
 * - Uses chunked array storage to avoid O(n) string concatenation
 * - Lazy joining only when get() is called
 * - Efficient truncation without full buffer reallocation
 */

const DEFAULT_MAX_SIZE = 64 * 1024; // 64KB
const CHUNK_THRESHOLD = 32; // Consolidate chunks when count exceeds this

export interface PtyHistory {
  /** Append data to the buffer, truncating old data if needed */
  append: (data: string) => void;
  /** Get the current buffer contents */
  get: () => string;
  /** Clear the buffer */
  clear: () => void;
  /** Get the current size in bytes */
  size: () => number;
}

/**
 * Create a ring buffer for terminal output.
 * When the buffer exceeds maxSize, oldest data is truncated.
 *
 * Uses chunked storage to avoid O(n) string concatenation on every append.
 * Chunks are joined lazily when get() is called.
 */
export const createPtyHistory = (maxSize = DEFAULT_MAX_SIZE): PtyHistory => {
  let chunks: string[] = [];
  let totalSize = 0;

  const consolidateChunks = () => {
    if (chunks.length > 1) {
      chunks = [chunks.join("")];
    }
  };

  const truncate = () => {
    if (totalSize <= maxSize) {
      return;
    }

    // Consolidate to a single string for truncation
    consolidateChunks();
    let buffer = chunks[0] ?? "";

    // Find a good truncation point (newline) to avoid mid-line cuts
    const excess = buffer.length - maxSize;
    const newlineIndex = buffer.indexOf("\n", excess);
    if (newlineIndex !== -1 && newlineIndex < excess + 1024) {
      // Truncate at newline if one exists within 1KB of truncation point
      buffer = buffer.slice(newlineIndex + 1);
    } else {
      // Otherwise just truncate at the size limit
      buffer = buffer.slice(excess);
    }

    chunks = buffer.length > 0 ? [buffer] : [];
    totalSize = buffer.length;
  };

  return {
    append: (data: string) => {
      if (data.length === 0) {
        return;
      }

      chunks.push(data);
      totalSize += data.length;

      // Consolidate periodically to prevent too many chunks
      if (chunks.length > CHUNK_THRESHOLD) {
        consolidateChunks();
      }

      // Truncate if over limit
      if (totalSize > maxSize) {
        truncate();
      }
    },

    get: () => {
      if (chunks.length === 0) {
        return "";
      }
      if (chunks.length === 1) {
        return chunks[0] ?? "";
      }
      // Lazy join and cache
      consolidateChunks();
      return chunks[0] ?? "";
    },

    clear: () => {
      chunks = [];
      totalSize = 0;
    },

    size: () => totalSize,
  };
};
