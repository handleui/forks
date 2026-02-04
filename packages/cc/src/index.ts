/** @forks-sh/cc - Claude Code adapter */

import type { CCBackend, SessionStartOpts } from "./backend/interface.js";
import { createCCStreamBackend } from "./backend/stream-client.js";
import { getClaudeBinaryPath as _getClaudeBinaryPath } from "./binary.js";
import type {
  CCAdapterOptions as AdapterOptions,
  AdapterStatus,
  CCAdapter,
  CCEvent,
  CCPermissionMode,
  CCThread,
  ProcessExitInfo,
  RunId,
  RunResult,
  SendTurnOpts,
  ThreadStartOpts,
} from "./types.js";
import {
  CCPermissionModeSchema as _CCPermissionModeSchema,
  CCPermissionModeValues as _CCPermissionModeValues,
} from "./types.js";

/** Get the path to the claude binary */
export const getClaudeBinaryPath = _getClaudeBinaryPath;

/** Zod schema for CCPermissionMode validation */
export const CCPermissionModeSchema = _CCPermissionModeSchema;

/** Array of valid CCPermissionMode values */
export const CCPermissionModeValues = _CCPermissionModeValues;

export type {
  AdapterStatus,
  CCAdapter,
  CCAdapterOptions,
  CCEvent,
  CCPermissionMode,
  CCThread,
  CCUsage,
  ProcessExitInfo,
  RunId,
  RunResult,
  SendTurnOpts,
  ThreadStartOpts,
} from "./types.js";

class CCAdapterImpl implements CCAdapter {
  private backend: CCBackend | null = null;
  private readonly options: AdapterOptions;
  private readonly eventCallbacks = new Set<(event: CCEvent) => void>();
  private readonly exitCallbacks = new Set<(info: ProcessExitInfo) => void>();
  private readonly activeRuns = new Map<
    RunId,
    { threadId: string; turnId: string }
  >();
  private readonly threads = new Map<string, string>(); // tempId → sessionId
  private runIdCounter = 0;
  private threadIdCounter = 0;
  private workingDirectory: string | null = null;
  private baseInstructions: string | null = null;
  private permissionMode: CCPermissionMode | null = null;
  private initPromise: Promise<void> | null = null;
  private unsubscribeNotification: (() => void) | null = null;
  private unsubscribeExit: (() => void) | null = null;
  // Reverse lookup: turnId → runId for cleanup on turn completion
  private readonly turnToRunId = new Map<string, RunId>();

  constructor(options: AdapterOptions = {}) {
    this.options = options;
  }

  initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    this.backend = createCCStreamBackend({
      claudePath: this.options.claudePathOverride,
      model: this.options.model,
      systemPrompt: this.options.systemPrompt,
      appendSystemPrompt: this.options.appendSystemPrompt,
      maxTurns: this.options.maxTurns,
      env: this.options.env,
    });

    await this.backend.initialize();

    this.unsubscribeNotification = this.backend.onNotification(
      (event: CCEvent) => {
        // Clean up activeRuns when turn completes or errors
        if (event.type === "turn/completed" || event.type === "turn/error") {
          const turnId = event.turnId;
          // Type guard: turnId must be a string for Map lookup
          if (typeof turnId === "string") {
            const runId = this.turnToRunId.get(turnId);
            if (runId) {
              this.activeRuns.delete(runId);
              this.turnToRunId.delete(turnId);
            }
          }
        }
        this.emitEvent(event);
      }
    );

