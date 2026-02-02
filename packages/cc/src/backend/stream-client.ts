/** Claude Code stream backend implementation */

import { randomUUID } from "node:crypto";
import {
  type CCClient,
  type CCProcess,
  createCCClient,
} from "../protocol/client.js";
import {
  type CCStreamEvent,
  isResultEvent,
  isSystemEvent,
} from "../protocol/events.js";
import {
  createMapperContext,
  mapCCEventToCodexEvents,
} from "../protocol/mapper.js";
import type { CCEvent, ProcessExitInfo } from "../types.js";
import type {
  BackendOptions,
  CCBackend,
  ExitHandler,
  NotificationHandler,
  SessionId,
  SessionStartOpts,
  SessionStartResponse,
  TurnOpts,
  TurnStartResponse,
} from "./interface.js";

const DEFAULT_MODEL = "opus";

interface SessionState {
  id: SessionId;
  realSessionId: string | null; // Claude's actual session ID from stream
  cwd: string | null;
  model: string;
  systemPrompt: string | null;
  appendSystemPrompt: string | null;
  baseInstructions: string | null;
  turnCount: number;
}

class CCStreamBackendImpl implements CCBackend {
  private readonly client: CCClient;
  private readonly options: BackendOptions;
  private readonly sessions = new Map<SessionId, SessionState>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly exitHandlers = new Set<ExitHandler>();
  private activeProcess: CCProcess | null = null;
  private activeSessionId: SessionId | null = null;
  private initialized = false;

  constructor(options: BackendOptions = {}) {
    this.options = options;
    this.client = createCCClient({
      claudePath: options.claudePath,
      env: options.env,
    });

    // Forward exit events from client
    this.client.onExit((info: ProcessExitInfo) => {
      for (const handler of this.exitHandlers) {
        try {
          handler(info);
        } catch {
          // Ignore handler errors
        }
      }
    });
  }

  initialize(): Promise<void> {
    if (this.initialized) {
      return Promise.resolve();
    }
    // Could verify claude binary exists here
    this.initialized = true;
    return Promise.resolve();
  }

  startSession(opts: SessionStartOpts = {}): Promise<SessionStartResponse> {
    const sessionId = randomUUID();
    const state: SessionState = {
      id: sessionId,
      realSessionId: null,
      cwd: opts.cwd ?? null,
      model: opts.model ?? this.options.model ?? DEFAULT_MODEL,
      systemPrompt: opts.systemPrompt ?? this.options.systemPrompt ?? null,
      appendSystemPrompt:
        opts.appendSystemPrompt ?? this.options.appendSystemPrompt ?? null,
      baseInstructions: opts.baseInstructions ?? null,
      turnCount: 0,
    };
    this.sessions.set(sessionId, state);
    return Promise.resolve({ sessionId });
  }

  startTurn(
    sessionId: SessionId,
    input: string,
    opts: TurnOpts = {}
  ): Promise<TurnStartResponse> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return Promise.reject(new Error(`Session not found: ${sessionId}`));
    }

    const turnId = randomUUID();
    const isFirstTurn = session.turnCount === 0;
    session.turnCount++;

    const args = this.buildArgs(session, input, opts, isFirstTurn);
    const context = createMapperContext(sessionId, turnId);

    return new Promise((resolve) => {
      this.activeSessionId = sessionId;
      this.activeProcess = this.client.spawnTurn(
        args,
        (event: CCStreamEvent) => {
          // Map and emit events
          const codexEvents = mapCCEventToCodexEvents(event, context);
          for (const codexEvent of codexEvents) {
            // Capture real session ID for subsequent turns
            if (isSystemEvent(event) || isResultEvent(event)) {
              session.realSessionId = event.session_id;
            }
            this.emit(codexEvent);
          }
        },
        () => {
          // Complete
          this.activeProcess = null;
          this.activeSessionId = null;
        },
        (error: Error) => {
          // Error
          this.activeProcess = null;
          this.activeSessionId = null;
          // Emit error event but don't reject - errors are normal flow
          this.emit({
            type: "turn/error",
            conversationId: sessionId,
            turnId,
            error: error.message,
          });
        }
      );

      // Resolve immediately with turnId - events stream via onNotification
      resolve({ turnId });
    });
  }

  interruptTurn(sessionId: SessionId): Promise<void> {
    if (this.activeSessionId === sessionId && this.activeProcess) {
      this.activeProcess.kill("SIGINT");
      this.activeProcess = null;
      this.activeSessionId = null;
    }
    return Promise.resolve();
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  onExit(handler: ExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  shutdown(): Promise<void> {
    // Kill any active process
    if (this.activeProcess) {
      this.activeProcess.kill("SIGTERM");
      this.activeProcess = null;
    }

    // Clear state
    this.sessions.clear();
    this.notificationHandlers.clear();
    this.exitHandlers.clear();
    this.activeSessionId = null;
    this.initialized = false;
    return Promise.resolve();
  }

  private buildArgs(
    session: SessionState,
    input: string,
    opts: TurnOpts,
    isFirstTurn: boolean
  ): string[] {
    const args: string[] = ["-p", input, "--output-format", "stream-json"];

    // SECURITY: Skip permission checks only when explicitly enabled (default: true for backwards compat).
    // Only safe for local-only apps where the user controls all inputs.
    if (this.options.skipPermissions !== false) {
      args.push("--dangerously-skip-permissions");
    }

    // Model
    const model = opts.model ?? session.model;
    args.push("--model", model);

    // Session continuity
    if (session.realSessionId && !isFirstTurn) {
      args.push("--session-id", session.realSessionId);
      args.push("--continue");
    }

    // Working directory
    const cwd = opts.cwd ?? session.cwd;
    if (cwd) {
      args.push("--add-dir", cwd);
    }

    // System prompt
    if (session.systemPrompt) {
      args.push("--system-prompt", session.systemPrompt);
    }

    // Append system prompt (includes base instructions)
    const appendPrompt = this.buildAppendPrompt(session);
    if (appendPrompt) {
      args.push("--append-system-prompt", appendPrompt);
    }

    // Max turns
    const maxTurns = opts.maxTurns ?? this.options.maxTurns;
    if (maxTurns) {
      args.push("--max-turns", String(maxTurns));
    }

    return args;
  }

  private buildAppendPrompt(session: SessionState): string | null {
    const parts: string[] = [];

    if (session.appendSystemPrompt) {
      parts.push(session.appendSystemPrompt);
    }

    if (session.baseInstructions) {
      parts.push(session.baseInstructions);
    }

    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  private emit(event: CCEvent): void {
    for (const handler of this.notificationHandlers) {
      try {
        handler(event);
      } catch {
        // Ignore handler errors
      }
    }
  }
}

export const createCCStreamBackend = (options?: BackendOptions): CCBackend =>
  new CCStreamBackendImpl(options);
