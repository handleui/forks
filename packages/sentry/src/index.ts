/** @forks-sh/sentry - shared Sentry scrubbing utilities */

/**
 * Regex for sensitive header/cookie keys.
 * Used to filter sensitive values from request headers and cookies.
 */
export const SENSITIVE_KEYS =
  /^(authorization|cookie|password|secret|token|apikey|api_key|api-key|x-api-key|auth|bearer|credential|private|session)/i;

/**
 * Specific patterns for known sensitive formats to avoid false positives on UUIDs/base64/SHAs.
 * Matches: Bearer tokens, various API keys (OpenAI, Anthropic, AWS, GCP, Stripe, etc.),
 * GitHub tokens, GitLab tokens, Slack tokens, JWTs, database connection strings,
 * private key headers, npm tokens, Discord tokens, Vercel tokens, and Basic Auth in URLs.
 */
export const SENSITIVE_VALUES = new RegExp(
  [
    /Bearer\s+[^\s]+/.source, // Bearer tokens
    /sk-[a-zA-Z0-9]{20,}/.source, // OpenAI API keys
    /sk-ant-api\d{2}-[a-zA-Z0-9_-]{80,}/.source, // Anthropic API keys
    /AKIA[0-9A-Z]{16}/.source, // AWS access keys
    /AIza[a-zA-Z0-9_-]{35}/.source, // Google Cloud API keys
    /ya29\.[0-9A-Za-z_-]+/.source, // Google OAuth tokens
    /sk_live_[a-zA-Z0-9]{24,}/.source, // Stripe live secret keys
    /sk_test_[a-zA-Z0-9]{24,}/.source, // Stripe test secret keys
    /rk_live_[a-zA-Z0-9]{24,}/.source, // Stripe restricted keys (live)
    /rk_test_[a-zA-Z0-9]{24,}/.source, // Stripe restricted keys (test)
    /SG\.[a-zA-Z0-9]{22}\.[a-zA-Z0-9]{43}/.source, // SendGrid API keys
    /gh[ps]_[a-zA-Z0-9]{36}/.source, // GitHub tokens (classic)
    /github_pat_[a-zA-Z0-9_]{22,}/.source, // GitHub fine-grained PATs
    /gho_[a-zA-Z0-9]{36}/.source, // GitHub OAuth tokens
    /ghu_[a-zA-Z0-9]{36}/.source, // GitHub user-to-server tokens
    /glpat-[0-9a-zA-Z_-]{20}/.source, // GitLab Personal Access Tokens
    /xox[baprs]-[a-zA-Z0-9-]+/.source, // Slack tokens
    /https:\/\/hooks\.slack\.com\/services\/T[a-zA-Z0-9_]{8}\/B[a-zA-Z0-9_]{8}\/[a-zA-Z0-9_]{24}/
      .source, // Slack webhooks
    /\bkey-[0-9a-fA-F]{32}\b/.source, // Mailgun API keys (hex only, word boundaries)
    /[0-9a-f]{32}-us[0-9]{1,2}/.source, // MailChimp API keys
    /npm_[a-zA-Z0-9]{36}/.source, // npm tokens
    /pypi-[a-zA-Z0-9_-]{48,}/.source, // PyPI tokens
    // Discord bot tokens: three base64 parts separated by dots (bot_id.timestamp.hmac).
    // Full token format required - reduces false positives vs matching just the prefix.
    /[NMO][a-zA-Z0-9]{23,}\.[a-zA-Z0-9_-]{6}\.[a-zA-Z0-9_-]{27,}/.source,
    /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+/.source, // JWT tokens
    /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PGP)?\s*PRIVATE\s+KEY-----/.source, // Private key headers
    /mongodb\+srv:\/\/[^\s]+/.source, // MongoDB connection strings
    /postgres(?:ql)?:\/\/[^\s]+/.source, // PostgreSQL connection strings
    /mysql:\/\/[^\s]+/.source, // MySQL connection strings
    /redis:\/\/[^\s]+/.source, // Redis connection strings
    /https?:\/\/[^:]+:[^@]+@[^\s]+/.source, // Basic auth in URLs

    // Additional cloud provider tokens
    /vercel_[a-zA-Z0-9]{24,}/.source, // Vercel tokens
    /hf_[a-zA-Z0-9]{34,}/.source, // Hugging Face tokens
    /r8_[a-zA-Z0-9]{36,}/.source, // Replicate API tokens
    /lin_api_[a-zA-Z0-9]{40,}/.source, // Linear API keys
    /railway_[a-zA-Z0-9]{32,}/.source, // Railway tokens
    /rnd_[a-zA-Z0-9]{24,}/.source, // Render API keys
    /pscale_tkn_[a-zA-Z0-9_]{32,}/.source, // PlanetScale tokens
    /dop_v1_[a-zA-Z0-9]{64}/.source, // DigitalOcean personal access tokens
    /do_v1_[a-zA-Z0-9]{64}/.source, // DigitalOcean OAuth tokens

    // Twilio tokens (Account SID + Auth Token patterns)
    /\bAC[a-zA-Z0-9]{32}\b/.source, // Twilio Account SID (word boundaries)
    /\bSK[a-zA-Z0-9]{32}\b/.source, // Twilio API Key SID (word boundaries)

    // Datadog
    /dd[apk]_[a-zA-Z0-9]{32,}/.source, // Datadog API/APP keys

    // Cloudflare
    /cf_[a-zA-Z0-9_-]{37,}/.source, // Cloudflare API tokens

    // Azure connection strings (partial match to avoid false positives)
    /AccountKey=[a-zA-Z0-9+/=]{44,}/.source, // Azure Storage account keys
    /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[^;]+/.source, // Azure Storage connection string

    // Supabase
    /sbp_[a-zA-Z0-9]{40,}/.source, // Supabase service role key prefix

    // Generic patterns for query strings (common in URLs/logs)
    /[?&](?:api[_-]?key|apikey|token|secret|password|auth|key)=[^&\s]{8,}/
      .source, // Query string secrets
  ].join("|"),
  "gi"
);

