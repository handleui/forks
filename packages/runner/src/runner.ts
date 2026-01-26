/** @forks-sh/runner – core execution orchestrator */

import type {
  ApprovalRequest,
  CodexAdapter,
  CodexEvent,
  ThreadForkResponse,
} from "@forks-sh/codex";
import type { Attempt, Subagent } from "@forks-sh/store";

import { ExecutionRegistry } from "./registry.js";
import type { ExecutionContext, RunnerConfig } from "./types.js";

const STOP_TIMEOUT_MS = 5000;
const MAX_CONCURRENT_PER_CHAT = 10;
const MAX_ACCUMULATED_MESSAGE_SIZE = 1024 * 1024; // 1MB per thread
const MAX_TASK_LENGTH = 100_000; // 100KB max task description
const MAX_RESULT_SIZE = 1024 * 1024; // 1MB max result size
const MAX_REGISTRY_SIZE = 1000; // Global limit on tracked executions

/**
 * Runner orchestrates the execution of subagents and attempt batches.
 * It bridges the Codex adapter with the persistence store.
 *
 * SECURITY WARNING (v1):
 * - Auto-approves ALL command execution and file change requests
 * - No human-in-the-loop approval flow in this version
 * - Suitable for trusted local development environments only
 *
 * Resource limits enforced:
 * - MAX_CONCURRENT_PER_CHAT: Limits parallel executions per chat (10)
 * - MAX_ACCUMULATED_MESSAGE_SIZE: Limits message accumulator size per thread (1MB)
 * - MAX_TASK_LENGTH: Limits task description size (100KB)
 * - MAX_REGISTRY_SIZE: Global limit on tracked executions (1000)
 */
export class Runner {
  private readonly adapter: CodexAdapter;
  private readonly store: RunnerConfig["store"];
  private readonly registry = new ExecutionRegistry();

  private unsubscribeEvent: (() => void) | null = null;
  private unsubscribeApproval: (() => void) | null = null;
  private started = false;
  private stopping = false;

  // Accumulator for agent message deltas by thread (with size tracking)
  // Uses string[] instead of string concatenation to avoid O(n²) performance
  private readonly messageAccumulator: Map<string, string[]> = new Map();
  private readonly accumulatorSizes: Map<string, number> = new Map();

  constructor(config: RunnerConfig) {
    this.adapter = config.adapter;
    this.store = config.store;
  }

  /**
   * Start the runner - subscribe to adapter events.
   */
  start = (): void => {
    if (this.started) {
      console.warn("[Runner] Already started");
      return;
    }

    this.unsubscribeEvent = this.adapter.onEvent(this.handleEvent);
    this.unsubscribeApproval = this.adapter.onApprovalRequest(
      this.handleApproval
    );
    this.started = true;
  };

  /**
   * Check if the runner is currently running.
   */
  get isRunning(): boolean {
    return this.started && !this.stopping;
  }

