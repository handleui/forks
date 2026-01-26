/**
 * MCP tools for terminal access.
 * Provides read-only and controlled terminal operations for agents.
 */

import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { normalize } from "node:path";
import type { Terminal, TerminalEvent } from "@forks-sh/protocol";
import type { StoreEventEmitter } from "@forks-sh/store";
import { z } from "zod";
import { spawnShell } from "../pty.js";
import type { PtyManager, TerminalSession } from "../pty-manager.js";

/** Security constants */
const MAX_CONCURRENT_AGENT_TERMINALS = 5;
const MAX_SPAWN_RATE_PER_MINUTE = 3;
const MIN_SPAWN_INTERVAL_MS = 5000; // 5 seconds between spawns (burst protection)
const MAX_CWD_LENGTH = 512;
const MAX_COMMAND_LENGTH = 1024;
const MAX_ID_LENGTH = 128;
const MAX_TOTAL_COMMAND_LENGTH = 4096; // Total command string length
const MAX_EVENTS_PER_MINUTE = 30; // Rate limit for terminal event emission
const MAX_LABEL_LENGTH = 100; // Truncate labels to prevent large payloads

/**
 * Patterns that may indicate sensitive data in command arguments.
 * Used to redact potentially sensitive information from event payloads.
 */
const SENSITIVE_ARG_PATTERNS = [
  /^[A-Za-z0-9_]+=.+/, // Environment variable assignment (KEY=value)
  /^--[a-z-]+[=:].*(key|token|secret|password|pass|auth|credential)/i, // Flags with sensitive values
  /^(sk_|pk_|api[_-]?key[_-]?|token[_-]?|secret[_-]?|password[_-]?)/i, // Common secret prefixes
  /^ghp_[a-zA-Z0-9]+$/, // GitHub personal access tokens
  /^ghu_[a-zA-Z0-9]+$/, // GitHub user tokens
  /^ghs_[a-zA-Z0-9]+$/, // GitHub server tokens
  /^gho_[a-zA-Z0-9]+$/, // GitHub OAuth tokens
  /^npm_[a-zA-Z0-9]+$/, // npm tokens
  /^xox[bsrap]-[a-zA-Z0-9-]+$/, // Slack tokens
  /^eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/, // JWT tokens
  /^AKIA[A-Z0-9]{16}$/, // AWS access key IDs
  /^[a-zA-Z0-9/+=]{40}$/, // AWS secret access keys (base64-like, 40 chars)
];

