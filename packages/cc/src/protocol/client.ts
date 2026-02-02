/** Claude Code CLI process client */

import { type ChildProcess, spawn } from "node:child_process";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import type { ProcessExitInfo } from "../types.js";
import type { CCStreamEvent } from "./events.js";

export interface CCClientOptions {
  claudePath?: string;
  env?: Record<string, string>;
}

export type StreamEventHandler = (event: CCStreamEvent) => void;
export type ExitHandler = (info: ProcessExitInfo) => void;

export interface CCClient {
  /**
   * Spawn a claude process with the given arguments and stream events
   */
  spawnTurn(
    args: string[],
    onEvent: StreamEventHandler,
    onComplete: () => void,
    onError: (error: Error) => void
  ): CCProcess;

  /**
   * Register an exit handler for process termination
   */
  onExit(handler: ExitHandler): () => void;
}

export interface CCProcess {
  /** The underlying child process */
  process: ChildProcess;
  /** Kill the process */
  kill(signal?: NodeJS.Signals): void;
}

const DEFAULT_CLAUDE_PATH = "claude";

export const createCCClient = (options: CCClientOptions = {}): CCClient => {
  const claudePath = options.claudePath ?? DEFAULT_CLAUDE_PATH;
  const env = options.env ?? {};
  const exitHandlers = new Set<ExitHandler>();

  // Maximum stderr buffer size (64KB) to prevent unbounded memory growth
  const MAX_STDERR_BUFFER = 64 * 1024;

  // Use Map for O(1) lookup by process instead of array
  const processSignalHandlers = new Map<
    ChildProcess,
    Array<{ signal: NodeJS.Signals; handler: () => void }>
  >();

  const forwardSignal = (
    signal: NodeJS.Signals,
    process: ChildProcess
  ): void => {
    if (process.killed) {
      return;
    }
    try {
      process.kill(signal);
    } catch {
      // Ignore errors when forwarding signals
    }
  };

  const setupSignalForwarding = (proc: ChildProcess): void => {
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
    for (const signal of signals) {
      const handler = () => forwardSignal(signal, proc);
      handlers.push({ signal, handler });
      globalThis.process.on(signal, handler);
    }
    processSignalHandlers.set(proc, handlers);
  };

  const cleanupSignalForwarding = (proc: ChildProcess): void => {
    const handlers = processSignalHandlers.get(proc);
    if (handlers) {
      for (const { signal, handler } of handlers) {
        globalThis.process.off(signal, handler);
      }
      processSignalHandlers.delete(proc);
    }
  };

  const notifyExitHandlers = (info: ProcessExitInfo): void => {
    for (const handler of exitHandlers) {
      try {
        handler(info);
      } catch {
        // Ignore handler errors
      }
    }
  };

  const buildExitError = (
    code: number | null,
    signal: NodeJS.Signals | null,
    stderrBuffer: string
  ): string | undefined => {
    if (signal) {
      return `claude process terminated by signal ${signal}`;
    }
    if (code !== 0) {
      const stderrSuffix = stderrBuffer
        ? `: ${stderrBuffer.trim().slice(0, 200)}`
        : "";
      return `claude process exited with code ${code}${stderrSuffix}`;
    }
    return undefined;
  };

  const spawnTurn = (
    args: string[],
    onEvent: StreamEventHandler,
    onComplete: () => void,
    onError: (error: Error) => void
  ): CCProcess => {
    const proc = spawn(claudePath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...globalThis.process.env, ...env },
    });

    if (!proc.stdout) {
      throw new Error("Failed to spawn claude process");
    }

    setupSignalForwarding(proc);

    const readline: ReadlineInterface = createInterface({
      input: proc.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    let stderrBuffer = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      const str = chunk.toString();
      // Limit stderr buffer to prevent unbounded memory growth
      if (stderrBuffer.length + str.length <= MAX_STDERR_BUFFER) {
        stderrBuffer += str;
      } else if (stderrBuffer.length < MAX_STDERR_BUFFER) {
        // Fill remaining space
        stderrBuffer += str.slice(0, MAX_STDERR_BUFFER - stderrBuffer.length);
      }
      // Once buffer is full, drop further data
    });

    readline.on("line", (line: string) => {
      if (!line.trim()) {
        return;
      }
      try {
        const event = JSON.parse(line) as CCStreamEvent;
        onEvent(event);
      } catch {
        // Skip non-JSON lines (e.g., startup messages)
      }
    });

    // Handle readline errors (e.g., encoding issues)
    readline.on("error", (err) => {
      console.warn("[cc] readline error:", err.message);
    });

    let exitHandled = false;

    proc.on("close", (code, signal) => {
      cleanupSignalForwarding(proc);
      readline.close();

      if (exitHandled) {
        return;
      }
      exitHandled = true;

      const exitInfo: ProcessExitInfo = {
        code,
        error: buildExitError(code, signal, stderrBuffer),
      };

      notifyExitHandlers(exitInfo);

      if (code === 0) {
        onComplete();
      } else {
        onError(
          new Error(exitInfo.error ?? `claude process exited with code ${code}`)
        );
      }
    });

    proc.on("error", (err) => {
      cleanupSignalForwarding(proc);

      if (exitHandled) {
        return;
      }
      exitHandled = true;

      const exitInfo: ProcessExitInfo = {
        code: null,
        error: `claude process error: ${err.message}`,
      };

      notifyExitHandlers(exitInfo);
      onError(new Error(exitInfo.error));
    });

    return {
      process: proc,
      kill: (signal: NodeJS.Signals = "SIGINT") => {
        if (!proc.killed) {
          proc.kill(signal);
        }
      },
    };
  };

  const onExit = (handler: ExitHandler): (() => void) => {
    exitHandlers.add(handler);
    return () => {
      exitHandlers.delete(handler);
    };
  };

  return {
    spawnTurn,
    onExit,
  };
};