    this.unsubscribeExit = this.backend.onExit((info: ProcessExitInfo) => {
      for (const callback of this.exitCallbacks) {
        try {
          callback(info);
        } catch {
          // Ignore callback errors
        }
      }
    });
  }

  async shutdown(): Promise<void> {
    if (this.unsubscribeNotification) {
      this.unsubscribeNotification();
      this.unsubscribeNotification = null;
    }

    if (this.unsubscribeExit) {
      this.unsubscribeExit();
      this.unsubscribeExit = null;
    }

    this.activeRuns.clear();
    this.turnToRunId.clear();
    this.threads.clear();
    this.eventCallbacks.clear();
    this.exitCallbacks.clear();

    if (this.backend) {
      await this.backend.shutdown();
      this.backend = null;
    }

    this.initPromise = null;
  }

  private async ensureInitialized(): Promise<CCBackend> {
    if (!this.backend) {
      await this.initialize();
    }
    if (!this.backend) {
      throw new Error("Failed to initialize backend");
    }
    return this.backend;
  }

  startThread(opts?: ThreadStartOpts): CCThread {
    if (opts?.baseInstructions !== undefined) {
      this.baseInstructions = opts.baseInstructions;
    }
    if (opts?.permissionMode !== undefined) {
      this.permissionMode = opts.permissionMode;
    }
    const tempId = `thread-${this.threadIdCounter++}`;
    return {
      get id(): string | null {
        return tempId;
      },
    };
  }

  async sendTurn(
    threadId: string,
    input: string,
    opts?: SendTurnOpts
  ): Promise<RunId> {
    const backend = await this.ensureInitialized();
    const runId = `run-${this.runIdCounter++}`;

    const sessionId = await this.getOrCreateSession(backend, threadId);
    const cwd = opts?.cwd ?? this.workingDirectory;

    const turnResponse = await backend.startTurn(sessionId, input, {
      cwd,
      model: opts?.model,
      maxTurns: opts?.maxTurns,
      permissionMode: opts?.permissionMode ?? this.permissionMode,
    });

    this.activeRuns.set(runId, {
      threadId: sessionId,
      turnId: turnResponse.turnId,
    });
    this.turnToRunId.set(turnResponse.turnId, runId);

    return runId;
  }

  private async getOrCreateSession(
    backend: CCBackend,
    threadId: string
  ): Promise<string> {
    const existingSessionId = this.threads.get(threadId);
    if (existingSessionId) {
      return existingSessionId;
    }

    const sessionOpts: SessionStartOpts = {
      cwd: this.workingDirectory,
      baseInstructions: this.baseInstructions,
    };

    const response = await backend.startSession(sessionOpts);
    this.threads.set(threadId, response.sessionId);
    return response.sessionId;
  }

  async run(threadId: string, input: string): Promise<RunResult> {
    const backend = await this.ensureInitialized();
    const sessionId = await this.getOrCreateSession(backend, threadId);

    const items: unknown[] = [];
    let finalResponse = "";
    let usage: RunResult["usage"] = null;

    const turnResponse = await backend.startTurn(sessionId, input, {
      cwd: this.workingDirectory,
    });

    const { turnId } = turnResponse;

    return new Promise<RunResult>((resolve, reject) => {
      const collectEvents = (event: CCEvent): void => {
        // Only collect events for this specific turn
        if (event.turnId !== turnId) {
          return;
        }

        items.push(event);

        if (
          event.type === "item/agentMessage/delta" &&
          typeof event.delta === "string"
        ) {
          finalResponse += event.delta;
        }

        if (event.type === "turn/completed") {
          this.eventCallbacks.delete(collectEvents);
          usage = event.usage ?? null;
          resolve({
            items,
            finalResponse,
            usage,
          });
        }

        if (event.type === "turn/error") {
          this.eventCallbacks.delete(collectEvents);
          reject(new Error(event.error ?? "Turn failed"));
        }
      };

      this.eventCallbacks.add(collectEvents);
    });
  }

  onEvent(callback: (event: CCEvent) => void): () => void {
    this.eventCallbacks.add(callback);
    return () => {
      this.eventCallbacks.delete(callback);
    };
  }

  onExit(callback: (info: ProcessExitInfo) => void): () => void {
    this.exitCallbacks.add(callback);
    return () => {
      this.exitCallbacks.delete(callback);
    };
  }

  async cancel(runId: string): Promise<void> {
    const runInfo = this.activeRuns.get(runId);
    if (!runInfo) {
      // Run not found - could be already completed
      return;
    }

    try {
      const backend = await this.ensureInitialized();
      await backend.interruptTurn(runInfo.threadId);
    } finally {
      this.activeRuns.delete(runId);
      this.turnToRunId.delete(runInfo.turnId);
    }
  }

  closeThread(threadId: string): void {
    this.threads.delete(threadId);
  }

  async getStatus(): Promise<AdapterStatus> {
    try {
      await this.ensureInitialized();
      // Claude Code uses Anthropic API key auth (handled by claude CLI)
      return {
        installed: true,
        authenticated: true,
        ready: true,
      };
    } catch {
      return {
        installed: false,
        authenticated: false,
        ready: false,
      };
    }
  }

  setWorkingDirectory(cwd: string): void {
    this.workingDirectory = cwd;
  }

  private emitEvent(event: CCEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch {
        // Ignore callback errors
      }
    }
  }
}

export const createCCAdapter = (options: AdapterOptions = {}): CCAdapter =>
  new CCAdapterImpl(options);
