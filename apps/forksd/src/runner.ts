import type { CodexAdapter } from "@forks-sh/codex";
import type { Runner } from "@forks-sh/runner";
import { createRunner } from "@forks-sh/runner";
import type { Store } from "@forks-sh/store";

import { codexManager } from "./codex/manager.js";

let runner: Runner | null = null;
let initializationPromise: Promise<Runner> | null = null;

interface RunnerDependencies {
  store: Store;
}

let dependencies: RunnerDependencies | null = null;

export const setRunnerDependencies = (deps: RunnerDependencies): void => {
  dependencies = deps;
};

export const initRunnerIfNeeded = async (): Promise<Runner> => {
  if (runner) {
    return runner;
  }

  if (initializationPromise) {
    return await initializationPromise;
  }

  if (!dependencies) {
    throw new Error(
      "[Runner] Dependencies not set. Call setRunnerDependencies first."
    );
  }

  initializationPromise = (async () => {
    await codexManager.initialize();
    const adapter = codexManager.getAdapter();
    runner = initRunner(dependencies.store, adapter);
    return runner;
  })();

  return await initializationPromise;
};

export const getRunner = (): Runner | null => runner;

const initRunner = (store: Store, adapter: CodexAdapter): Runner => {
  const r = createRunner({ adapter, store });
  r.start();
  return r;
};