  /**
   * Stop the runner - cancel all active executions, unsubscribe, cleanup.
   */
  stop = async (): Promise<void> => {
    if (!this.started || this.stopping) {
      return;
    }

    this.stopping = true;

    // Cancel all active executions with timeout
    const cancelPromises: Promise<void>[] = [];
    const contexts = this.getAllActiveContexts();

    for (const context of contexts) {
      if (context.runId) {
        cancelPromises.push(
          this.adapter.cancel(context.runId).catch((err) => {
            console.warn(
              `[Runner] Failed to cancel run ${context.runId}:`,
              err
            );
          })
        );
      }
      context.abortController.abort();
    }

    // Wait for cancellations with timeout
    await Promise.race([
      Promise.all(cancelPromises),
      new Promise<void>((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
    ]);

    // Unsubscribe from events
    if (this.unsubscribeEvent) {
      this.unsubscribeEvent();
      this.unsubscribeEvent = null;
    }
    if (this.unsubscribeApproval) {
      this.unsubscribeApproval();
      this.unsubscribeApproval = null;
    }

    // Clear all state
    this.messageAccumulator.clear();
    this.accumulatorSizes.clear();
    this.registry.clear();

    this.started = false;
    this.stopping = false;
  };

  /**
   * Execute a subagent task.
   */
  executeSubagent = async (subagent: Subagent): Promise<void> => {
    // Reject execution during shutdown
    if (this.stopping) {
      console.warn("[Runner] Cannot execute subagent during shutdown");
      this.store.updateSubagent(subagent.id, {
        status: "failed",
        error: "Runner is shutting down",
      });
      return;
    }

    // Validate task length to prevent memory exhaustion
    if (subagent.task.length > MAX_TASK_LENGTH) {
      console.error(
        `[Runner] Task too large for subagent ${subagent.id}: ${subagent.task.length} bytes`
      );
      this.store.updateSubagent(subagent.id, {
        status: "failed",
        error: `Task too large: ${subagent.task.length} bytes exceeds ${MAX_TASK_LENGTH} limit`,
      });
      return;
    }

    const chat = this.store.getChat(subagent.parentChatId);
    if (!chat) {
      console.error(
        `[Runner] Chat not found for subagent: ${subagent.parentChatId}`
      );
      this.store.updateSubagent(subagent.id, {
        status: "failed",
        error: `Parent chat not found: ${subagent.parentChatId}`,
      });
      return;
    }

    // Atomically reserve slot to prevent TOCTOU races
    const reserved = this.registry.tryReserveForChat(
      subagent.id,
      chat.id,
      MAX_REGISTRY_SIZE,
      MAX_CONCURRENT_PER_CHAT
    );
    if (!reserved) {
      console.error(
        `[Runner] Registry or concurrency limit reached for chat ${chat.id}`
      );
      this.store.updateSubagent(subagent.id, {
        status: "failed",
        error: "Registry or concurrency limit exceeded",
      });
      return;
    }

    const cwd = this.resolveWorkspaceCwd(chat.id);
    let threadId: string | null | undefined;

    try {
      // Create a new thread
      const thread = this.adapter.startThread();
      threadId = thread.id;

      if (!threadId) {
        console.error("[Runner] Failed to create thread - id is null");
        this.store.updateSubagent(subagent.id, {
          status: "failed",
          error: "Failed to create thread - id is null",
        });
        this.registry.releaseReservation(subagent.id);
        return;
      }

      // Send the turn first to get runId before registering context
      // This avoids a race condition where events could arrive for a context without runId
      // Pass cwd directly to sendTurn to avoid race condition with concurrent workspace executions
      const runId = await this.adapter.sendTurn(threadId, subagent.task, {
        cwd,
      });

      // Register the execution context with runId (converts reservation to full context)
      const context: ExecutionContext = {
        id: subagent.id,
        chatId: chat.id,
        type: "subagent",
        threadId,
        runId,
        cwd,
        abortController: new AbortController(),
      };
      this.registry.set(context);

      // Initialize message accumulator with size tracking
      this.messageAccumulator.set(threadId, []);
      this.accumulatorSizes.set(threadId, 0);
    } catch (err) {
      console.error("[Runner] Failed to execute subagent:", err);
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      this.store.updateSubagent(subagent.id, {
        status: "failed",
        error: errorMessage,
      });
      if (threadId) {
        this.messageAccumulator.delete(threadId);
        this.accumulatorSizes.delete(threadId);
      }
      // Clean up both reservation and full context (one will exist)
      this.registry.releaseReservation(subagent.id);
      this.registry.delete(subagent.id);
    }
  };

  /**
   * Execute a batch of attempts in parallel.
   */
  executeAttemptBatch = async (
    attempts: Attempt[],
    task: string,
    parentSummary: string
  ): Promise<void> => {
    // Reject execution during shutdown
    if (this.stopping) {
      console.warn("[Runner] Cannot execute attempts during shutdown");
      for (const attempt of attempts) {
        this.store.updateAttempt(attempt.id, {
          status: "completed",
          result: "[FAILED] Runner is shutting down",
          error: "Runner is shutting down",
        });
      }
      return;
    }

    // Validate task length
    if (task.length > MAX_TASK_LENGTH) {
      const taskError = `Task too large: ${task.length} bytes exceeds ${MAX_TASK_LENGTH} limit`;
      console.error(
        `[Runner] Task too large for attempt batch: ${task.length} bytes`
      );
      for (const attempt of attempts) {
        this.store.updateAttempt(attempt.id, {
          status: "completed",
          result: `[FAILED] ${taskError}`,
          error: taskError,
        });
      }
      return;
    }

    // All attempts must belong to same chat (enforced by caller)
    const firstAttempt = attempts[0];
    if (!firstAttempt) {
      return;
    }

    // Atomically reserve slots for entire batch to prevent TOCTOU races
    const reserved = this.registry.tryReserveBatch(
      attempts.map((a) => a.id),
      firstAttempt.chatId,
      MAX_REGISTRY_SIZE,
      MAX_CONCURRENT_PER_CHAT
    );
    if (!reserved) {
      console.error(
        `[Runner] Registry or concurrency limit would be exceeded for chat ${firstAttempt.chatId}`
      );
      for (const attempt of attempts) {
        this.store.updateAttempt(attempt.id, {
          status: "completed",
          result: "[FAILED] Registry or concurrency limit exceeded",
          error: "Registry or concurrency limit exceeded",
        });
      }
      return;
    }

    const prompt = parentSummary
      ? `Context from parent conversation:\n${parentSummary}\n\nTask:\n${task}`
      : task;

    const forkPromises = attempts.map(async (attempt) => {
      const chat = this.store.getChat(attempt.chatId);
      if (!chat) {
        console.error(`[Runner] Chat not found for attempt: ${attempt.chatId}`);
        this.store.updateAttempt(attempt.id, {
          status: "completed",
          result: "[FAILED] Parent chat not found",
          error: "Parent chat not found",
        });
        this.registry.releaseReservation(attempt.id);
        return;
      }

      if (!chat.codexThreadId) {
        console.error(`[Runner] Parent chat has no codexThreadId: ${chat.id}`);
        this.store.updateAttempt(attempt.id, {
          status: "completed",
          result: "[FAILED] Parent chat has no thread ID",
          error: "Parent chat has no thread ID",
        });
        this.registry.releaseReservation(attempt.id);
        return;
      }

      const cwd = this.resolveWorkspaceCwd(chat.id);
      let forkedThreadId: string | undefined;

      try {
        // Fork the parent thread
        const forkResponse: ThreadForkResponse = await this.adapter.forkThread(
          chat.codexThreadId,
          { cwd }
        );
        forkedThreadId = forkResponse.thread.id;

        // Update attempt with the new thread ID
        this.store.updateAttempt(attempt.id, { codexThreadId: forkedThreadId });

        // Send the turn first to get runId before registering context
        // This avoids a race condition where events could arrive for a context without runId
        // Pass cwd directly to sendTurn to avoid race condition with concurrent workspace executions
        const runId = await this.adapter.sendTurn(forkedThreadId, prompt, {
          cwd,
        });

        // Register the execution context with runId (converts reservation to full context)
        const context: ExecutionContext = {
          id: attempt.id,
          chatId: chat.id,
          type: "attempt",
          threadId: forkedThreadId,
          runId,
          cwd,
          abortController: new AbortController(),
        };
        this.registry.set(context);

        // Initialize message accumulator with size tracking
        this.messageAccumulator.set(forkedThreadId, []);
        this.accumulatorSizes.set(forkedThreadId, 0);
      } catch (err) {
        console.error(
          `[Runner] Failed to fork/execute attempt ${attempt.id}:`,
          err
        );
        const errorMessage =
          err instanceof Error ? err.message : "Unknown error";
        this.store.updateAttempt(attempt.id, {
          status: "completed",
          result: `[FAILED] ${errorMessage}`,
          error: errorMessage,
        });
        if (forkedThreadId) {
          this.messageAccumulator.delete(forkedThreadId);
          this.accumulatorSizes.delete(forkedThreadId);
        }
        // Clean up both reservation and full context (one will exist)
        this.registry.releaseReservation(attempt.id);
        this.registry.delete(attempt.id);
      }
    });

    await Promise.all(forkPromises);
  };

  /**
   * Cancel an active execution by context ID.
   */
  cancel = async (contextId: string): Promise<void> => {
    const context = this.registry.get(contextId);
    if (!context) {
      console.warn(`[Runner] Unknown context ID for cancel: ${contextId}`);
      return;
    }

    // Abort the controller
    context.abortController.abort();

    // Cancel via adapter if we have a runId
    if (context.runId) {
      try {
        await this.adapter.cancel(context.runId);
      } catch (err) {
        console.warn(`[Runner] Failed to cancel run ${context.runId}:`, err);
      }
    }

    // Update store status
    if (context.type === "subagent") {
      this.store.updateSubagent(contextId, { status: "cancelled" });
    } else if (context.type === "attempt") {
      this.store.updateAttempt(contextId, { status: "discarded" });
    }

    // Clean up
    this.messageAccumulator.delete(context.threadId);
    this.accumulatorSizes.delete(context.threadId);
    this.registry.delete(contextId);
  };

  /**
   * Handle incoming Codex events and route to store updates.
   */
  private readonly handleEvent = (event: CodexEvent): void => {
    // Ignore events during shutdown
    if (this.stopping) {
      return;
    }

    const threadId = event.threadId;
    if (typeof threadId !== "string") {
      return;
    }

    const context = this.registry.getByThreadId(threadId);
    if (!context) {
      // Unknown thread - might be from a different session
      return;
    }

    // Skip processing for aborted contexts
    if (context.abortController.signal.aborted) {
      return;
    }

    try {
      this.processEvent(event, context);
    } catch (err) {
      console.error("[Runner] Unhandled error processing event:", err);
      // Attempt graceful cleanup on error
      try {
        this.completeExecution(context, "failed", "Internal runner error");
      } catch {
        // Last resort cleanup without store updates
        this.cleanupContext(context);
      }
    }
  };

  /**
   * Process a single event for a known context.
   */
  private readonly processEvent = (
    event: CodexEvent,
    context: ExecutionContext
  ): void => {
    const eventType = event.type;

    // Handle agent message deltas - accumulate for final result
    if (eventType === "item/agentMessage/delta") {
      const delta = event.delta as string | undefined;
      if (delta) {
        const currentSize = this.accumulatorSizes.get(context.threadId) ?? 0;
        const newSize = currentSize + delta.length;

        // Enforce size limit to prevent unbounded memory growth
        if (newSize > MAX_ACCUMULATED_MESSAGE_SIZE) {
          console.warn(
            `[Runner] Message accumulator size limit exceeded for thread ${context.threadId}`
          );
          return;
        }

        const chunks = this.messageAccumulator.get(context.threadId);
        if (chunks) {
          chunks.push(delta);
        }
        this.accumulatorSizes.set(context.threadId, newSize);
      }
      return;
    }

    // Handle turn completion
    if (eventType === "turn/completed") {
      const chunks = this.messageAccumulator.get(context.threadId);
      const accumulatedResult =
        chunks && chunks.length > 0 ? chunks.join("") : null;
      this.completeExecution(context, "completed", accumulatedResult);
      return;
    }

    // Handle errors
    if (eventType === "error") {
      const errorMessage =
        (event.message as string) ?? (event.error as string) ?? "Unknown error";
      console.error(`[Runner] Error for ${context.id}:`, errorMessage);
      this.completeExecution(context, "failed", errorMessage);
      return;
    }

    // Handle attempt pick event (from MCP tool)
    if (eventType === "attempt_pick") {
      const pickedAttemptId = event.attemptId as string | undefined;
      if (pickedAttemptId) {
        this.handleAttemptPick(context.chatId, pickedAttemptId);
      }
    }
  };

  /**
   * Cleanup context state without store updates (for error recovery).
   */
  private readonly cleanupContext = (context: ExecutionContext): void => {
    this.messageAccumulator.delete(context.threadId);
    this.accumulatorSizes.delete(context.threadId);
    this.registry.delete(context.id);
  };

  /**
   * Handle approval requests - auto-approve all for v1.
   */
  private readonly handleApproval = (request: ApprovalRequest): void => {
    // Auto-approve all requests for v1
    // Both CommandExecution and FileChange use "accept" as the approval decision
    const response = { decision: "accept" as const };

    const success = this.adapter.respondToApproval(request.token, response);
    if (!success) {
      console.warn(
        `[Runner] Failed to respond to approval request: ${request.token}`
      );
    }
  };

  /**
   * Handle attempt pick - cancel non-picked attempts.
   */
  private readonly handleAttemptPick = (
    chatId: string,
    pickedAttemptId: string
  ): void => {
    const contexts = this.registry.getAllByChatId(chatId);

    for (const context of contexts) {
      if (context.type !== "attempt") {
        continue;
      }

      if (context.id === pickedAttemptId) {
        // Mark as picked
        this.store.updateAttempt(context.id, { status: "picked" });
      } else {
        // Cancel non-picked attempts
        this.cancel(context.id).catch((err) => {
          console.warn(`[Runner] Failed to cancel attempt ${context.id}:`, err);
        });
      }
    }
  };

  /**
   * Truncate result if it exceeds MAX_RESULT_SIZE.
   */
  private readonly truncateResult = (result: string | null): string | null => {
    if (result === null) {
      return null;
    }
    if (result.length <= MAX_RESULT_SIZE) {
      return result;
    }
    console.warn(
      `[Runner] Truncating result from ${result.length} to ${MAX_RESULT_SIZE} characters`
    );
    return `${result.slice(0, MAX_RESULT_SIZE - 12)} [TRUNCATED]`;
  };

  /**
   * Complete an execution and update the store.
   */
  private readonly completeExecution = (
    context: ExecutionContext,
    status: "completed" | "failed",
    result: string | null
  ): void => {
    if (context.type === "subagent") {
      const truncatedResult = this.truncateResult(result);
      this.store.updateSubagent(context.id, {
        status: status === "completed" ? "completed" : "failed",
        result: truncatedResult,
        error: status === "failed" ? truncatedResult : null,
      });
    } else if (context.type === "attempt") {
      // Attempts use "completed" for both success and failure - result contains error info if failed
      // Result and error are truncated separately since result has [FAILED] prefix
      const rawResult = status === "failed" ? `[FAILED] ${result}` : result;
      this.store.updateAttempt(context.id, {
        status: "completed",
        result: this.truncateResult(rawResult),
        error: status === "failed" ? this.truncateResult(result) : null,
      });
    }

    // Cleanup
    this.messageAccumulator.delete(context.threadId);
    this.accumulatorSizes.delete(context.threadId);
    this.registry.delete(context.id);
  };

  /**
   * Resolve the working directory for a chat's workspace.
   */
  private readonly resolveWorkspaceCwd = (chatId: string): string => {
    const chat = this.store.getChat(chatId);
    if (!chat) {
      // Fallback to current directory
      return process.cwd();
    }

    const workspace = this.store.getWorkspace(chat.workspaceId);
    if (!workspace) {
      // Fallback to current directory
      return process.cwd();
    }

    return workspace.path;
  };

  /**
   * Get all active execution contexts.
   */
  private readonly getAllActiveContexts = (): ExecutionContext[] => {
    return Array.from(this.registry.values());
  };
}

/**
 * Factory function to create a Runner instance.
 */
export const createRunner = (config: RunnerConfig): Runner =>
  new Runner(config);