/** Top-level regex patterns for performance */
const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:\\/;
const PATH_SEPARATOR_REGEX = /[/\\]/;
const SHELL_METACHAR_REGEX = /[;&|`$()]/;
const BACKTICK_CMD_REGEX = /`[^`]*`/;
const DOLLAR_PAREN_CMD_REGEX = /\$\([^)]*\)/;
const SAFE_SHELL_CHARS_REGEX = /^[a-zA-Z0-9._\-/=@:]+$/;

/** Dangerous command blocklist - comprehensive set of system-critical commands */
const BLOCKED_COMMANDS = new Set([
  // File destruction
  "rm",
  "rmdir",
  "shred",
  "unlink",
  // Privilege escalation
  "sudo",
  "su",
  "doas",
  "pkexec",
  // File permissions
  "chmod",
  "chown",
  "chgrp",
  "chattr",
  "setfacl",
  // Disk/filesystem operations
  "mkfs",
  "dd",
  "fdisk",
  "parted",
  "gdisk",
  "mount",
  "umount",
  "losetup",
  "mkswap",
  "swapon",
  "swapoff",
  // System control
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init",
  "systemctl",
  "service",
  // Process control
  "kill",
  "killall",
  "pkill",
  "nohup",
  "disown",
  // Shell interpreters (prevent shell escape)
  "sh",
  "bash",
  "zsh",
  "fish",
  "csh",
  "tcsh",
  "ksh",
  "dash",
  "ash",
  // Network utilities (potential for data exfiltration)
  "nc",
  "netcat",
  "ncat",
  "socat",
  "telnet",
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "rsync",
  "wget",
  "curl",
  // Code execution
  "python",
  "python3",
  "python2",
  "perl",
  "ruby",
  "php",
  "node",
  "lua",
  "tclsh",
  "wish",
  "expect",
  "awk",
  "gawk",
  "mawk",
  "nawk",
  "sed",
  // Compilers/interpreters that could execute arbitrary code
  "gcc",
  "g++",
  "clang",
  "clang++",
  "make",
  "cmake",
  // Cron/scheduled tasks
  "crontab",
  "at",
  "batch",
  // User management
  "useradd",
  "userdel",
  "usermod",
  "groupadd",
  "groupdel",
  "passwd",
  "chpasswd",
  // Environment manipulation
  "env",
  "export",
  "source",
  // Dangerous utilities
  "xargs",
  "find", // Can execute commands via -exec
  "tar", // Can overwrite files
  "cpio",
  "ar",
  "zip",
  "unzip",
  "gzip",
  "gunzip",
  "bzip2",
  "xz",
  // System information (potential reconnaissance)
  "strace",
  "ltrace",
  "gdb",
  "objdump",
  "nm",
  // Kernel/module operations
  "insmod",
  "rmmod",
  "modprobe",
  "depmod",
  // Container escape vectors
  "docker",
  "podman",
  "kubectl",
  "crictl",
  // chroot/namespace
  "chroot",
  "unshare",
  "nsenter",
]);

/** Dangerous command patterns - OWASP recommended metacharacter detection */
const BLOCKED_PATTERNS = [
  // File operations on root/system paths
  /rm\s+(-[rf]+\s+)*\//i, // rm -rf /
  />\s*\/dev\//i, // > /dev/
  />\s*\/etc\//i, // > /etc/
  />\s*\/proc\//i, // > /proc/
  />\s*\/sys\//i, // > /sys/
  />\s*\/boot\//i, // > /boot/

  // Command chaining and piping to shells
  /\|\s*sh\b/i, // | sh
  /\|\s*bash\b/i, // | bash
  /\|\s*zsh\b/i, // | zsh
  /\|\s*dash\b/i, // | dash
  /\|\s*ksh\b/i, // | ksh
  /\|\s*csh\b/i, // | csh
  /\|\s*fish\b/i, // | fish

  // Command substitution (shell escape vectors)
  /eval\s+/i, // eval command
  /`[^`]+`/, // backticks command substitution
  /\$\([^)]+\)/, // $() command substitution
  /\$\{[^}]+\}/, // ${} parameter expansion (can execute commands)

  // Shell metacharacters for command chaining (OWASP recommended)
  // Note: [;&|] removed - already caught by per-argument SHELL_METACHAR_REGEX check
  /\$\w+/, // Variable expansion
  /\n/, // Newline injection
  /\r/, // Carriage return injection

  // Redirection attacks
  />>\s*/, // Append redirection
  /2>&1/, // Stderr redirection
  /&>\s*/, // Combined redirection

  // Path traversal patterns
  /\.\.\//, // ../ directory traversal
  /\.\.\\/, // ..\ Windows directory traversal

  // Null byte injection (URL-encoded form - raw null bytes handled separately)
  /%00/, // URL-encoded null byte

  // Escape sequences that could bypass validation
  /\\x[0-9a-fA-F]{2}/, // Hex escapes
  /\\u[0-9a-fA-F]{4}/, // Unicode escapes
  /\\[0-7]{1,3}/, // Octal escapes

  // Glob patterns that could match sensitive files
  /\/\*/, // /* glob
  /\*\./, // *.ext glob

  // Base64 decode tricks (common bypass)
  /base64\s+-d/i, // base64 decode
  /base64\s+--decode/i, // base64 --decode

  // Process substitution
  /<\([^)]+\)/, // <() process substitution
  />\([^)]+\)/, // >() process substitution

  // Here documents/strings (can embed commands)
  /<<[<-]?\s*\w+/, // heredoc
  /<<</, // herestring

  // Alias/function tricks
  /alias\s+/i, // alias definitions
  /function\s+\w+/i, // function definitions
  /\w+\s*\(\s*\)\s*\{/, // function shorthand

  // History expansion
  /![\w!#$*-]/, // bash history expansion
];

/** Protected system directories - prevent access via cwd */
const PROTECTED_PATHS = [
  "/",
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/etc",
  "/var",
  "/root",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/lib",
  "/lib64",
  "/usr/lib",
  "/opt",
  "/System", // macOS
  "/Library", // macOS
  "/Applications", // macOS
  "/private", // macOS
  "C:\\Windows", // Windows
  "C:\\Program Files", // Windows
  "C:\\Program Files (x86)", // Windows
];

/** Allowlisted safe commands - only these base commands are permitted */
const ALLOWED_COMMANDS = new Set([
  // Package managers (read/install operations)
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "bun",
  "bunx",
  "deno",
  // Build tools
  "turbo",
  "nx",
  "lerna",
  "vite",
  "esbuild",
  "rollup",
  "webpack",
  "tsc",
  "tsup",
  // Dev servers / runners
  "next",
  "nuxt",
  "astro",
  "remix",
  "gatsby",
  "expo",
  "react-native",
  // Testing
  "jest",
  "vitest",
  "playwright",
  "cypress",
  "mocha",
  "ava",
  // Linting/formatting
  "eslint",
  "prettier",
  "biome",
  "oxlint",
  // Read-only utilities
  "ls",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "diff",
  "grep",
  "tree",
  "pwd",
  "echo",
  "which",
  "whoami",
  "date",
  "uname",
  "printenv",
  // Directory operations (safe)
  "cd",
  "mkdir",
  // Git (read operations only - see ALLOWED_GIT_SUBCOMMANDS)
  "git",
]);

/**
 * Allowed git subcommands (read-only operations).
 * Git can execute arbitrary code via hooks, aliases, and config.
 * Restricting to read-only subcommands prevents code execution.
 */
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  // Status and info
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "remote",
  "rev-parse",
  "rev-list",
  // File listing
  "ls-files",
  "ls-tree",
  "ls-remote",
  // Object inspection
  "cat-file",
  "describe",
  "blame",
  "shortlog",
  "name-rev",
  // Tags and refs
  "tag",
  "for-each-ref",
  // Stash (read only)
  "stash", // list is safe, but push/pop blocked by subcommand check below
  // Worktree info
  "worktree",
]);

/** Git subcommands that are dangerous even within allowed commands */
const BLOCKED_GIT_SUBCOMMANDS = new Set([
  // Config can set hooks and executables
  "config",
  // These can modify state
  "push",
  "pull",
  "fetch",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "reset",
  "checkout",
  "switch",
  "restore",
  "add",
  "commit",
  "rm",
  "mv",
  "clean",
  "gc",
  "prune",
  "reflog",
  "fsck",
  // Submodules can execute code
  "submodule",
  // Hooks and filters
  "filter-branch",
  "filter-repo",
]);

/** Validate cwd path for security */
const isPathSafe = (cwdPath: string): { safe: boolean; reason?: string } => {
  // Must be absolute path
  if (!(cwdPath.startsWith("/") || WINDOWS_DRIVE_PATH_REGEX.test(cwdPath))) {
    return { safe: false, reason: "Path must be absolute" };
  }

  // Normalize and resolve to catch path traversal
  const normalized = normalize(cwdPath);

  // Check for path traversal attempts in normalized path
  if (normalized.includes("..")) {
    return { safe: false, reason: "Path traversal not allowed" };
  }

  // Check against protected paths
  for (const protectedPath of PROTECTED_PATHS) {
    const normalizedProtected = protectedPath.toLowerCase();
    const normalizedInput = normalized.toLowerCase();
    if (
      normalizedInput === normalizedProtected ||
      normalizedInput.startsWith(`${normalizedProtected}/`) ||
      normalizedInput.startsWith(`${normalizedProtected}\\`)
    ) {
      return { safe: false, reason: "Access to system directory not allowed" };
    }
  }

  // Verify directory exists and is actually a directory
  try {
    if (!existsSync(normalized)) {
      return { safe: false, reason: "Directory does not exist" };
    }
    const stats = statSync(normalized);
    if (!stats.isDirectory()) {
      return { safe: false, reason: "Path is not a directory" };
    }
  } catch {
    return { safe: false, reason: "Cannot access directory" };
  }

  return { safe: true };
};

/** Rate limiting state */
interface RateLimitState {
  agentTerminalCounts: Map<string, number>;
  spawnTimestamps: number[];
  eventTimestamps: number[];
}

const rateLimitState: RateLimitState = {
  agentTerminalCounts: new Map(),
  spawnTimestamps: [],
  eventTimestamps: [],
};

/**
 * Check if an argument looks like sensitive data that should be redacted.
 * This prevents leaking secrets like API keys, tokens, passwords in events.
 */
const isSensitiveArg = (arg: string): boolean => {
  for (const pattern of SENSITIVE_ARG_PATTERNS) {
    if (pattern.test(arg)) {
      return true;
    }
  }
  return false;
};

/**
 * Sanitize command array for safe inclusion in events.
 * Redacts potentially sensitive arguments to prevent information leakage.
 */
const sanitizeCommandForEvent = (
  command: string[] | undefined
): string[] | undefined => {
  if (!command || command.length === 0) {
    return command;
  }
  return command.map((arg, index) => {
    // Always keep the base command (first element)
    if (index === 0) {
      return arg;
    }
    // Redact arguments that look like sensitive data
    if (isSensitiveArg(arg)) {
      return "[REDACTED]";
    }
    return arg;
  });
};

/**
 * Create a safe label from command, with length limits and sanitization.
 */
const createSafeLabel = (command: string[] | undefined): string | null => {
  if (!command || command.length === 0) {
    return null;
  }
  const sanitized = sanitizeCommandForEvent(command);
  if (!sanitized) {
    return null;
  }
  const label = sanitized.join(" ");
  if (label.length > MAX_LABEL_LENGTH) {
    return `${label.slice(0, MAX_LABEL_LENGTH - 3)}...`;
  }
  return label;
};

/**
 * Check event emission rate limit.
 * Prevents event flooding that could overwhelm consumers.
 */
const checkEventRateLimit = (): boolean => {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;

  // Clean old timestamps
  rateLimitState.eventTimestamps = rateLimitState.eventTimestamps.filter(
    (ts) => ts > oneMinuteAgo
  );

  // Check rate limit
  if (rateLimitState.eventTimestamps.length >= MAX_EVENTS_PER_MINUTE) {
    return false;
  }

  return true;
};

/** Record an event emission for rate limiting */
const recordEventEmission = () => {
  rateLimitState.eventTimestamps.push(Date.now());
};

/**
 * Escape a shell argument for safe inclusion in a command string.
 * Uses single quotes and escapes embedded single quotes.
 */
const escapeShellArg = (arg: string): string => {
  // Safe chars that don't need quoting (uses top-level regex for performance)
  if (SAFE_SHELL_CHARS_REGEX.test(arg)) {
    return arg;
  }
  // Wrap in single quotes, escape embedded single quotes
  return `'${arg.replace(/'/g, "'\\''")}'`;
};

