import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ClientInfo } from "../protocol/ClientInfo.js";
import {
  type AppServerClient,
  type ClientOptions,
  createAppServerClient,
} from "../protocol/client.js";
import type { InitializeResponse } from "../protocol/InitializeResponse.js";
import type { ServerNotification } from "../protocol/ServerNotification.js";
import type {
  CommandExecParams,
  CommandExecResponse,
  GetAccountParams,
  GetAccountResponse,
  LoginAccountParams,
  LoginAccountResponse,
  SandboxPolicy,
  ThreadForkParams,
  ThreadForkResponse,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnInterruptParams,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  UserInput,
} from "../protocol/v2/index.js";
import type {
  AuthStatus,
  BackendOptions,
  CodexBackend,
  ExecOpts,
  ExecResult,
  LoginResult,
  Notification,
  ServerInfo,
  ThreadForkOpts,
  ThreadResumeOpts,
  ThreadStartOpts,
  TurnOpts,
} from "./interface.js";

const EXTERNAL_SANDBOX_POLICY: SandboxPolicy = {
  type: "externalSandbox",
  networkAccess: "enabled",
};

import type { ServerRequest } from "../protocol/ServerRequest.js";
import type {
  CommandExecutionRequestApprovalParams,
  FileChangeRequestApprovalParams,
} from "../protocol/v2/index.js";
import type {
  ApprovalCallback,
  ApprovalRequest,
  ApprovalResponse,
} from "./interface.js";

interface PendingApproval {
  internalId: number;
  token: string;
  resolve: (response: ApprovalResponse) => void;
  timeoutId: NodeJS.Timeout;
}

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const APPROVAL_TOKEN_BYTES = 32; // 256 bits of entropy

const generateApprovalToken = (): string =>
  randomBytes(APPROVAL_TOKEN_BYTES).toString("base64url");

const safeTokenCompare = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return timingSafeEqual(bufA, bufB);
};

class AppServerBackendImpl implements CodexBackend {
  private readonly client: AppServerClient;
  private initialized = false;
  private readonly approvalCallbacks = new Set<ApprovalCallback>();
  /** Map from cryptographic token to pending approval (prevents ID enumeration) */
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  constructor(options: BackendOptions = {}) {
    const clientOptions: ClientOptions = {
      codexPath: options.codexPath,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
      env: options.env,
    };
    this.client = createAppServerClient(clientOptions);

    this.client.onServerRequest((request: ServerRequest) =>
      this.handleServerRequest(request)
    );
  }

  private handleServerRequest(
    request: ServerRequest
  ): Promise<ApprovalResponse> {
    const { method, params, id } = request as {
      method: string;
      params: unknown;
      id: number;
    };

    const token = generateApprovalToken();

    if (method === "item/commandExecution/requestApproval") {
      const approvalRequest: ApprovalRequest = {
        id,
        token,
        type: "commandExecution",
        params: params as CommandExecutionRequestApprovalParams,
      };
      return this.emitApprovalRequest(approvalRequest);
    }

    if (method === "item/fileChange/requestApproval") {
      const approvalRequest: ApprovalRequest = {
        id,
        token,
        type: "fileChange",
        params: params as FileChangeRequestApprovalParams,
      };
      return this.emitApprovalRequest(approvalRequest);
    }

    return Promise.resolve({ decision: "decline" } as ApprovalResponse);
  }

  private emitApprovalRequest(
    request: ApprovalRequest
  ): Promise<ApprovalResponse> {
    return new Promise<ApprovalResponse>((resolve) => {
      const { token } = request;

      const timeoutId = setTimeout(() => {
        const pending = this.pendingApprovals.get(token);
        if (pending) {
          this.pendingApprovals.delete(token);
          resolve({ decision: "decline" });
        }
      }, APPROVAL_TIMEOUT_MS);

      this.pendingApprovals.set(token, {
        internalId: request.id,
        token,
        resolve,
        timeoutId,
      });

      for (const cb of this.approvalCallbacks) {
        try {
          cb(request);
        } catch {
          // Ignore callback errors
        }
      }
    });
  }

  async initialize(clientInfo: ClientInfo): Promise<ServerInfo> {
    const response = await this.client.request<InitializeResponse>(
      "initialize",
      { clientInfo }
    );

    this.client.notify("initialized");
    this.initialized = true;

    return {
      userAgent: response.userAgent,
    };
  }

  async startThread(opts: ThreadStartOpts = {}): Promise<ThreadStartResponse> {
    this.ensureInitialized();

    const params: ThreadStartParams = {
      model: opts.model ?? null,
      modelProvider: opts.modelProvider ?? null,
      cwd: opts.cwd ?? null,
      approvalPolicy: opts.approvalPolicy ?? null,
      sandbox: opts.sandbox ?? null,
      config: opts.config ?? null,
      baseInstructions: opts.baseInstructions ?? null,
      developerInstructions: opts.developerInstructions ?? null,
      experimentalRawEvents: opts.experimentalRawEvents ?? false,
    };

    return await this.client.request<ThreadStartResponse>(
      "thread/start",
      params
    );
  }

