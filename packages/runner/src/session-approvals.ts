/**
 * Session-level approval cache for "accept for session" decisions.
 *
 * This matches the Codex app-server pattern where approvals are cached
 * by {type, command, cwd} key. All threads in a Runner instance share
 * this cache, so subagents automatically benefit from parent's
 * "accept for session" decisions.
 */
export class SessionApprovalCache {
  private readonly cache = new Map<string, true>();

  /**
   * Create a cache key from approval parameters.
   * Uses JSON.stringify for safety against malformed inputs containing null bytes.
   */
  makeKey(type: string, command?: string, cwd?: string): string {
    return JSON.stringify([type, command ?? "", cwd ?? ""]);
  }

  /**
   * Check if an action has been pre-approved for this session.
   */
  isApprovedForSession(type: string, command?: string, cwd?: string): boolean {
    return this.cache.has(this.makeKey(type, command, cwd));
  }

  /**
   * Mark an action as approved for the remainder of this session.
   */
  markApprovedForSession(type: string, command?: string, cwd?: string): void {
    this.cache.set(this.makeKey(type, command, cwd), true);
  }

  /**
   * Clear all cached approvals (e.g., on session end).
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the number of cached approvals (for testing/debugging).
   */
  get size(): number {
    return this.cache.size;
  }
}