/**
 * Build a properly escaped command string from an array of arguments.
 */
const buildShellCommand = (command: string[]): string =>
  command.map(escapeShellArg).join(" ");

/** Extract base command name (handles paths like /usr/bin/rm) */
const getBaseCommand = (cmd: string): string => {
  const normalized = cmd.toLowerCase();
  // Handle absolute paths: /usr/bin/rm -> rm
  const parts = normalized.split(PATH_SEPARATOR_REGEX);
  return parts.at(-1) ?? normalized;
};

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/** Validate git subcommand against allowlist/blocklist */
const validateGitSubcommand = (
  subcommand: string | undefined
): ValidationResult => {
  const gitSubcommand = subcommand?.toLowerCase() ?? "";
  if (BLOCKED_GIT_SUBCOMMANDS.has(gitSubcommand)) {
    return {
      valid: false,
      reason: `Git subcommand '${gitSubcommand}' is blocked`,
    };
  }
  if (!ALLOWED_GIT_SUBCOMMANDS.has(gitSubcommand)) {
    return {
      valid: false,
      reason: `Git subcommand '${gitSubcommand}' is not in the allowed list`,
    };
  }
  return { valid: true };
};

/**
 * Validate a single argument for dangerous patterns.
 * Intentionally strict: blocks chars like ; | & even in quoted strings.
 * Since args come as array elements without shell context, we can't
 * distinguish "literal semicolon" from "command injection attempt".
 */
