import { type ChildProcess, spawn } from "node:child_process";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import type { ProcessExitInfo } from "../types.js";
import type { ServerNotification } from "./ServerNotification.js";
import type { ServerRequest } from "./ServerRequest.js";

export interface ClientOptions {
  codexPath?: string;
  timeoutMs?: number;
  maxRetries?: number;
  env?: Record<string, string>;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

type ServerRequestHandler = (request: ServerRequest) => Promise<unknown>;
type NotificationHandler = (notification: ServerNotification) => void;
type ExitHandler = (info: ProcessExitInfo) => void;

export interface AppServerClient {
  request<T>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  onServerRequest(handler: ServerRequestHandler): void;
  onNotification(handler: NotificationHandler): () => void;
  onExit(handler: ExitHandler): () => void;
  shutdown(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CODEX_PATH = "codex";

export const createAppServerClient = (
  options: ClientOptions = {}
): AppServerClient => {
  const codexPath = options.codexPath ?? DEFAULT_CODEX_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = options.env ?? {};

  let process: ChildProcess | null = null;
  let readline: ReadlineInterface | null = null;
  let requestId = 0;
  const pendingRequests = new Map<number, PendingRequest>();
  let serverRequestHandler: ServerRequestHandler | null = null;
  const notificationHandlers = new Set<NotificationHandler>();
  const exitHandlers = new Set<ExitHandler>();
  let isShuttingDown = false;

  // Signal forwarding handlers (per official Codex pattern from codex-cli/bin/codex.js)
  const signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> =
    [];

  const forwardSignal = (signal: NodeJS.Signals): void => {
    if (!process || process.killed) {
      return;
    }
    try {
      process.kill(signal);
    } catch {
      // Ignore errors when forwarding signals
    }
  };

  const setupSignalForwarding = (): void => {
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of signals) {
      const handler = () => forwardSignal(signal);
      signalHandlers.push({ signal, handler });
      globalThis.process.on(signal, handler);
    }
  };

  const cleanupSignalForwarding = (): void => {
    for (const { signal, handler } of signalHandlers) {
      globalThis.process.off(signal, handler);
    }
    signalHandlers.length = 0;
  };

  const startProcess = (): void => {
    if (process) return;

    // Note: Signal handler cleanup happens in close/error event handlers.
    // Avoid cleaning up here to prevent race conditions where old process
    // is still running but would lose signal forwarding.

    process = spawn(codexPath, ["app-server"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...globalThis.process.env, ...env },
    });

    if (!(process.stdout && process.stdin)) {
      throw new Error("Failed to spawn codex app-server process");
    }

    // Set up signal forwarding per official Codex pattern
    setupSignalForwarding();

    readline = createInterface({
      input: process.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    readline.on("line", (line: string) => {
      handleLine(line);
    });

    // Track exit status from 'exit' event (process terminated)
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    // Track if exit handlers have been called to prevent duplicate calls
    // (error event fires before close event when spawn fails per Node.js docs)
    let exitHandled = false;

    process.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });

    // Use 'close' event to ensure stdio streams are flushed before cleanup
    // (Node.js best practice: 'close' fires after streams close, 'exit' may fire before)
    process.on("close", (code, signal) => {
      // Clean up signal forwarding
      cleanupSignalForwarding();

      // Use exit event values if close doesn't provide them
      const finalCode = code ?? exitCode;
      const finalSignal = signal ?? exitSignal;

      if (!isShuttingDown && !exitHandled) {
        exitHandled = true;
        const exitInfo: ProcessExitInfo = {
          code: finalCode,
          error: finalSignal
            ? `codex app-server terminated by signal ${finalSignal}`
            : `codex app-server exited with code ${finalCode}`,
        };
        for (const handler of exitHandlers) {
          try {
            handler(exitInfo);
          } catch {
            // Ignore handler errors
          }
        }
        const error = new Error(exitInfo.error);
        for (const pending of pendingRequests.values()) {
          clearTimeout(pending.timeoutId);
          pending.reject(error);
        }
        pendingRequests.clear();
      }
      process = null;
      readline = null;
    });

    process.on("error", (err) => {
      // Clean up signal forwarding on error
      cleanupSignalForwarding();

      if (!isShuttingDown && !exitHandled) {
        exitHandled = true;
        const exitInfo: ProcessExitInfo = {
          code: null,
          error: `codex app-server error: ${err.message}`,
        };
        for (const handler of exitHandlers) {
          try {
            handler(exitInfo);
          } catch {
            // Ignore handler errors
          }
        }
      }
      // Reject pending requests even if exit was already handled
      // (close event will also try to reject, but map will be empty)
      const error = new Error(`codex app-server error: ${err.message}`);
      for (const pending of pendingRequests.values()) {
        clearTimeout(pending.timeoutId);
        pending.reject(error);
      }
      pendingRequests.clear();
    });
  };

  const handleLine = (line: string): void => {
    let message: {
      id?: number;
      method?: string;
      result?: unknown;
      error?: { message: string };
      params?: unknown;
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (
      message.id !== undefined &&
      (message.result !== undefined || message.error !== undefined)
    ) {
      const pending = pendingRequests.get(message.id);
      if (pending) {
        pendingRequests.delete(message.id);
        clearTimeout(pending.timeoutId);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      const request = message as ServerRequest;
      if (serverRequestHandler) {
        serverRequestHandler(request)
          .then((result) => {
            sendMessage({ jsonrpc: "2.0", id: message.id, result });
          })
          .catch((err: Error) => {
            sendMessage({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32_000, message: err.message },
            });
          });
      }
      return;
    }

    if (message.method && message.id === undefined) {
      const notification = message as ServerNotification;
      for (const handler of notificationHandlers) {
        try {
          handler(notification);
        } catch {
          // Ignore handler errors
        }
      }
    }
  };

  const sendMessage = (msg: object): void => {
    if (!process?.stdin?.writable) {
      throw new Error("Process not running");
    }
    process.stdin.write(JSON.stringify(msg) + "\n");
  };

  const request = <T>(method: string, params?: unknown): Promise<T> => {
    startProcess();
    const id = ++requestId;

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      pendingRequests.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timeoutId,
      });

      sendMessage({ jsonrpc: "2.0", id, method, params });
    });
  };

  const notify = (method: string, params?: unknown): void => {
    startProcess();
    sendMessage({ jsonrpc: "2.0", method, params });
  };

  const onServerRequest = (handler: ServerRequestHandler): void => {
    serverRequestHandler = handler;
  };

  const onNotification = (handler: NotificationHandler): (() => void) => {
    notificationHandlers.add(handler);
    return () => {
      notificationHandlers.delete(handler);
    };
  };

  const onExit = (handler: ExitHandler): (() => void) => {
    exitHandlers.add(handler);
    return () => {
      exitHandlers.delete(handler);
    };
  };

  const shutdown = async (): Promise<void> => {
    isShuttingDown = true;

    // Clean up signal forwarding first
    cleanupSignalForwarding();

    // Clear all handlers to prevent memory leaks (handlers may hold external references)
    notificationHandlers.clear();
    exitHandlers.clear();

    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error("Client shutting down"));
    }
    pendingRequests.clear();

    if (readline) {
      readline.close();
      readline = null;
    }

    if (process) {
      const proc = process;
      process.stdin?.end();
      process.kill("SIGTERM");

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {
            // Process may already be dead
          }
          resolve();
        }, 5000);

        // Use once() to avoid listener accumulation
        proc.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      process = null;
    }
  };

  return {
    request,
    notify,
    onServerRequest,
    onNotification,
    onExit,
    shutdown,
  };
};
