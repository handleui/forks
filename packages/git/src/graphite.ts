/**
 * @forks-sh/git/graphite – Graphite CLI wrapper for stacked PRs
 *
 * Requires Graphite CLI v1.7.0+
 * Install: npm i -g @withgraphite/graphite-cli@stable
 *
 * @see https://graphite.dev/docs/get-started/install-the-cli
 */

import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isValidGitRef, normalizePath } from "./index.js";

/** Minimum supported Graphite CLI version */
export const MINIMUM_GT_VERSION = "1.7.0";

/**
 * Validates a commit message to prevent option injection.
 * Rejects messages that could be interpreted as CLI options.
 */
const isValidMessage = (message: string): boolean => {
  if (!message || message.length === 0 || message.length > 65_536) {
    return false;
  }
  // Reject messages starting with dash to prevent option injection
  if (message.startsWith("-")) {
    return false;
  }
  // Reject control characters (except newline and tab which are valid in messages)
  for (const char of message) {
    const code = char.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) {
      return false;
    }
  }
  return true;
};

const exec = promisify(execFile);

/**
 * Compare two semver version strings.
 * Returns: negative if a < b, 0 if equal, positive if a > b
 */
const compareVersions = (a: string, b: string): number => {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA !== numB) {
      return numA - numB;
    }
  }
  return 0;
};

