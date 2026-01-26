import type { ErrorEvent, EventHint } from "@sentry/node";
import { captureException, init } from "@sentry/node";

// HACK: Scrubbing logic duplicated in apps/desktop/src/main.ts and apps/desktop/src/renderer.tsx
// Consider extracting to @forks-sh/sentry package when consolidating error handling

const SENSITIVE_KEYS =
  /^(authorization|cookie|password|secret|token|apikey|api_key|auth|bearer|credential|private)/i;
// Specific patterns for known sensitive formats to avoid false positives on UUIDs/base64/SHAs
const SENSITIVE_VALUES = new RegExp(
  [
    /Bearer\s+[^\s]+/.source, // Bearer tokens
    /sk-[a-zA-Z0-9]{20,}/.source, // OpenAI API keys
    /AKIA[0-9A-Z]{16}/.source, // AWS access keys
    /gh[ps]_[a-zA-Z0-9]{36}/.source, // GitHub tokens (classic)
    /github_pat_[a-zA-Z0-9_]{22,}/.source, // GitHub fine-grained PATs
    /xox[baprs]-[a-zA-Z0-9-]+/.source, // Slack tokens
    /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+/.source, // JWT tokens
  ].join("|"),
  "gi"
);

const scrubObject = (
  obj: Record<string, unknown> | null | undefined
): Record<string, unknown> | null | undefined => {
  if (!obj || typeof obj !== "object") {
    return obj;
  }
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.test(key)) {
      scrubbed[key] = "[Filtered]";
    } else if (typeof value === "string") {
      scrubbed[key] = value.replace(SENSITIVE_VALUES, "[Filtered]");
    } else if (typeof value === "object" && value !== null) {
      scrubbed[key] = scrubObject(value as Record<string, unknown>);
    } else {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
};

const scrubFilePath = (path: string): string =>
  path
    .replace(/\/Users\/[^/]+/g, "/Users/[user]")
    .replace(/\/home\/[^/]+/g, "/home/[user]")
    .replace(/C:\\Users\\[^\\]+/g, "C:\\Users\\[user]");

const scrubString = (str: string): string =>
  scrubFilePath(str).replace(SENSITIVE_VALUES, "[Filtered]");

const scrubRequest = (event: ErrorEvent): void => {
  if (!event.request) {
    return;
  }
  if (event.request.headers) {
    event.request.headers = scrubObject(event.request.headers) as Record<
      string,
      string
    >;
  }
  if (event.request.query_string) {
    event.request.query_string = "[Filtered]";
  }
  if (event.request.cookies) {
    event.request.cookies = {};
  }
};

const scrubExceptions = (event: ErrorEvent): void => {
  if (!event.exception?.values) {
    return;
  }
  for (const exception of event.exception.values) {
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

const scrubBreadcrumbs = (event: ErrorEvent): void => {
  if (!event.breadcrumbs) {
    return;
  }
  for (const breadcrumb of event.breadcrumbs) {
    if (breadcrumb.data) {
      breadcrumb.data = scrubObject(breadcrumb.data) as Record<string, unknown>;
    }
    if (breadcrumb.message) {
      breadcrumb.message = scrubString(breadcrumb.message);
    }
  }
};

const beforeSend = (event: ErrorEvent, _hint: EventHint): ErrorEvent | null => {
  scrubRequest(event);
  scrubExceptions(event);
  scrubBreadcrumbs(event);
  return event;
};

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

const isProduction = process.env.NODE_ENV === "production";

const COMPONENT = "forksd";
const PRODUCT = "forks";

export const initSentry = () => {
  init({
    dsn: process.env.SENTRY_DSN,
    environment: isProduction ? "production" : "development",
    enabled: !!process.env.SENTRY_DSN && isProduction,
    release: `${COMPONENT}@${pkg.version}`,
    tracesSampleRate: 0,
    debug: !isProduction,
    maxBreadcrumbs: 20,
    // attachStacktrace: false is intentional - only exceptions need traces, not captureMessage calls
    attachStacktrace: false,
    maxValueLength: 1000,
    beforeSend,
    initialScope: {
      tags: {
        component: COMPONENT,
        product: PRODUCT,
      },
    },
  });
};

export const captureError = (
  error: Error,
  context?: Record<string, unknown>
) => {
  if (!context) {
    captureException(error);
    return;
  }
  const scrubbed = scrubObject(context);
  if (scrubbed) {
    captureException(error, { extra: scrubbed });
  } else {
    captureException(error);
  }
};
