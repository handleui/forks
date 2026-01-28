/** @forks-sh/runner – core execution orchestrator */

import type {
  ApprovalRequest,
  CodexAdapter,
  CodexEvent,
} from "@forks-sh/codex";
import {
  type AttemptWorktreeManager,
  createAttemptWorktreeManager,
} from "@forks-sh/git/attempt-worktree-manager";
import type { Attempt, Subagent } from "@forks-sh/store";

import { ExecutionRegistry } from "./registry.js";
import { SessionApprovalCache } from "./session-approvals.js";
import type { ExecutionContext, RunnerConfig } from "./types.js";

/** Approval decision type for pending approvals */
type ApprovalDecision = "accept" | "acceptForSession" | "decline";

/** Pending approval state */
interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  chatId: string;
  token: string;
  threadId: string;
}

const STOP_TIMEOUT_MS = 5000;
const MAX_CONCURRENT_PER_CHAT = 10;
const MAX_ACCUMULATED_MESSAGE_SIZE = 1024 * 1024; // 1MB per thread
const MAX_DIFF_SIZE = 5 * 1024 * 1024; // 5MB max diff size per thread
const MAX_TASK_LENGTH = 100_000; // 100KB max task description
const MAX_RESULT_SIZE = 1024 * 1024; // 1MB max result size
const MAX_REGISTRY_SIZE = 1000; // Global limit on tracked executions

