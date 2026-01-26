import { type ChildProcess, spawn } from "node:child_process";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
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

export interface AppServerClient {
  request<T>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  onServerRequest(handler: ServerRequestHandler): void;
  onNotification(handler: NotificationHandler): () => void;
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
  let isShuttingDown = false;

  const startProcess = (): void => {
    if (process) return;

    process = spawn(codexPath, ["app-server"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...globalThis.process.env, ...env },
    });

    if (!(process.stdout && process.stdin)) {
      throw new Error("Failed to spawn codex app-server process");
    }

    readline = createInterface({
      input: process.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    readline.on("line", (line: string) => {
      handleLine(line);
    });

    process.on("exit", (code) => {
      if (!isShuttingDown) {
        const error = new Error(`codex app-server exited with code ${code}`);
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

  const shutdown = async (): Promise<void> => {
    isShuttingDown = true;

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
      process.stdin?.end();
      process.kill("SIGTERM");

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          process?.kill("SIGKILL");
          resolve();
        }, 5000);

        process?.on("exit", () => {
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
    shutdown,
  };
};
