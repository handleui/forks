/** @forks-sh/codex – Codex adapter types */

export interface CodexThread {
  readonly id: string | null;
}

export type RunId = string;

export interface RunResult {
  items: unknown[];
  finalResponse: string;
  usage: unknown | null;
}

export interface CodexEvent {
  type: string;
  [key: string]: unknown;
}

export interface CodexAdapter {
  startThread(): CodexThread;
  sendTurn(threadId: string, input: string): Promise<RunId>;
  run(threadId: string, input: string): Promise<RunResult>;
  onEvent(callback: (event: CodexEvent) => void): void;
  cancel(runId: string): Promise<void>;
}

export interface CodexAdapterOptions {
  codexPathOverride?: string;
  apiKey?: string;
  baseUrl?: string;
  env?: Record<string, string>;
}