const validateArgument = (arg: string): ValidationResult => {
  if (arg.includes("\x00") || arg.includes("%00")) {
    return { valid: false, reason: "Null byte detected in argument" };
  }
  if (SHELL_METACHAR_REGEX.test(arg)) {
    return { valid: false, reason: "Shell metacharacters in argument" };
  }
  if (BACKTICK_CMD_REGEX.test(arg) || DOLLAR_PAREN_CMD_REGEX.test(arg)) {
    return { valid: false, reason: "Command substitution detected" };
  }
  return { valid: true };
};

/** Check full command string against blocked patterns */
const checkBlockedPatterns = (fullCommand: string): ValidationResult => {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(fullCommand)) {
      return { valid: false, reason: "Dangerous pattern detected in command" };
    }
  }
  return { valid: true };
};

/** Validate command against security rules */
const validateCommand = (command: string[]): ValidationResult => {
  if (command.length === 0) {
    return { valid: false, reason: "Empty command" };
  }

  const baseCommand = getBaseCommand(command[0] ?? "");

  if (BLOCKED_COMMANDS.has(baseCommand)) {
    return { valid: false, reason: `Command '${baseCommand}' is blocked` };
  }

  if (!ALLOWED_COMMANDS.has(baseCommand)) {
    return {
      valid: false,
      reason: `Command '${baseCommand}' is not in the allowed list`,
    };
  }

  // Git requires subcommand validation (can execute code via hooks/config)
  if (baseCommand === "git" && command.length > 1) {
    const gitResult = validateGitSubcommand(command[1]);
    if (!gitResult.valid) {
      return gitResult;
    }
  }

  // Check each argument for dangerous patterns
  for (const arg of command) {
    const argResult = validateArgument(arg);
    if (!argResult.valid) {
      return argResult;
    }
  }

  return checkBlockedPatterns(command.join(" "));
};

