import { createRpcGitDriver } from "./driver-rpc.js";
import { isTauriRuntime } from "./runtime.js";
import type {
  CreateWorktreeOpts,
  GitStatusEntry,
  WorktreeInfo,
} from "./types.js";

export interface GitDriver {
  isGitRepo: (path: string) => Promise<boolean>;
  getRepoRoot: (path: string) => Promise<string>;
  getDefaultBranch: (repoPath: string) => Promise<string>;
  getCurrentBranch: (path: string) => Promise<string>;
  branchExists: (repoPath: string, branch: string) => Promise<boolean>;
  createBranch: (
    repoPath: string,
    branch: string,
    startPoint?: string
  ) => Promise<void>;
  listWorktrees: (repoPath: string) => Promise<WorktreeInfo[]>;
  createWorktree: (repoPath: string, opts: CreateWorktreeOpts) => Promise<void>;
  removeWorktree: (
    worktreePath: string,
    opts?: { force?: boolean }
  ) => Promise<void>;
  deleteBranch: (
    repoPath: string,
    branch: string,
    force?: boolean
  ) => Promise<void>;
  getCurrentCommit: (repoPath: string) => Promise<string>;
  resetHard: (repoPath: string, ref: string) => Promise<void>;
  getStatus: (repoPath: string) => Promise<GitStatusEntry[]>;
  getChangedFiles: (repoPath: string) => Promise<string[]>;
}

type GitDriverKind = "tauri" | "rpc";

let driverPromise: Promise<GitDriver> | null = null;
let driverOverride: GitDriver | null = null;
let activeKind: GitDriverKind | null = null;

const readEnv = (key: string): string | undefined => {
  if (typeof process === "undefined") {
    return undefined;
  }
  return process.env ? process.env[key] : undefined;
};

const loadTauriDriver = async (): Promise<GitDriver> => {
  const module = await import("./driver-tauri.js");
  return module.createTauriGitDriver();
};

const resolveGitDriver = async (): Promise<GitDriver> => {
  const requested = readEnv("FORKS_GIT_DRIVER");
  const socketPath = readEnv("FORKS_GIT_RPC_SOCKET");
  if (requested === "rpc") {
    if (socketPath) {
      activeKind = "rpc";
      return createRpcGitDriver(socketPath);
    }
    throw new Error("FORKS_GIT_RPC_SOCKET is required for RPC driver");
  }
  if (requested === "tauri") {
    const driver = await loadTauriDriver();
    activeKind = "tauri";
    return driver;
  }
  if (socketPath) {
    activeKind = "rpc";
    return createRpcGitDriver(socketPath);
  }
  if (isTauriRuntime()) {
    try {
      const driver = await loadTauriDriver();
      activeKind = "tauri";
      return driver;
    } catch {
      throw new Error("Tauri driver unavailable");
    }
  }
  throw new Error("No git driver available");
};

export const getGitDriver = (): Promise<GitDriver> => {
  if (driverOverride) {
    return Promise.resolve(driverOverride);
  }
  if (!driverPromise) {
    driverPromise = resolveGitDriver();
  }
  return driverPromise;
};

export const getGitDriverKind = (): GitDriverKind | null => activeKind;

export const setGitDriver = (driver: GitDriver | null): void => {
  driverOverride = driver;
  driverPromise = driver ? Promise.resolve(driver) : null;
  activeKind = null;
};
