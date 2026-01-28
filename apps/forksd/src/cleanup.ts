/** Cleanup scheduler for pruning old discarded attempts */

import type { Store } from "@forks-sh/store";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const RETENTION_DAYS = 7;

export const startCleanupScheduler = (store: Store): (() => void) => {
  const runCleanup = () => {
    try {
      const cutoff = new Date(
        Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
      );
      store.pruneOldAttempts(cutoff);
    } catch {
      // Silently ignore - cleanup is non-critical
    }
  };

  // Run immediately on startup
  runCleanup();

  // Then run periodically
  const intervalId = setInterval(runCleanup, CLEANUP_INTERVAL_MS);

  // Return cleanup function for graceful shutdown
  return () => clearInterval(intervalId);
};