/** Check spawn rate limit with burst protection */
const checkSpawnRateLimit = (): { allowed: boolean; reason?: string } => {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;

  // Clean old timestamps
  rateLimitState.spawnTimestamps = rateLimitState.spawnTimestamps.filter(
    (ts) => ts > oneMinuteAgo
  );

  // Check burst limit (minimum interval between spawns)
  const lastSpawn = rateLimitState.spawnTimestamps.at(-1);
  if (lastSpawn && now - lastSpawn < MIN_SPAWN_INTERVAL_MS) {
    const waitTime = Math.ceil(
      (MIN_SPAWN_INTERVAL_MS - (now - lastSpawn)) / 1000
    );
    return {
      allowed: false,
      reason: `Please wait ${waitTime} seconds between terminal spawns`,
    };
  }

  // Check rate limit (max per minute)
  if (rateLimitState.spawnTimestamps.length >= MAX_SPAWN_RATE_PER_MINUTE) {
    return {
      allowed: false,
      reason: `Maximum ${MAX_SPAWN_RATE_PER_MINUTE} terminal spawns per minute reached`,
    };
  }

  return { allowed: true };
};

/** Record a spawn for rate limiting */
const recordSpawn = () => {
  rateLimitState.spawnTimestamps.push(Date.now());
};

/** Count agent terminals */
const countAgentTerminals = (ptyManager: PtyManager): number => {
  const sessions = ptyManager.listWithMetadata();
  return sessions.filter((s) => s.owner === "agent").length;
};

/** Zod schemas for terminal tool validation */
const idSchema = z.string().min(1).max(MAX_ID_LENGTH);

export const terminalToolSchemas = {
  list_terminals: z.object({}),
  read_terminal: z.object({ terminalId: idSchema }),
  spawn_background_terminal: z.object({
    cwd: z.string().min(1).max(MAX_CWD_LENGTH),
    command: z.array(z.string().max(MAX_COMMAND_LENGTH)).min(1).max(20),
  }),
  promote_terminal: z.object({ terminalId: idSchema }),
  kill_terminal: z.object({ terminalId: idSchema }),
} as const;

export type TerminalToolName = keyof typeof terminalToolSchemas;