/**
 * Combined regex for user paths: macOS, Linux, Windows (all drive letters).
 * Single-pass replacement reduces intermediate string allocations.
 */
const USER_PATH_PATTERN =
  /(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/g;

/**
 * Replacement callback for user paths - determines correct format based on match.
 */
const replaceUserPath = (match: string): string => {
  if (match.startsWith("/Users/")) {
    return "/Users/[user]";
  }
  if (match.startsWith("/home/")) {
    return "/home/[user]";
  }
  // Windows: preserve drive letter, replace username
  const driveLetter = match.charAt(0);
  return `${driveLetter}:\\Users\\[user]`;
};

/**
 * Scrubs user paths from file paths to prevent PII leakage.
 * Handles macOS (/Users/xxx), Linux (/home/xxx), and Windows ([A-Z]:\Users\xxx) paths.
 * Uses single-pass replacement to minimize string allocations.
 */
export const scrubFilePath = (path: string): string =>
  path.replace(USER_PATH_PATTERN, replaceUserPath);

/**
 * Scrubs both file paths and sensitive values from a string.
 */
export const scrubString = (str: string): string =>
  scrubFilePath(str).replace(SENSITIVE_VALUES, "[Filtered]");

/**
 * Minimal exception type compatible with @sentry/node.
 * Only includes fields we need for scrubbing.
 */
export interface SentryException {
  value?: string;
  stacktrace?: {
    frames?: Array<{
      filename?: string;
      abs_path?: string;
    }>;
  };
}

/**
 * Minimal breadcrumb type compatible with @sentry/node.
 * Only includes fields we need for scrubbing.
 */
export interface SentryBreadcrumb {
  message?: string;
  data?: Record<string, unknown>;
}

/**
 * Scrubs exception values and stack trace file paths.
 * Mutates the exceptions array in place.
 */
export const scrubExceptions = (exceptions: SentryException[]): void => {
  for (const exception of exceptions) {
    if (exception.value) {
      exception.value = scrubString(exception.value);
    }
    if (!exception.stacktrace?.frames) {
      continue;
    }
    for (const frame of exception.stacktrace.frames) {
      if (frame.filename) {
        frame.filename = scrubFilePath(frame.filename);
      }
      if (frame.abs_path) {
        frame.abs_path = scrubFilePath(frame.abs_path);
      }
    }
  }
};

/**
 * Scrubs breadcrumb messages.
 * Mutates the breadcrumbs array in place.
 * Note: Does not scrub breadcrumb.data - use scrubObject for that in platform-specific code.
 */
export const scrubBreadcrumbs = (breadcrumbs: SentryBreadcrumb[]): void => {
  for (const breadcrumb of breadcrumbs) {
    if (breadcrumb.message) {
      breadcrumb.message = scrubString(breadcrumb.message);
    }
  }
};
