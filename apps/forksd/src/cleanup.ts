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
      const count = store.pruneOldAttempts(cutoff);
      if (count > 0) {
        console.log(`[cleanup] Pruned ${count} discarded attempts`);
      }
    } catch (err) {
      // Log but don't crash - cleanup is non-critical
      console.error("[cleanup] Failed to prune attempts:", err);
    }
  };

  // Run immediately on startup
  runCleanup();

  // Then run periodically
  const intervalId = setInterval(runCleanup, CLEANUP_INTERVAL_MS);

  // Return cleanup function for graceful shutdown
  return () => clearInterval(intervalId);
};