/** Tool definitions for MCP server */
export const TERMINAL_TOOL_DEFINITIONS = [
  {
    name: "list_terminals",
    description:
      "List all terminal sessions with metadata (id, cwd, owner, visible)",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "read_terminal",
    description:
      "Get the output history buffer for a terminal (for @terminal context)",
    inputSchema: {
      type: "object" as const,
      properties: {
        terminalId: {
          type: "string",
          description: "The ID of the terminal to read",
        },
      },
      required: ["terminalId"],
    },
  },
  {
    name: "spawn_background_terminal",
    description:
      "Spawn a background terminal for running dev servers, tests, etc.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cwd: {
          type: "string",
          description: "Working directory for the terminal",
        },
        command: {
          type: "array",
          items: { type: "string" },
          description:
            'Command and arguments to run (e.g., ["npm", "run", "dev"])',
        },
      },
      required: ["cwd", "command"],
    },
  },
  {
    name: "promote_terminal",
    description:
      "Promote a background terminal to visible (for Cursor handoff)",
    inputSchema: {
      type: "object" as const,
      properties: {
        terminalId: {
          type: "string",
          description: "The ID of the terminal to promote",
        },
      },
      required: ["terminalId"],
    },
  },
  {
    name: "kill_terminal",
    description:
      "Kill a background terminal owned by this agent. Cannot kill visible or user-owned terminals.",
    inputSchema: {
      type: "object" as const,
      properties: {
        terminalId: {
          type: "string",
          description: "The ID of the terminal to kill",
        },
      },
      required: ["terminalId"],
    },
  },
];

interface ToolResponse {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/** Helper to create a success response */
const successResponse = (data: unknown): ToolResponse => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
});

/** Helper to create an error response */
const errorResponse = (message: string): ToolResponse => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

type TerminalToolHandler = (
  data: unknown,
  ptyManager: PtyManager
) => ToolResponse;

/**
 * Convert TerminalSession to protocol Terminal type for events.
 * Sanitizes command data to prevent sensitive information leakage.
 *
 * Security considerations:
 * - Command arguments are sanitized to redact potential secrets
 * - Labels are truncated to prevent oversized payloads
 * - workspaceId is intentionally null (not yet implemented)
 */
const sessionToTerminal = (
  session: TerminalSession,
  exitCode?: number
): Terminal => ({
  id: session.id,
  // SECURITY: workspaceId is intentionally null - not yet implemented
  workspaceId: null,
  createdBy: session.owner,
  // SECURITY: Label is sanitized and truncated to prevent sensitive data leakage
  label: createSafeLabel(session.command),
  cwd: session.cwd,
  visibility: session.visible ? "visible" : "background",
  status: exitCode !== undefined ? "exited" : "running",
  exitCode: exitCode ?? null,
  // SECURITY: Command args are sanitized to redact potential secrets
  command: sanitizeCommandForEvent(session.command),
  createdAt: session.createdAt,
});

/**
 * Emit a terminal event to the store emitter.
 *
 * Security features:
 * - Rate limiting to prevent event flooding (max 30/min)
 * - Sanitized terminal data (sensitive args redacted)
 * - Validated session data before emission
 */
const emitTerminalEvent = (
  emitter: StoreEventEmitter | undefined,
  eventType: "created" | "promoted" | "closed",
  session: TerminalSession,
  exitCode?: number
) => {
  if (!emitter) {
    return;
  }

  // SECURITY: Rate limit event emission to prevent flooding
  if (!checkEventRateLimit()) {
    // Silently drop event if rate limited - this is a safety measure
    // The underlying operation still succeeds, just the event is not emitted
    return;
  }

  // Validate session has required fields before emitting
  if (!session.id || typeof session.id !== "string") {
    return;
  }

  const event: TerminalEvent = {
    type: "terminal",
    event: eventType,
    terminal: sessionToTerminal(session, exitCode),
  };

  recordEventEmission();
  emitter.emit("agent", event);
};

const handleListTerminals: TerminalToolHandler = (_data, ptyManager) => {
  const sessions = ptyManager.listWithMetadata();
  return successResponse(sessions);
};

