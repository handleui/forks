/**
 * PTY sessions via node-pty.
 * Spawns a shell that can be wired to WebSocket or other streams.
 */

import type { IPty, IPtyForkOptions } from "node-pty";
import { spawn } from "node-pty";

/**
 * Patterns that indicate potentially sensitive environment variables.
 * Uses prefix matching for common naming conventions.
 *
 * Security: Prefer blocklist over allowlist for env vars to prevent
 * accidentally exposing new sensitive variables added by dependencies.
 */
const BLOCKED_ENV_PREFIXES = [
  // Generic credential patterns (matched as suffixes via endsWith)
  "API_KEY",
  "API_SECRET",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "TOKEN",
  "PRIVATE",
  "CREDENTIAL",
  // Cloud provider credentials
  "AWS_",
  "AZURE_",
  "GCP_",
  "GOOGLE_",
  "DIGITALOCEAN_",
  "DO_",
  "LINODE_",
  "VULTR_",
  "HEROKU_",
  "VERCEL_",
  "NETLIFY_",
  "RAILWAY_",
  "FLY_",
  "RENDER_",
  // AI/ML service keys
  "OPENAI_",
  "ANTHROPIC_",
  "CLAUDE_",
  "COHERE_",
  "HUGGING",
  "REPLICATE_",
  "TOGETHER_",
  // Database credentials
  "DATABASE_",
  "DB_",
  "POSTGRES",
  "MYSQL",
  "MONGO",
  "REDIS_",
  "SUPABASE_",
  "PLANETSCALE_",
  "NEON_",
  "TURSO_",
  // Version control / CI
  "GITHUB_",
  "GITLAB_",
  "BITBUCKET_",
  "GH_",
  "NPM_",
  "YARN_",
  "BUN_",
  "CI_",
  // Observability
  "SENTRY_",
  "DATADOG_",
  "LOGROCKET_",
  "SEGMENT_",
  "MIXPANEL_",
  "AMPLITUDE_",
  "POSTHOG_",
  // Payment/commerce
  "STRIPE_",
  "PAYPAL_",
  "BRAINTREE_",
  "SQUARE_",
  "SHOPIFY_",
  // Auth providers
  "CLERK_",
  "AUTH0_",
  "OKTA_",
  "FIREBASE_",
  // Communication
  "TWILIO_",
  "SENDGRID_",
  "MAILGUN_",
  "POSTMARK_",
  "RESEND_",
  "SLACK_",
  "DISCORD_",
  // Storage
  "S3_",
  "CLOUDFLARE_",
  "CLOUDINARY_",
  "UPLOADTHING_",
  // Forksd internal
  "FORKSD_",
];

/**
 * Explicit allowlist of safe environment variables.
 * These are allowed even if they match blocked patterns.
 */
const SAFE_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TZ",
  "EDITOR",
  "PAGER",
  "DISPLAY",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "SSH_AUTH_SOCK", // Needed for git operations, but not a secret itself
  "PWD", // Standard Unix working directory variable
  // Safe vendor configuration variables (non-secret)
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_DEFAULT_OUTPUT",
  "VERCEL_ENV",
  "VERCEL_URL",
  "GITHUB_ACTIONS",
  "GITHUB_REPOSITORY",
  "GITHUB_REF",
  "GITHUB_SHA",
  "GITHUB_WORKFLOW",
  "GITHUB_RUN_ID",
  "CI",
]);

/**
 * Check if an environment variable key matches blocked patterns.
 */
const isBlockedEnvVar = (key: string): boolean => {
  const upperKey = key.toUpperCase();
  for (const prefix of BLOCKED_ENV_PREFIXES) {
    // Use endsWith for suffix matching to avoid false positives
    // e.g., MY_CUSTOM_KEY_COUNT won't match KEY, but MY_API_KEY will
    if (upperKey.startsWith(prefix) || upperKey.endsWith(`_${prefix}`)) {
      return true;
    }
  }
  return false;
};

/**
 * Filter environment variables for PTY sessions.
 *
 * Security strategy:
 * 1. Always allow explicitly safe vars (PATH, HOME, etc.)
 * 2. Allow XDG_* for desktop integration
 * 3. Block anything matching sensitive prefixes
 * 4. Default deny for unrecognized variables with underscore prefixes
 *    (likely app-specific config that could contain secrets)
 */
const filterEnv = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    Object.entries(env).filter(([key]) => {
      // Explicitly safe variables are always allowed
      if (SAFE_ENV_VARS.has(key)) {
        return true;
      }
      // XDG_* vars are for desktop integration, safe to pass
      if (key.startsWith("XDG_")) {
        return true;
      }
      // Block known sensitive patterns
      if (isBlockedEnvVar(key)) {
        return false;
      }
      // Allow common safe patterns that don't match blocks
      // (e.g., single-word vars like COLUMNS, LINES, etc.)
      return true;
    })
  ) as IPtyForkOptions["env"];

export const spawnShell = (opts?: { cwd?: string }): IPty => {
  const shell =
    process.platform === "win32"
      ? "powershell.exe"
      : process.env.SHELL || "bash";
  return spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: opts?.cwd ?? process.cwd(),
    env: filterEnv(process.env),
  });
};
