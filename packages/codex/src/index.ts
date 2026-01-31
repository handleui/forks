/** @forks-sh/codex – Codex adapter */

import { createAppServerBackend } from "./backend/app-server.js";
import type {
  ApprovalRequest,
  ApprovalResponse,
  AuthStatus,
  CodexBackend,
  ExecResult,
  LoginResult,
  Notification,
  ThreadForkResponse,
} from "./backend/interface.js";
import type { SandboxPolicy, UserInput } from "./protocol/v2/index.js";
import type {
  CodexAdapterOptions as AdapterOptions,
  AdapterStatus,
  CodexAdapter,
  CodexEvent,
  CodexThread,
  RunId,
  RunResult,
  SendTurnOpts,
  ThreadStartOpts,
} from "./types.js";

export type {
  AdapterStatus,
  ApprovalCallback,
  ApprovalRequest,
  ApprovalResponse,
  AuthStatus,
  CodexAdapter,
  CodexAdapterOptions,
  CodexEvent,
  CodexThread,
  CollaborationMode,
  CommandExecutionApprovalRequest,
  ExecOpts,
  ExecResult,
  FileChangeApprovalRequest,
  LoginCompleteEvent,
  LoginResult,
  ProcessExitInfo,
  RunId,
  RunResult,
  SendTurnOpts,
  ThreadForkOpts,
  ThreadForkResponse,
  ThreadStartOpts,
} from "./types.js";

const EXTERNAL_SANDBOX_POLICY: SandboxPolicy = {
  type: "externalSandbox",
  networkAccess: "enabled",
};

const CLIENT_INFO = {
  name: "forks-conductor",
  title: "Forks Conductor",
  version: "0.0.1",
};

class CodexAdapterImpl implements CodexAdapter {
  private backend: CodexBackend | null = null;
  private readonly options: AdapterOptions;
  private readonly eventCallbacks: Set<(event: CodexEvent) => void> = new Set();
  private readonly activeRuns: Map<
    RunId,
    { threadId: string; turnId: string }
  > = new Map();
  private readonly threads: Map<string, string> = new Map();
  private runIdCounter = 0;
  private threadIdCounter = 0;
  private workingDirectory: string | null = null;
  private baseInstructions: string | null = null;
  private initPromise: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;

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
    this.backend = createAppServerBackend({
      codexPath: this.options.codexPathOverride,
      env: this.options.env,
    });

    await this.backend.initialize(CLIENT_INFO);