const handleReadTerminal: TerminalToolHandler = (data, ptyManager) => {
  const { terminalId } = data as { terminalId: string };
  const history = ptyManager.getHistory(terminalId);
  if (history === null) {
    return errorResponse("Terminal not found");
  }
  return successResponse({ terminalId, history });
};

/** Create spawn handler with emitter for event emission */
const createSpawnHandler =
  (emitter?: StoreEventEmitter): TerminalToolHandler =>
  (data, ptyManager) => {
    const { cwd, command } = data as { cwd: string; command: string[] };

    // Security checks - order matters for defense in depth

    // 1. Validate cwd path
    const pathValidation = isPathSafe(cwd);
    if (!pathValidation.safe) {
      return errorResponse(`Invalid cwd: ${pathValidation.reason}`);
    }

    // 2. Validate command
    const commandValidation = validateCommand(command);
    if (!commandValidation.valid) {
      return errorResponse(
        `Command rejected: ${commandValidation.reason ?? "security check failed"}`
      );
    }

    // 3. Check total command length
    const totalLength = command.join(" ").length;
    if (totalLength > MAX_TOTAL_COMMAND_LENGTH) {
      return errorResponse(
        `Command too long: ${totalLength} chars (max ${MAX_TOTAL_COMMAND_LENGTH})`
      );
    }

    // 4. Rate limiting
    const rateLimit = checkSpawnRateLimit();
    if (!rateLimit.allowed) {
      return errorResponse(rateLimit.reason ?? "Rate limit exceeded");
    }

    // 5. Concurrent terminal limit
    if (countAgentTerminals(ptyManager) >= MAX_CONCURRENT_AGENT_TERMINALS) {
      return errorResponse("Maximum concurrent agent terminals reached (5)");
    }

    // Spawn the terminal
    const pty = spawnShell({ cwd });
    const id = `pty-${randomUUID()}`;

    ptyManager.register(id, pty, cwd, {
      owner: "agent",
      visible: false,
      command,
      onClose: (closedSession, exitCode) => {
        emitTerminalEvent(emitter, "closed", closedSession, exitCode);
      },
    });

    // Send the command
    pty.write(`${buildShellCommand(command)}\n`);

    // Register cleanup (onClose callback handles closed event emission)
    pty.onExit(() => ptyManager.unregister(id));

    recordSpawn();

    const session = ptyManager.getMetadata(id);
    if (session) {
      emitTerminalEvent(emitter, "created", session);
    }
    return successResponse(session);
  };

/** Create promote handler with emitter for event emission */
const createPromoteHandler =
  (emitter?: StoreEventEmitter): TerminalToolHandler =>
  (data, ptyManager) => {
    const { terminalId } = data as { terminalId: string };
    const success = ptyManager.setVisible(terminalId, true);
    if (!success) {
      return errorResponse("Terminal not found");
    }
    const session = ptyManager.getMetadata(terminalId);
    if (session) {
      emitTerminalEvent(emitter, "promoted", session);
    }
    return successResponse(session);
  };

/** Create kill handler with emitter for event emission */
const createKillHandler =
  (emitter?: StoreEventEmitter): TerminalToolHandler =>
  (data, ptyManager) => {
    const { terminalId } = data as { terminalId: string };
    const session = ptyManager.getMetadata(terminalId);

    // Idempotent: already gone = success
    if (!session) {
      return successResponse({ terminated: true });
    }

    // Security: only kill agent-owned background terminals
    if (session.owner !== "agent" || session.visible) {
      return errorResponse("Cannot kill visible or user-owned terminals");
    }

    // Emit closed event before unregister clears metadata
    // Use -1 as exit code for manually killed terminals
    emitTerminalEvent(emitter, "closed", session, -1);

    ptyManager.unregister(terminalId);
    return successResponse({ terminated: true, id: terminalId });
  };

/** Create terminal tool handlers with optional event emitter */
export const createTerminalToolHandlers = (
  emitter?: StoreEventEmitter
): Record<TerminalToolName, TerminalToolHandler> => ({
  list_terminals: handleListTerminals,
  read_terminal: handleReadTerminal,
  spawn_background_terminal: createSpawnHandler(emitter),
  promote_terminal: createPromoteHandler(emitter),
  kill_terminal: createKillHandler(emitter),
});
