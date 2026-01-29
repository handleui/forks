import { createRequire } from "node:module";
import {
  SENSITIVE_KEYS,
  SENSITIVE_VALUES,
  scrubBreadcrumbs as scrubBreadcrumbsShared,
  scrubExceptions as scrubExceptionsShared,
} from "@forks-sh/sentry";
import type { ErrorEvent, EventHint } from "@sentry/node";
import { captureException, init } from "@sentry/node";

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
  if (event.exception?.values) {
    scrubExceptionsShared(event.exception.values);
  }
};

const scrubBreadcrumbs = (event: ErrorEvent): void => {
  if (!event.breadcrumbs) {
    return;
  }
  // scrubBreadcrumbsShared handles message scrubbing (platform-agnostic)
  scrubBreadcrumbsShared(event.breadcrumbs);
  // Data scrubbing done separately because scrubObject uses SENSITIVE_KEYS
  // which may have platform-specific handling
  for (const breadcrumb of event.breadcrumbs) {
    if (breadcrumb.data) {
      breadcrumb.data = scrubObject(breadcrumb.data) as Record<string, unknown>;
    }
  }
};

const beforeSend = (event: ErrorEvent, _hint: EventHint): ErrorEvent | null => {
  scrubRequest(event);
  scrubExceptions(event);
  scrubBreadcrumbs(event);
  return event;
};

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

const isProduction = process.env.NODE_ENV === "production";

const COMPONENT = "forksd";
const PRODUCT = "forks";

/**
 * Daemon Sentry DSN passed from desktop via FORKSD_SENTRY_DSN env var.
 * The daemon never enables telemetry unless launched by the desktop app with telemetry enabled.
 * For standalone dev: set FORKSD_SENTRY_DSN manually to enable.
 */
const SENTRY_DSN = process.env.FORKSD_SENTRY_DSN;

export const initSentry = () => {
  init({
    dsn: SENTRY_DSN,
    environment: isProduction ? "production" : "development",
    enabled: !!SENTRY_DSN,
    release: `${COMPONENT}@${pkg.version}`,
    tracesSampleRate: 0,
    debug: !isProduction && !!SENTRY_DSN,
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
