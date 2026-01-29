import {
  type AdapterStatus,
  type CodexAdapter,
  createCodexAdapter,
} from "@forks-sh/codex";
import { getCodexBinaryPath } from "./binary.js";

interface CodexManager {
  getAdapter(): CodexAdapter;
  initialize(): Promise<void>;
  getStatus(): Promise<AdapterStatus>;
  shutdown(): Promise<void>;
  restart(): Promise<void>;
}

let adapter: CodexAdapter | null = null;
let initPromise: Promise<void> | null = null;
let restartPromise: Promise<void> | null = null;
let isShuttingDown = false;
let lastExitCode: number | null = null;
let exitError: string | null = null;
let exitUnsubscribe: (() => void) | null = null;

/**
 * Sanitize exit error messages to prevent leaking filesystem paths.
 * Only expose safe, generic error messages to clients.
 */
const sanitizeExitError = (
  error: string | undefined,
  code: number | null
): string => {
  // If error contains path separators, it might leak filesystem structure
  if (error && (error.includes("/") || error.includes("\\"))) {
    return `codex process failed with code ${code}`;
  }
  // Limit length to prevent verbose error leakage
  if (error && error.length > 200) {
    return `codex process failed with code ${code}`;
  }
  return error ?? `codex process exited with code ${code}`;
};

const setupExitHandler = (instance: CodexAdapter): void => {
  exitUnsubscribe = instance.onExit((info) => {
    lastExitCode = info.code;
    exitError = sanitizeExitError(info.error, info.code);
    adapter = null;
    initPromise = null;
  });
};

const getOrCreateAdapter = (): CodexAdapter => {
  if (adapter) {
    return adapter;
  }
  // Clear stale error state when creating a new adapter
  // This allows recovery after process crashes without requiring explicit restart()
  exitError = null;
  lastExitCode = null;
  adapter = createCodexAdapter({
    codexPathOverride: getCodexBinaryPath(),
  });
  return adapter;
};

const getAdapter = (): CodexAdapter => {
  if (isShuttingDown) {
    throw new Error("Manager is shutting down");
  }
  return getOrCreateAdapter();
};

const initialize = (): Promise<void> => {
  if (isShuttingDown) {
    return Promise.reject(new Error("Manager is shutting down"));
  }
  if (initPromise) {
    return initPromise;
  }
  initPromise = (async () => {
    const instance = getOrCreateAdapter();
    await instance.initialize();
    setupExitHandler(instance);
  })();
  return initPromise;
};

const getStatus = (): Promise<AdapterStatus> => {
  if (exitError) {
    return Promise.resolve({
      installed: true,
      authenticated: false,
      ready: false,
      error: exitError,
      exitCode: lastExitCode,
    });
  }
  if (isShuttingDown) {
    return Promise.reject(new Error("Manager is shutting down"));
  }
  const instance = getOrCreateAdapter();
  return instance.getStatus();
};

const shutdown = async (): Promise<void> => {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  if (exitUnsubscribe) {
    exitUnsubscribe();
    exitUnsubscribe = null;
  }

  if (adapter) {
    try {
      await adapter.shutdown();
    } catch {
      // Ignore shutdown errors
    }
    adapter = null;
  }

  initPromise = null;
};

const restart = (): Promise<void> => {
  if (isShuttingDown) {
    return Promise.reject(new Error("Manager is shutting down"));
  }
  if (restartPromise) {
    return restartPromise;
  }

  restartPromise = (async () => {
    exitError = null;
    lastExitCode = null;

    if (exitUnsubscribe) {
      exitUnsubscribe();
      exitUnsubscribe = null;
    }

    if (adapter) {
      try {
        await adapter.shutdown();
      } catch {
        // Ignore shutdown errors during restart
      }
    }

    adapter = null;
    initPromise = null;

    await initialize();
  })().finally(() => {
    isShuttingDown = false;
    restartPromise = null;
  });

  return restartPromise;
};

export const codexManager: CodexManager = {
  getAdapter,
  initialize,
  getStatus,
  shutdown,
  restart,
};