// Match trunk name in parentheses - must start with letter, allows hyphens/underscores
// Format: "trunk (main)" - the "trunk" keyword check happens in gtLog before this regex
const TRUNK_MATCH_REGEX = /\(([a-zA-Z][a-zA-Z0-9_-]*)\)/;
// Branch markers: ◉ (current), ○ (other), * (alternative current marker)
// These markers are specific to Graphite CLI v1.7.x output format
const BRANCH_MATCH_REGEX = /[◉○*]\s*(\S+)/;
const PR_MATCH_REGEX = /#(\d+)/;
// Match trailing parenthetical PR info that may be captured with branch name
const TRAILING_PR_INFO_REGEX = /\(.*$/;
// Match PR URL lines from gt log output
// Format: "│ branch-name: https://app.graphite.dev/github/pr/org/repo/123"
const PR_URL_REGEX = /^\s*│?\s*(\S+):\s+(https:\/\/app\.graphite\.dev\/\S+)/;

export interface StackBranch {
  name: string;
  isCurrent: boolean;
  prNumber?: number;
  prUrl?: string;
  needsRestack: boolean;
}

export interface StackInfo {
  trunk: string;
  branches: StackBranch[];
  currentIndex: number;
}

export interface SubmitResult {
  /** Branch name */
  branch: string;
  /** PR URL on Graphite */
  prUrl: string;
  /** Whether the PR was created or updated */
  action: "created" | "updated";
}

export interface SubmitOpts {
  /** Create PRs as drafts */
  draft?: boolean;
  /** Submit entire stack (downstack and upstack) */
  stack?: boolean;
  /** Convert draft PRs to ready for review */
  publish?: boolean;
  /** Auto-merge PRs when checks pass */
  mergeWhenReady?: boolean;
  /** Only update existing PRs, don't create new ones */
  updateOnly?: boolean;
  /** Skip the interactive editor for PR descriptions */
  noEdit?: boolean;
}

export interface CreateOpts {
  /** Commit message for the new branch */
  message?: string;
  /** Stage all changes before creating */
  all?: boolean;
}

export interface ModifyOpts {
  /** Create a new commit instead of amending */
  commit?: boolean;
  /** Commit message */
  message?: string;
  /** Stage all changes before modifying */
  all?: boolean;
}

export interface RestackOpts {
  /** Only restack the current branch */
  only?: boolean;
  /** Restack only downstack branches */
  downstack?: boolean;
  /** Restack only upstack branches */
  upstack?: boolean;
}

export interface SyncOpts {
  /** Force sync even with uncommitted changes */
  force?: boolean;
  /** Sync all branches, not just the current stack */
  all?: boolean;
  /** Restack after syncing */
  restack?: boolean;
}

export interface DeleteOpts {
  /** Also close the associated PR on GitHub */
  close?: boolean;
  /** Force delete without confirmation */
  force?: boolean;
}

export interface ContinueOpts {
  /** Automatically stage all changes before continuing */
  all?: boolean;
}

export interface SquashOpts {
  /** New commit message for the squashed commit */
  message?: string;
  /** Don't modify the existing commit message */
  noEdit?: boolean;
}

export interface GtExecOpts {
  /** Timeout in milliseconds for the command */
  timeout?: number;
  /** AbortSignal to cancel the command */
  signal?: AbortSignal;
}

const gt = async (
  args: string[],
  cwd: string,
  opts?: GtExecOpts
): Promise<{ stdout: string; stderr: string }> => {
  const normalizedCwd = normalizePath(cwd);
  try {
    const result = await exec("gt", args, {
      cwd: normalizedCwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: opts?.timeout,
      signal: opts?.signal,
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      err.code === "ENOENT"
    ) {
      throw new Error(
        "Graphite CLI (gt) not found. Install: npm i -g @withgraphite/graphite-cli@stable"
      );
    }
    throw err;
  }
};

/**
 * Get the installed Graphite CLI version.
 * @returns Version string (e.g. "1.7.10")
 */
export const gtVersion = async (): Promise<string> => {
  try {
    const result = await exec("gt", ["--version"], { maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      err.code === "ENOENT"
    ) {
      throw new Error(
        "Graphite CLI (gt) not found. Install: npm i -g @withgraphite/graphite-cli@stable"
      );
    }
    throw err;
  }
};

export interface VersionCheck {
  /** Installed version string */
  version: string;
  /** Whether version meets minimum requirement */
  supported: boolean;
}

/**
 * Check if installed Graphite CLI version is supported.
 */
export const checkGtVersion = async (): Promise<VersionCheck> => {
  const version = await gtVersion();
  const supported = compareVersions(version, MINIMUM_GT_VERSION) >= 0;
  return { version, supported };
};

/**
 * Check if a directory is a Graphite-enabled repository.
 * Graphite stores config in .git/.graphite_repo_config after `gt init`.
 */
export const isGraphiteRepo = async (cwd: string): Promise<boolean> => {
  const normalizedCwd = normalizePath(cwd);
  const configPath = join(normalizedCwd, ".git", ".graphite_repo_config");
  try {
    await access(configPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Initialize Graphite in a repository.
 */
export const gtInit = async (cwd: string, trunk?: string): Promise<void> => {
  if (trunk && !isValidGitRef(trunk)) {
    throw new Error("Invalid trunk branch name");
  }
  const args = ["init"];
  if (trunk) {
    args.push("--trunk", trunk);
  }
  await gt(args, cwd);
};

/** Extract PR URLs from gt log output lines into a map */
const extractPrUrls = (lines: string[]): Map<string, string> => {
  const prUrlMap = new Map<string, string>();
  for (const line of lines) {
    const prUrlMatch = line.match(PR_URL_REGEX);
    if (prUrlMatch?.[1] && prUrlMatch?.[2]) {
      prUrlMap.set(prUrlMatch[1], prUrlMatch[2]);
    }
  }
  return prUrlMap;
};

/** Parse a single branch line and return branch info if valid */
const parseBranchLine = (
  trimmed: string,
  prUrlMap: Map<string, string>
): StackBranch | null => {
  const branchMatch = trimmed.match(BRANCH_MATCH_REGEX);
  if (!branchMatch?.[1]) {
    return null;
  }

  const rawName = branchMatch[1];
  const name = rawName.replace(TRAILING_PR_INFO_REGEX, "");
  if (!isValidGitRef(name)) {
    return null;
  }

  const isCurrent = trimmed.includes("◉") || trimmed.startsWith("*");
  const prMatch = trimmed.match(PR_MATCH_REGEX);
  const prNumber = prMatch?.[1] ? Number.parseInt(prMatch[1], 10) : undefined;
  const prUrl = prUrlMap.get(name);
  const needsRestack = trimmed.includes("!");

  return { name, isCurrent, prNumber, prUrl, needsRestack };
};

/**
 * Get stack information by parsing `gt log` output.
 * Uses the detailed format (not `short`) to capture PR URLs.
 * Returns structured stack data.
 *
 * @note Parsing validated against Graphite CLI v1.7.x output format.
 * Output format may vary in future versions.
 */
export const gtLog = async (cwd: string): Promise<StackInfo> => {
  const { stdout } = await gt(["log"], cwd);
  const lines = stdout.split("\n");
  const prUrlMap = extractPrUrls(lines);

  const branches: StackBranch[] = [];
  let currentIndex = -1;
  let trunk = "main";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    // Check for trunk indicator lines
    if (trimmed.includes("trunk") || trimmed.startsWith("─")) {
      const trunkMatch = trimmed.match(TRUNK_MATCH_REGEX);
      if (trunkMatch?.[1]) {
        trunk = trunkMatch[1];
      }
      continue;
    }

    const branch = parseBranchLine(trimmed, prUrlMap);
    if (branch) {
      if (branch.isCurrent) {
        currentIndex = branches.length;
      }
      branches.push(branch);
    }
  }

  return {
    trunk,
    branches,
    currentIndex,
  };
};

/**
 * Move up one branch in the stack (toward trunk).
 * Supports optional steps parameter to move multiple branches.
 */
export const gtUp = async (cwd: string, steps?: number): Promise<void> => {
  if (steps !== undefined && (steps < 1 || !Number.isInteger(steps))) {
    throw new Error("Steps must be a positive integer");
  }
  const args = ["up"];
  if (steps !== undefined) {
    args.push(String(steps));
  }
  await gt(args, cwd);
};

/**
 * Move down one branch in the stack (away from trunk).
 * Supports optional steps parameter to move multiple branches.
 */
export const gtDown = async (cwd: string, steps?: number): Promise<void> => {
  if (steps !== undefined && (steps < 1 || !Number.isInteger(steps))) {
    throw new Error("Steps must be a positive integer");
  }
  const args = ["down"];
  if (steps !== undefined) {
    args.push(String(steps));
  }
  await gt(args, cwd);
};

/**
 * Jump to the top of the current stack (closest to trunk).
 */
export const gtTop = async (cwd: string): Promise<void> => {
  await gt(["top"], cwd);
};

/**
 * Jump to the bottom of the current stack (furthest from trunk).
 */
export const gtBottom = async (cwd: string): Promise<void> => {
  await gt(["bottom"], cwd);
};

/**
 * Check out a specific branch in the stack.
 */
export const gtCheckout = async (
  cwd: string,
  branch: string
): Promise<void> => {
  if (!isValidGitRef(branch)) {
    throw new Error("Invalid branch name");
  }
  await gt(["checkout", branch], cwd);
};

/**
 * Check out trunk branch.
 */
export const gtCheckoutTrunk = async (cwd: string): Promise<void> => {
  await gt(["checkout", "--trunk"], cwd);
};

/**
 * Create a new branch off the current branch.
 */
export const gtCreate = async (
  cwd: string,
  name: string,
  opts?: CreateOpts
): Promise<void> => {
  if (!isValidGitRef(name)) {
    throw new Error("Invalid branch name");
  }
  if (opts?.message && !isValidMessage(opts.message)) {
    throw new Error("Invalid commit message");
  }
  const args = ["create", name];
  if (opts?.all) {
    args.push("--all");
  }
  if (opts?.message) {
    args.push("-m", opts.message);
  }
  await gt(args, cwd);
};

/**
 * Amend changes to current commit, or create a new commit.
 */
export const gtModify = async (
  cwd: string,
  opts?: ModifyOpts
): Promise<void> => {
  if (opts?.message && !isValidMessage(opts.message)) {
    throw new Error("Invalid commit message");
  }
  const args = ["modify"];
  if (opts?.all) {
    args.push("--all");
  }
  if (opts?.commit) {
    args.push("--commit");
  }
  if (opts?.message) {
    args.push("-m", opts.message);
  }
  await gt(args, cwd);
};

/**
 * Fold/merge the current branch into its parent.
 */
export const gtFold = async (cwd: string): Promise<void> => {
  await gt(["fold"], cwd);
};

/**
 * Squash commits in the current branch.
 */
export const gtSquash = async (
  cwd: string,
  opts?: SquashOpts
): Promise<void> => {
  if (opts?.message && !isValidMessage(opts.message)) {
    throw new Error("Invalid commit message");
  }
  const args = ["squash"];
  if (opts?.noEdit) {
    args.push("--no-edit");
  }
  if (opts?.message) {
    args.push("-m", opts.message);
  }
  await gt(args, cwd);
};

/**
 * Restack/rebase branches in the stack.
 */
export const gtRestack = async (
  cwd: string,
  opts?: RestackOpts
): Promise<void> => {
  // Validate mutual exclusivity of options
  const optionCount = [opts?.only, opts?.downstack, opts?.upstack].filter(
    Boolean
  ).length;
  if (optionCount > 1) {
    throw new Error(
      "RestackOpts: only, downstack, and upstack are mutually exclusive"
    );
  }
  const args = ["restack"];
  if (opts?.only) {
    args.push("--only");
  }
  if (opts?.downstack) {
    args.push("--downstack");
  }
  if (opts?.upstack) {
    args.push("--upstack");
  }
  await gt(args, cwd);
};

/**
 * Fetch and sync with remote (updates trunk).
 */
export const gtSync = async (cwd: string, opts?: SyncOpts): Promise<void> => {
  const args = ["sync"];
  if (opts?.force) {
    args.push("--force");
  }
  if (opts?.all) {
    args.push("--all");
  }
  if (opts?.restack) {
    args.push("--restack");
  }
  await gt(args, cwd);
};

/**
 * Submit branches as PRs.
 * @returns Array of submitted PRs with branch names, URLs, and actions
 */
export const gtSubmit = async (
  cwd: string,
  opts?: SubmitOpts
): Promise<SubmitResult[]> => {
  const args = ["submit"];
  if (opts?.draft) {
    args.push("--draft");
  }
  if (opts?.publish) {
    args.push("--publish");
  }
  if (opts?.stack) {
    args.push("--stack");
  }
  if (opts?.mergeWhenReady) {
    args.push("--merge-when-ready");
  }
  if (opts?.updateOnly) {
    args.push("--update-only");
  }
  if (opts?.noEdit) {
    args.push("--no-edit");
  }
  const { stdout } = await gt(args, cwd);

  // Parse PR URLs from output
  // Format: `branch-name: https://app.graphite.dev/... (created|updated)`
  const submitPrRegex = /^(\S+):\s+(https:\/\/\S+)\s+\((created|updated)\)$/gm;
  const results: SubmitResult[] = [];
  for (const match of stdout.matchAll(submitPrRegex)) {
    const branch = match[1];
    const prUrl = match[2];
    const action = match[3];
    if (branch && prUrl && (action === "created" || action === "updated")) {
      results.push({ branch, prUrl, action });
    }
  }

  return results;
};

/**
 * Rename the current branch.
 */
export const gtRename = async (cwd: string, newName: string): Promise<void> => {
  if (!isValidGitRef(newName)) {
    throw new Error("Invalid branch name");
  }
  await gt(["rename", newName], cwd);
};

/**
 * Delete a branch from the stack.
 */
export const gtDelete = async (
  cwd: string,
  branch: string,
  opts?: DeleteOpts
): Promise<void> => {
  if (!isValidGitRef(branch)) {
    throw new Error("Invalid branch name");
  }
  const args = ["delete", branch];
  if (opts?.close) {
    args.push("--close");
  }
  if (opts?.force) {
    args.push("--force");
  }
  await gt(args, cwd);
};

/**
 * Track an existing git branch in Graphite.
 */
export const gtTrack = async (cwd: string, branch: string): Promise<void> => {
  if (!isValidGitRef(branch)) {
    throw new Error("Invalid branch name");
  }
  await gt(["track", branch], cwd);
};

/**
 * Continue after resolving conflicts during rebase/restack.
 */
export const gtContinue = async (
  cwd: string,
  opts?: ContinueOpts
): Promise<void> => {
  const args = ["continue"];
  if (opts?.all) {
    args.push("--all");
  }
  await gt(args, cwd);
};