/**
 * Runner orchestrates the execution of subagents and attempt batches.
 * It bridges the Codex adapter with the persistence store.
 *
 * Approval flow:
 * - Command execution and file change requests are persisted to DB
 * - UI is notified via WebSocket and user responds via HTTP endpoint
 * - Session-level cache supports "accept for session" to avoid repeated prompts
 * - All threads share the session cache, so subagents inherit parent approvals
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

  // Accumulator for turn diffs by thread (overwrites with full aggregated diff each time)
  private readonly turnDiffs: Map<string, string> = new Map();

  // Pending approvals awaiting user response
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  // Session-level approval cache for "accept for session" decisions
  // Shared across all threads, so subagents inherit parent's approvals
  private readonly sessionApprovals = new SessionApprovalCache();

  // Worktree manager for parallel attempts
  private readonly attemptWorktreeManager: AttemptWorktreeManager =
    createAttemptWorktreeManager();

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

    // Decline all pending approvals on shutdown
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve("decline");
    }
    this.pendingApprovals.clear();

    // Clear all state
    this.messageAccumulator.clear();
    this.accumulatorSizes.clear();
    this.turnDiffs.clear();
    this.registry.clear();
    this.sessionApprovals.clear();

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
        this.turnDiffs.delete(threadId);
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

    const forkPromises = attempts.map((attempt) =>
      this.executeSingleAttempt(attempt, prompt)
    );

    await Promise.all(forkPromises);
  };

  /**
   * Execute a single attempt with worktree isolation.
   */
  private readonly executeSingleAttempt = async (
    attempt: Attempt,
    prompt: string
  ): Promise<void> => {
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

    const workspace = this.store.getWorkspace(chat.workspaceId);
    if (!workspace) {
      console.error(
        `[Runner] Workspace not found for attempt: ${chat.workspaceId}`
      );
      this.store.updateAttempt(attempt.id, {
        status: "completed",
        result: "[FAILED] Workspace not found",
        error: "Workspace not found",
      });
      this.registry.releaseReservation(attempt.id);
      return;
    }

    let forkedThreadId: string | undefined;
    let worktreePath: string | undefined;
    let worktreeBranch: string | undefined;

    try {
      // Create a worktree for this attempt
      const worktreeResult = await this.attemptWorktreeManager.create(
        attempt.id,
        workspace
      );
      worktreePath = worktreeResult.path;
      worktreeBranch = worktreeResult.branch;

      // Update attempt with worktree info and mark as running
      this.store.updateAttempt(attempt.id, {
        worktreePath,
        branch: worktreeBranch,
        status: "running",
      });

      // Use the worktree path as cwd for the forked thread
      const cwd = worktreePath;

      // Fork the parent thread
      const forkResponse = await this.adapter.forkThread(chat.codexThreadId, {
        cwd,
      });
      forkedThreadId = forkResponse.thread.id;

      // Update attempt with the new thread ID
      this.store.updateAttempt(attempt.id, { codexThreadId: forkedThreadId });

      // Send the turn first to get runId before registering context
      const runId = await this.adapter.sendTurn(forkedThreadId, prompt, {
        cwd,
      });

      // Register the execution context with runId
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
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      this.store.updateAttempt(attempt.id, {
        status: "completed",
        result: `[FAILED] ${errorMessage}`,
        error: errorMessage,
      });
      this.cleanupFailedAttempt(
        attempt.id,
        forkedThreadId,
        worktreePath,
        worktreeBranch,
        workspace.path
      );
    }
  };

  /**
   * Clean up resources after a failed attempt execution.
   */
  private readonly cleanupFailedAttempt = async (
    attemptId: string,
    forkedThreadId: string | undefined,
    worktreePath: string | undefined,
    worktreeBranch: string | undefined,
    repoPath: string
  ): Promise<void> => {
    if (forkedThreadId) {
      this.messageAccumulator.delete(forkedThreadId);
      this.accumulatorSizes.delete(forkedThreadId);
      this.turnDiffs.delete(forkedThreadId);
    }
    if (worktreePath && worktreeBranch) {
      try {
        await this.attemptWorktreeManager.cleanup(
          worktreePath,
          worktreeBranch,
          repoPath
        );
      } catch (cleanupErr) {
        console.warn(
          `[Runner] Failed to cleanup worktree for attempt ${attemptId}:`,
          cleanupErr
        );
      }
    }
    this.registry.releaseReservation(attemptId);
    this.registry.delete(attemptId);
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
    this.turnDiffs.delete(context.threadId);
    this.registry.delete(contextId);
    // Cleanup any pending approvals for this thread
    this.cleanupPendingApprovalsForThread(context.threadId);
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
   * Accumulate a message delta for a thread.
   * Returns true if accumulated, false if size limit exceeded.
   */
  private readonly accumulateMessageDelta = (
    threadId: string,
    delta: string
  ): boolean => {
    const currentSize = this.accumulatorSizes.get(threadId) ?? 0;
    const newSize = currentSize + delta.length;

    if (newSize > MAX_ACCUMULATED_MESSAGE_SIZE) {
      console.warn(
        `[Runner] Message accumulator size limit exceeded for thread ${threadId}`
      );
      return false;
    }

    const chunks = this.messageAccumulator.get(threadId);
    if (chunks) {
      chunks.push(delta);
    }
    this.accumulatorSizes.set(threadId, newSize);
    return true;
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
        this.accumulateMessageDelta(context.threadId, delta);
      }
      return;
    }

    // Handle turn diff updates - overwrite with full aggregated diff (with size limit)
    if (eventType === "turn/diff/updated") {
      const diff = event.diff as string | undefined;
      if (diff) {
        if (diff.length > MAX_DIFF_SIZE) {
          console.warn(
            `[Runner] Diff size limit exceeded for thread ${context.threadId}: ${diff.length} bytes`
          );
          // Truncate diff to fit within limit
          this.turnDiffs.set(
            context.threadId,
            `${diff.slice(0, MAX_DIFF_SIZE - 50)}\n\n[DIFF TRUNCATED - exceeded ${MAX_DIFF_SIZE} bytes]`
          );
        } else {
          this.turnDiffs.set(context.threadId, diff);
        }
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
    this.turnDiffs.delete(context.threadId);
    this.registry.delete(context.id);
    // Cleanup any pending approvals for this thread
    this.cleanupPendingApprovalsForThread(context.threadId);
  };

  /**
   * Cleanup pending approvals associated with a thread.
   * Declines them to unblock the handleApproval promise.
   */
  private readonly cleanupPendingApprovalsForThread = (
    threadId: string
  ): void => {
    for (const [token, pending] of this.pendingApprovals) {
      if (pending.threadId === threadId) {
        pending.resolve("decline");
        this.pendingApprovals.delete(token);
        // Cancel the approval in the store
        const approval = this.store.getApprovalByToken(token);
        if (approval?.status === "pending") {
          this.store.cancelApproval(approval.id);
        }
      }
    }
  };

  /**
   * Handle approval requests - persist to DB and wait for user response.
   * Wrapped to catch async errors since this is registered as a sync callback.
   */
  private readonly handleApproval = (request: ApprovalRequest): void => {
    this.handleApprovalAsync(request).catch((error) => {
      console.error("[Runner] Approval handler error:", error);
      this.adapter.respondToApproval(request.token, { decision: "decline" });
    });
  };

  private readonly handleApprovalAsync = async (
    request: ApprovalRequest
  ): Promise<void> => {
    const { token, type, params } = request;
    const cmd =
      type === "commandExecution" ? (params.command as string) : undefined;
    const cwd =
      type === "commandExecution" ? (params.cwd as string) : undefined;

    // 1. Check session cache first
    if (this.sessionApprovals.isApprovedForSession(type, cmd, cwd)) {
      this.adapter.respondToApproval(token, { decision: "accept" });
      return;
    }

    // 2. Find chat from threadId
    const threadId = params.threadId as string | undefined;
    if (!threadId) {
      console.warn("[Runner] No threadId in approval request");
      this.adapter.respondToApproval(token, { decision: "decline" });
      return;
    }

    const context = this.registry.getByThreadId(threadId);
    if (!context) {
      console.warn("[Runner] Unknown thread for approval:", threadId);
      this.adapter.respondToApproval(token, { decision: "decline" });
      return;
    }

    // 3. Create approval in store (emits "requested" event via WebSocket)
    try {
      this.store.createApproval(context.chatId, token, type, {
        threadId,
        turnId: (params.turnId as string) ?? "",
        itemId: (params.itemId as string) ?? "",
        command: cmd ?? null,
        cwd: cwd ?? null,
        reason: (params.reason as string) ?? null,
        data: params,
      });
    } catch (error) {
      console.error("[Runner] Failed to create approval in store:", error);
      this.adapter.respondToApproval(token, { decision: "decline" });
      return;
    }

    // 4. Wait indefinitely for user response
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.pendingApprovals.set(token, {
        resolve,
        chatId: context.chatId,
        token,
        threadId,
      });
    });

    // 5. Handle session approval
    if (decision === "acceptForSession") {
      this.sessionApprovals.markApprovedForSession(type, cmd, cwd);
    }

    // 6. Update store with response (already handled by HTTP endpoint)
    // The HTTP endpoint calls respondToApproval which emits accepted/declined events

    // 7. Respond to Codex
    const codexDecision = decision === "decline" ? "decline" : "accept";
    const success = this.adapter.respondToApproval(token, {
      decision: codexDecision,
    });
    if (!success) {
      console.warn(`[Runner] Failed to respond to approval request: ${token}`);
    }
  };

  /**
   * Notify runner that a user has responded to an approval.
   * Called by the HTTP endpoint.
   */
  notifyApprovalResponse = (
    token: string,
    decision: ApprovalDecision
  ): boolean => {
    const pending = this.pendingApprovals.get(token);
    if (!pending) {
      return false;
    }
    pending.resolve(decision);
    this.pendingApprovals.delete(token);
    return true;
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
      // Store structured result as JSON for attempts
      const diff = this.turnDiffs.get(context.threadId) ?? null;

      if (status === "failed") {
        const rawResult = `[FAILED] ${result}`;
        this.store.updateAttempt(context.id, {
          status: "completed",
          result: this.truncateResult(rawResult),
          error: this.truncateResult(result),
        });
      } else {
        // Store structured AttemptResult as JSON
        const attemptResult = {
          summary: result ?? "",
          unifiedDiff: diff,
        };
        this.store.updateAttempt(context.id, {
          status: "completed",
          result: this.truncateResult(JSON.stringify(attemptResult)),
          error: null,
        });
      }
    }

    // Cleanup
    this.messageAccumulator.delete(context.threadId);
    this.accumulatorSizes.delete(context.threadId);
    this.turnDiffs.delete(context.threadId);
    this.registry.delete(context.id);
    // Cleanup any pending approvals for this thread
    this.cleanupPendingApprovalsForThread(context.threadId);
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
