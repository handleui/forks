/** @forks-sh/cc - Claude Code adapter types */

export interface CCThread {
  readonly id: string | null;
}

export type RunId = string;

export interface RunResult {
  items: unknown[];
  finalResponse: string;
  usage: CCUsage | null;
}

export interface CCUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  totalCostUsd?: number;
}

/** Base event structure - all CC events have a type and optional conversationId/turnId */
interface CCEventBase {
  type: string;
  conversationId?: string;
  turnId?: string;
}

/** Thread started event */
interface CCThreadStartedEvent extends CCEventBase {
  type: "thread/started";
  sessionId: string;
}

/** Agent message delta event */
interface CCAgentMessageDeltaEvent extends CCEventBase {
  type: "item/agentMessage/delta";
  itemId: string;
  delta: string;
}

/** Item started event (tool calls) */
interface CCItemStartedEvent extends CCEventBase {
  type: "item/started";
  itemId: string;
  itemType: string;
  toolName?: string;
  input?: unknown;
}

/** Item completed event */
interface CCItemCompletedEvent extends CCEventBase {
  type: "item/completed";
  itemId: string;
  itemType: string;
  result?: unknown;
  isError?: boolean;
}

/** Turn completed event */
interface CCTurnCompletedEvent extends CCEventBase {
  type: "turn/completed";
  result: string;
  isError: boolean;
  usage: CCUsage;
  durationMs: number;
  numTurns: number;
}

/** Turn error event */
interface CCTurnErrorEvent extends CCEventBase {
  type: "turn/error";
  error: string;
}

/** Union of all CC event types */
export type CCEvent =
  | CCThreadStartedEvent
  | CCAgentMessageDeltaEvent
  | CCItemStartedEvent
  | CCItemCompletedEvent
  | CCTurnCompletedEvent
  | CCTurnErrorEvent;

export interface AdapterStatus {
  installed: boolean;
  authenticated: boolean;
  ready: boolean;
  error?: string;
  exitCode?: number | null;
}

export interface ThreadStartOpts {
  /** Base instructions to inject into the session context */
  baseInstructions?: string | null;
  /** Model to use (opus, sonnet, haiku) */
  model?: string | null;
}

export interface SendTurnOpts {
  /** Working directory for this turn */
  cwd?: string | null;
  /** Model override for this turn */
  model?: string | null;
  /** Maximum turns for agentic execution */
  maxTurns?: number | null;
}

export interface ProcessExitInfo {
  code: number | null;
  error?: string;
}

export interface CCAdapter {
  startThread(opts?: ThreadStartOpts): CCThread;
  sendTurn(
    threadId: string,
    input: string,
    opts?: SendTurnOpts
  ): Promise<RunId>;
  run(threadId: string, input: string): Promise<RunResult>;
  onEvent(callback: (event: CCEvent) => void): () => void;
  onExit(callback: (info: ProcessExitInfo) => void): () => void;
  cancel(runId: string): Promise<void>;
  /** Close a thread and release its resources from memory */
  closeThread(threadId: string): void;
  getStatus(): Promise<AdapterStatus>;
  setWorkingDirectory(cwd: string): void;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface CCAdapterOptions {
  /** Override path to claude binary (default: from PATH or CLAUDE_EXECUTABLE env) */
  claudePathOverride?: string;
  /** Default model (default: opus) */
  model?: string;
  /** Custom system prompt (replaces default) */
  systemPrompt?: string;
  /** Append to default system prompt */
  appendSystemPrompt?: string;
  /** Maximum agentic turns */
  maxTurns?: number;
  /** Environment variables to pass to claude process */
  env?: Record<string, string>;
}