  async resumeThread(
    threadId: string,
    opts: ThreadResumeOpts = {}
  ): Promise<ThreadResumeResponse> {
    this.ensureInitialized();

    const params: ThreadResumeParams = {
      threadId,
      history: null,
      path: opts.path ?? null,
      model: opts.model ?? null,
      modelProvider: opts.modelProvider ?? null,
      cwd: opts.cwd ?? null,
      approvalPolicy: opts.approvalPolicy ?? null,
      sandbox: opts.sandbox ?? null,
      config: opts.config ?? null,
      baseInstructions: opts.baseInstructions ?? null,
      developerInstructions: opts.developerInstructions ?? null,
    };

    return await this.client.request<ThreadResumeResponse>(
      "thread/resume",
      params
    );
  }

  async forkThread(
    threadId: string,
    opts: ThreadForkOpts = {}
  ): Promise<ThreadForkResponse> {
    this.ensureInitialized();

    const params: ThreadForkParams = {
      threadId,
      path: opts.path ?? null,
      model: opts.model ?? null,
      modelProvider: opts.modelProvider ?? null,
      cwd: opts.cwd ?? null,
      approvalPolicy: opts.approvalPolicy ?? null,
      sandbox: opts.sandbox ?? null,
      config: opts.config ?? null,
      baseInstructions: opts.baseInstructions ?? null,
      developerInstructions: opts.developerInstructions ?? null,
    };

    return await this.client.request<ThreadForkResponse>("thread/fork", params);
  }

  async startTurn(
    threadId: string,
    input: UserInput[],
    opts: TurnOpts = {}
  ): Promise<TurnStartResponse> {
    this.ensureInitialized();

    const params: TurnStartParams = {
      threadId,
      input,
      cwd: opts.cwd ?? null,
      approvalPolicy: opts.approvalPolicy ?? null,
      sandboxPolicy: opts.sandboxPolicy ?? EXTERNAL_SANDBOX_POLICY,
      model: opts.model ?? null,
      effort: opts.effort ?? null,
      summary: opts.summary ?? null,
      outputSchema: opts.outputSchema ?? null,
      collaborationMode: opts.collaborationMode ?? null,
    };

    return await this.client.request<TurnStartResponse>("turn/start", params);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.ensureInitialized();

    const params: TurnInterruptParams = {
      threadId,
      turnId,
    };

    await this.client.request<TurnInterruptResponse>("turn/interrupt", params);
  }

  async checkAuth(refreshToken = false): Promise<AuthStatus> {
    this.ensureInitialized();

    const params: GetAccountParams = {
      refreshToken,
    };

    const response = await this.client.request<GetAccountResponse>(
      "account/read",
      params
    );

    return {
      account: response.account,
      requiresOpenaiAuth: response.requiresOpenaiAuth,
    };
  }

  async startLogin(
    type: "apiKey" | "chatgpt",
    apiKey?: string
  ): Promise<LoginResult> {
    this.ensureInitialized();

    const params: LoginAccountParams =
      type === "apiKey"
        ? { type: "apiKey", apiKey: apiKey ?? "" }
        : { type: "chatgpt" };

    const response = await this.client.request<LoginAccountResponse>(
      "account/login/start",
      params
    );

    if (response.type === "apiKey") {
      return { type: "apiKey" };
    }

    return {
      type: "chatgpt",
      loginId: response.loginId,
      authUrl: response.authUrl,
    };
  }

  async execCommand(cmd: string[], opts: ExecOpts = {}): Promise<ExecResult> {
    this.ensureInitialized();

    const params: CommandExecParams = {
      command: cmd,
      timeoutMs: opts.timeoutMs ?? null,
      cwd: opts.cwd ?? null,
      sandboxPolicy: opts.sandboxPolicy ?? EXTERNAL_SANDBOX_POLICY,
    };

    const response = await this.client.request<CommandExecResponse>(
      "command/exec",
      params
    );

    return {
      exitCode: response.exitCode,
      stdout: response.stdout,
      stderr: response.stderr,
    };
  }

  onNotification(cb: (n: Notification) => void): () => void {
    return this.client.onNotification((notification: ServerNotification) => {
      cb(notification);
    });
  }

  onApprovalRequest(cb: ApprovalCallback): () => void {
    this.approvalCallbacks.add(cb);
    return () => {
      this.approvalCallbacks.delete(cb);
    };
  }

  respondToApproval(token: string, response: ApprovalResponse): boolean {
    // Validate token format to prevent timing attacks via early rejection
    if (!token || token.length !== 43) {
      // base64url of 32 bytes = 43 chars
      return false;
    }

    const pending = this.pendingApprovals.get(token);
    if (!pending) {
      return false;
    }

    // Defense-in-depth: While Map.get() already performed exact lookup, this timing-safe
    // comparison guards against any implementation-specific timing variations in the Map.
    if (!safeTokenCompare(pending.token, token)) {
      return false;
    }

    clearTimeout(pending.timeoutId);
    this.pendingApprovals.delete(token);
    pending.resolve(response);
    return true;
  }

  async shutdown(): Promise<void> {
    // Reject all pending approvals to unblock waiters
    for (const pending of this.pendingApprovals.values()) {
      clearTimeout(pending.timeoutId);
      pending.resolve({ decision: "decline" });
    }
    this.pendingApprovals.clear();

    // Clear all approval callbacks
    this.approvalCallbacks.clear();

    await this.client.shutdown();
    this.initialized = false;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "Backend not initialized. Call initialize() before other methods."
      );
    }
  }
}

export const createAppServerBackend = (
  options?: BackendOptions
): CodexBackend => new AppServerBackendImpl(options);
