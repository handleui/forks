/** @forks-sh/runner – execution context registry */

import type { ExecutionContext } from "./types.js";

/**
 * Registry for managing active execution contexts.
 * Provides O(1) lookup by context ID, thread ID, and chat ID.
 */
export class ExecutionRegistry {
  private readonly contexts: Map<string, ExecutionContext> = new Map();
  private readonly threadIndex: Map<string, string> = new Map();
  private readonly chatIndex: Map<string, Set<string>> = new Map();
  private readonly reservations: Set<string> = new Set();

  get = (contextId: string): ExecutionContext | undefined => {
    return this.contexts.get(contextId);
  };

  set = (context: ExecutionContext): void => {
    // Convert reservation to full context if exists
    this.reservations.delete(context.id);

    this.contexts.set(context.id, context);
    this.threadIndex.set(context.threadId, context.id);

    // Maintain chat index for O(1) chat lookups
    let chatContexts = this.chatIndex.get(context.chatId);
    if (!chatContexts) {
      chatContexts = new Set();
      this.chatIndex.set(context.chatId, chatContexts);
    }
    chatContexts.add(context.id);
  };

  delete = (contextId: string): void => {
    const context = this.contexts.get(contextId);
    if (context) {
      this.threadIndex.delete(context.threadId);
      this.contexts.delete(contextId);

      // Clean up chat index
      const chatContexts = this.chatIndex.get(context.chatId);
      if (chatContexts) {
        chatContexts.delete(contextId);
        if (chatContexts.size === 0) {
          this.chatIndex.delete(context.chatId);
        }
      }
    }
  };

  getByThreadId = (threadId: string): ExecutionContext | undefined => {
    const contextId = this.threadIndex.get(threadId);
    // Silent return - unknown threads are expected (e.g., events from user's main chat)
    return contextId ? this.contexts.get(contextId) : undefined;
  };

  getAllByChatId = (chatId: string): ExecutionContext[] => {
    const contextIds = this.chatIndex.get(chatId);
    if (!contextIds) {
      return [];
    }
    const results: ExecutionContext[] = [];
    for (const contextId of contextIds) {
      const context = this.contexts.get(contextId);
      if (context) {
        results.push(context);
      }
    }
    return results;
  };

  countByChatId = (chatId: string): number => {
    return this.chatIndex.get(chatId)?.size ?? 0;
  };

  get size(): number {
    return this.contexts.size + this.reservations.size;
  }

  /**
   * Atomically reserve a slot if size limit allows.
   * Use before async operations to prevent TOCTOU races.
   */
  tryReserve = (contextId: string, maxSize: number): boolean => {
    if (this.size >= maxSize) {
      return false;
    }
    this.reservations.add(contextId);
    return true;
  };

  /**
   * Atomically reserve a slot for a specific chat if limits allow.
   */
  tryReserveForChat = (
    contextId: string,
    chatId: string,
    maxGlobalSize: number,
    maxPerChat: number
  ): boolean => {
    if (this.size >= maxGlobalSize) {
      return false;
    }
    if (this.countByChatId(chatId) >= maxPerChat) {
      return false;
    }
    this.reservations.add(contextId);
    return true;
  };

  /**
   * Release a reservation without registering.
   */
  releaseReservation = (contextId: string): void => {
    this.reservations.delete(contextId);
  };

  /**
   * Atomically reserve slots for a batch if limits allow.
   * Returns list of successfully reserved IDs (all or none).
   */
  tryReserveBatch = (
    contextIds: string[],
    chatId: string,
    maxGlobalSize: number,
    maxPerChat: number
  ): boolean => {
    const batchSize = contextIds.length;
    if (this.size + batchSize > maxGlobalSize) {
      return false;
    }
    if (this.countByChatId(chatId) + batchSize > maxPerChat) {
      return false;
    }
    for (const id of contextIds) {
      this.reservations.add(id);
    }
    return true;
  };

  values = (): IterableIterator<ExecutionContext> => {
    return this.contexts.values();
  };

  clear = (): void => {
    this.contexts.clear();
    this.threadIndex.clear();
    this.chatIndex.clear();
    this.reservations.clear();
  };
}

export const createRegistry = (): ExecutionRegistry => {
  return new ExecutionRegistry();
};