    this.unsubscribe = this.backend.onNotification(
      (notification: Notification) => {
        const event = this.mapNotificationToEvent(notification);
        this.emitEvent(event);
      }
    );
  }

  async shutdown(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    // Clear active runs
    this.activeRuns.clear();

    // Clear thread mappings
    this.threads.clear();

    // Clear event callbacks
    this.eventCallbacks.clear();

    // Shutdown the backend
    if (this.backend) {
      await this.backend.shutdown();
      this.backend = null;
    }

    // Reset init state
    this.initPromise = null;
  }

  private async ensureInitialized(): Promise<CodexBackend> {
    if (!this.backend) {
      await this.initialize();
    }
    if (!this.backend) {
      throw new Error("Failed to initialize backend");
    }
    return this.backend;
  }

  private mapNotificationToEvent(notification: Notification): CodexEvent {
    return {
      type: notification.method,
      ...notification.params,
    };
  }

  startThread(opts?: ThreadStartOpts): CodexThread {
    if (opts?.baseInstructions !== undefined) {
      this.baseInstructions = opts.baseInstructions;
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

    const realThreadId = await this.getOrCreateThread(backend, threadId);

    const skillInputs = (opts?.skills ?? []).map((skill) => ({
      type: "skill" as const,
      name: skill.name,
      path: skill.path,
    }));

    const userInput: UserInput[] = [
      ...skillInputs,
      { type: "text", text: input, text_elements: [] },
    ];

    // Use cwd from opts if provided, otherwise fall back to adapter-level workingDirectory
    const cwd = opts?.cwd ?? this.workingDirectory;

    const turnResponse = await backend.startTurn(realThreadId, userInput, {
      cwd,
      sandboxPolicy: EXTERNAL_SANDBOX_POLICY,
      collaborationMode: opts?.collaborationMode ?? null,
    });

    this.activeRuns.set(runId, {
      threadId: realThreadId,
      turnId: turnResponse.turn.id,
    });

    return runId;
  }

  private async getOrCreateThread(
    backend: CodexBackend,
    threadId: string
  ): Promise<string> {
    const existingThreadId = this.threads.get(threadId);
    if (existingThreadId) {
      return existingThreadId;
    }

    if (threadId.startsWith("thread-")) {
      const response = await backend.startThread({
        cwd: this.workingDirectory,
        baseInstructions: this.baseInstructions,
      });
      this.threads.set(threadId, response.thread.id);
      return response.thread.id;
    }

    const response = await backend.resumeThread(threadId, {
      cwd: this.workingDirectory,
      baseInstructions: this.baseInstructions,
    });
    this.threads.set(threadId, response.thread.id);
    return response.thread.id;
  }

  async run(threadId: string, input: string): Promise<RunResult> {
    const backend = await this.ensureInitialized();
    const realThreadId = await this.getOrCreateThread(backend, threadId);

    const userInput: UserInput[] = [
      { type: "text", text: input, text_elements: [] },
    ];

    const items: unknown[] = [];
    let finalResponse = "";

    const collectEvents = (event: CodexEvent): void => {
      items.push(event);
      if (
        event.type === "item/agentMessage/delta" &&
        typeof event.delta === "string"
      ) {
        finalResponse += event.delta;
      }
    };

    this.eventCallbacks.add(collectEvents);

    try {
      await backend.startTurn(realThreadId, userInput, {
        cwd: this.workingDirectory,
        sandboxPolicy: EXTERNAL_SANDBOX_POLICY,
      });

      return {
        items,
        finalResponse,
        usage: null,
      };
    } finally {
      this.eventCallbacks.delete(collectEvents);
    }
  }

  onEvent(callback: (event: CodexEvent) => void): () => void {
    this.eventCallbacks.add(callback);
    return () => {
      this.eventCallbacks.delete(callback);
    };
  }

  onApprovalRequest(callback: (request: ApprovalRequest) => void): () => void {
    if (!this.backend) {
      throw new Error("Backend not initialized. Call initialize() first.");
    }
    return this.backend.onApprovalRequest(callback);
  }

  onExit(
    callback: (info: { code: number | null; error?: string }) => void
  ): () => void {
    if (!this.backend) {
      throw new Error("Backend not initialized. Call initialize() first.");
    }
    return this.backend.onExit(callback);
  }

  respondToApproval(token: string, response: ApprovalResponse): boolean {
    if (!this.backend) {
      throw new Error("Backend not initialized. Call initialize() first.");
    }
    return this.backend.respondToApproval(token, response);
  }

  async cancel(runId: string): Promise<void> {
    const runInfo = this.activeRuns.get(runId);
    if (!runInfo) {
      // Run not found - could be already completed or never started
      // This is a graceful no-op, not an error
      return;
    }

    try {
      const backend = await this.ensureInitialized();
      await backend.interruptTurn(runInfo.threadId, runInfo.turnId);
    } finally {
      // Always remove from active runs, even if interrupt fails
      this.activeRuns.delete(runId);
    }
  }

  async getStatus(): Promise<AdapterStatus> {
    try {
      const backend = await this.ensureInitialized();
      const authStatus = await backend.checkAuth();

      return {
        installed: true,
        authenticated: authStatus.account !== null,
        ready: authStatus.account !== null && !authStatus.requiresOpenaiAuth,
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

  async checkAuth(): Promise<AuthStatus> {
    const backend = await this.ensureInitialized();
    return backend.checkAuth();
  }

  async startLogin(
    type: "apiKey" | "chatgpt",
    apiKey?: string
  ): Promise<LoginResult> {
    const backend = await this.ensureInitialized();
    return backend.startLogin(type, apiKey);
  }

  async forkThread(
    threadId: string,
    opts?: { cwd?: string | null }
  ): Promise<ThreadForkResponse> {
    const backend = await this.ensureInitialized();
    return backend.forkThread(threadId, { cwd: opts?.cwd ?? null });
  }

  async execCommand(
    cmd: string[],
    opts?: { cwd?: string | null; timeoutMs?: number | null }
  ): Promise<ExecResult> {
    const backend = await this.ensureInitialized();
    return backend.execCommand(cmd, {
      cwd: opts?.cwd ?? null,
      timeoutMs: opts?.timeoutMs ?? null,
    });
  }

  private emitEvent(event: CodexEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch {
        // Ignore callback errors
      }
    }
  }
}

export const createCodexAdapter = (
  options: AdapterOptions = {}
): CodexAdapter => new CodexAdapterImpl(options);
