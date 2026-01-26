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
}

let adapter: CodexAdapter | null = null;
let initPromise: Promise<void> | null = null;
let isShuttingDown = false;

const getOrCreateAdapter = (): CodexAdapter => {
  if (adapter) {
    return adapter;
  }
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
  })();
  return initPromise;
};

const getStatus = (): Promise<AdapterStatus> => {
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

const handleShutdown = () => {
  shutdown().catch(() => {
    // Ignore shutdown errors
  });
};

process.on("SIGTERM", handleShutdown);
process.on("SIGINT", handleShutdown);

export const codexManager: CodexManager = {
  getAdapter,
  initialize,
  getStatus,
  shutdown,
};
