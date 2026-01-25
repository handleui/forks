/** @forks-sh/codex – Codex adapter */

import type {
  CodexOptions,
  RunResult as CodexRunResult,
} from "@openai/codex-sdk";
import { Codex } from "@openai/codex-sdk";
import type {
  CodexAdapterOptions as AdapterOptions,
  CodexEvent,
  CodexThread,
  RunId,
  RunResult,
} from "./types.js";

export type {
  CodexAdapterOptions,
  CodexEvent,
  CodexThread,
  RunId,
  RunResult,
} from "./types.js";

class CodexAdapterImpl {
  private readonly codex: Codex;
  private readonly eventCallbacks: Set<(event: CodexEvent) => void> = new Set();
  private readonly activeRuns: Map<RunId, AbortController> = new Map();
  private readonly threads: Map<string, ReturnType<Codex["startThread"]>> =
    new Map();
  private runIdCounter = 0;
  private threadIdCounter = 0;

  constructor(options: AdapterOptions = {}) {
    const codexOptions: CodexOptions = {
      codexPathOverride: options.codexPathOverride,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      env: options.env,
    };
    this.codex = new Codex(codexOptions);
  }

  startThread(): CodexThread {
    const thread = this.codex.startThread();
    const tempId = `thread-${this.threadIdCounter++}`;
    this.threads.set(tempId, thread);
    return {
      get id(): string | null {
        return thread.id ?? tempId;
      },
    };
  }

  sendTurn(threadId: string, input: string): Promise<RunId> {
    const runId = `run-${this.runIdCounter++}`;
    const abortController = new AbortController();
    this.activeRuns.set(runId, abortController);

    // Get or create thread
    const thread = this.getOrCreateThread(threadId);

    // Start streaming in background
    this.streamEvents(thread, threadId, input, abortController, runId);

    return Promise.resolve(runId);
  }

  private getOrCreateThread(
    threadId: string
  ): ReturnType<Codex["startThread"]> {
    let thread = this.threads.get(threadId);
    if (!thread) {
      if (threadId.startsWith("thread-")) {
        thread = this.codex.startThread();
        this.threads.set(threadId, thread);
      } else {
        thread = this.codex.resumeThread(threadId);
      }
    }
    return thread;
  }

  private streamEvents(
    thread: ReturnType<Codex["startThread"]>,
    threadId: string,
    input: string,
    abortController: AbortController,
    runId: RunId
  ): void {
    (async () => {
      try {
        const { events } = await thread.runStreamed(input, {
          signal: abortController.signal,
        });
        for await (const event of events) {
          this.emitEvent(event as CodexEvent);
          this.handleThreadIdUpdate(event, threadId, thread);
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        this.emitEvent({
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        } as CodexEvent);
      } finally {
        this.activeRuns.delete(runId);
      }
    })();
  }

  private handleThreadIdUpdate(
    event: CodexEvent,
    threadId: string,
    thread: ReturnType<Codex["startThread"]>
  ): void {
    if (event.type === "thread.started" && "thread_id" in event) {
      const actualThreadId = event.thread_id as string;
      if (threadId !== actualThreadId) {
        this.threads.set(actualThreadId, thread);
        if (threadId.startsWith("thread-")) {
          this.threads.delete(threadId);
        }
      }
    }
  }

  async run(threadId: string, input: string): Promise<RunResult> {
    // Get or create thread
    let thread = this.threads.get(threadId);
    if (!thread) {
      if (threadId.startsWith("thread-")) {
        thread = this.codex.startThread();
      } else {
        thread = this.codex.resumeThread(threadId);
      }
      this.threads.set(threadId, thread);
    }

    const result: CodexRunResult = await thread.run(input);
    return {
      items: result.items,
      finalResponse: result.finalResponse,
      usage: result.usage,
    };
  }

  onEvent(callback: (event: CodexEvent) => void): void {
    this.eventCallbacks.add(callback);
  }

  cancel(runId: string): Promise<void> {
    const abortController = this.activeRuns.get(runId);
    if (abortController) {
      abortController.abort();
      this.activeRuns.delete(runId);
    }
    return Promise.resolve();
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

export interface CodexAdapter {
  startThread(): CodexThread;
  sendTurn(threadId: string, input: string): Promise<RunId>;
  run(threadId: string, input: string): Promise<RunResult>;
  onEvent(callback: (event: CodexEvent) => void): void;
  cancel(runId: string): Promise<void>;
}

export const createCodexAdapter = (
  options: AdapterOptions = {}
): CodexAdapter => {
  return new CodexAdapterImpl(options);
};
