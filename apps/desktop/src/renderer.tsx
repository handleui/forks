import type { Event, EventHint, StackFrame } from "@sentry/electron/renderer";
import { init as initSentry } from "@sentry/electron/renderer";
import { UI_SENTRY_DSN } from "./lib/sentry-config.js";

// HACK: @sentry/electron v7 doesn't export ErrorEvent but beforeSend expects it
// Using Event with a cast since ErrorEvent extends Event with type: undefined
type SentryBeforeSend = (
  event: Event,
  hint: EventHint
) => Event | null | Promise<Event | null>;

const COMPONENT = "desktop";
const PRODUCT = "forks";

const isProduction = import.meta.env.PROD;
const sentryEnabled = isProduction;

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

const scrubFilePath = (path: string): string =>
  path
    .replace(/\/Users\/[^/]+/g, "/Users/[user]")
    .replace(/\/home\/[^/]+/g, "/home/[user]")
    .replace(/C:\\Users\\[^\\]+/g, "C:\\Users\\[user]");

const scrubString = (value: string): string =>
  scrubFilePath(value).replace(SENSITIVE_VALUES, "[Filtered]");

const scrubStackFrame = (frame: StackFrame): void => {
  if (frame.filename) {
    frame.filename = scrubFilePath(frame.filename);
  }
  if (frame.abs_path) {
    frame.abs_path = scrubFilePath(frame.abs_path);
  }
};

const scrubExceptions = (event: Event): void => {
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) {
      exception.value = scrubString(exception.value);
    }
    for (const frame of exception.stacktrace?.frames ?? []) {
      scrubStackFrame(frame);
    }
  }
};

const scrubBreadcrumbs = (event: Event): void => {
  for (const breadcrumb of event.breadcrumbs ?? []) {
    if (breadcrumb.message) {
      breadcrumb.message = scrubString(breadcrumb.message);
    }
  }
};

const beforeSend: SentryBeforeSend = (event, _hint) => {
  scrubExceptions(event);
  scrubBreadcrumbs(event);
  return event;
};

// HACK: beforeSend is inherited from BrowserOptions but not exposed on ElectronRendererOptions
// Using object spread with type assertion to bypass the type limitation
initSentry({
  dsn: UI_SENTRY_DSN,
  environment: import.meta.env.MODE,
  enabled: sentryEnabled,
  release: import.meta.env.VITE_SENTRY_RELEASE,
  // Performance: 5% trace sample rate in renderer (user interactions worth tracing)
  // Main process has tracesSampleRate: 0 (no user interactions)
  // Removed browserTracingIntegration to reduce bundle size (~30KB)
  tracesSampleRate: isProduction ? 0.05 : 0,
  // Disable debug logging in production
  debug: !isProduction,
  // Limit breadcrumbs to reduce memory usage
  maxBreadcrumbs: isProduction ? 30 : 50,
  beforeSend,
  initialScope: {
    tags: {
      component: COMPONENT,
      product: PRODUCT,
      process: "renderer",
    },
  },
} as Parameters<typeof initSentry>[0]);

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app.js";
import { ErrorBoundary } from "./lib/error-boundary.js";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found");
}
createRoot(rootEl).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
