/** @forks-sh/runner – types */

import type { CodexAdapter } from "@forks-sh/codex";
import type { Store, StoreEventEmitter } from "@forks-sh/store";

export interface RunnerConfig {
  adapter: CodexAdapter;
  store: Store;
  storeEmitter: StoreEventEmitter;
}

export interface ExecutionContext {
  id: string;
  chatId: string;
  type: "subagent" | "attempt";
  threadId: string;
  runId?: string;
  cwd: string;
  abortController: AbortController;
}
