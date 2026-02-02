import {
  type AdapterStatus,
  type CCAdapter,
  createCCAdapter,
} from "@forks-sh/cc";
import { getClaudeBinaryPath } from "./binary.js";

interface CCManager {
  getAdapter(): CCAdapter;
  initialize(): Promise<void>;
  getStatus(): Promise<AdapterStatus>;
  shutdown(): Promise<void>;
  restart(): Promise<void>;
}

let adapter: CCAdapter | null = null;
let initPromise: Promise<void> | null = null;
let restartPromise: Promise<void> | null = null;
let isShuttingDown = false;
let lastExitCode: number | null = null;
let exitError: string | null = null;
let exitUnsubscribe: (() => void) | null = null;

/**
 * Sanitize exit error messages to prevent leaking filesystem paths.
 */
const sanitizeExitError = (
  error: string | undefined,
  code: number | null
): string => {
  if (error && (error.includes("/") || error.includes("\\"))) {
    return `claude process failed with code ${code}`;
  }
  if (error && error.length > 200) {
    return `claude process failed with code ${code}`;
  }
  return error ?? `claude process exited with code ${code}`;
};

const setupExitHandler = (instance: CCAdapter): void => {
  exitUnsubscribe = instance.onExit((info) => {
    lastExitCode = info.code;
    exitError = sanitizeExitError(info.error, info.code);
    adapter = null;
    initPromise = null;
  });
};

const getOrCreateAdapter = (): CCAdapter => {
  if (adapter) {
    return adapter;
  }
  exitError = null;
  lastExitCode = null;
  adapter = createCCAdapter({
    claudePathOverride: getClaudeBinaryPath(),
  });
  return adapter;
};

const getAdapter = (): CCAdapter => {
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

  isShuttingDown = true;

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

export const ccManager: CCManager = {
  getAdapter,
  initialize,
  getStatus,
  shutdown,
  restart,
};
