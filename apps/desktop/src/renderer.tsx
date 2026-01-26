import type { Event, EventHint, StackFrame } from "@sentry/electron/renderer";
import { init as initSentry } from "@sentry/electron/renderer";

// ErrorEvent is Event with type: undefined - defined locally due to re-export issues
type ErrorEvent = Event & { type: undefined };

const isProduction = import.meta.env.PROD;
const sentryEnabled = !!import.meta.env.VITE_SENTRY_DSN && isProduction;

const SENSITIVE_VALUES = /(Bearer\s+[^\s]+|sk-[a-zA-Z0-9]+|[a-zA-Z0-9]{32,})/g;

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

const scrubExceptions = (event: ErrorEvent): void => {
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) {
      exception.value = scrubString(exception.value);
    }
    for (const frame of exception.stacktrace?.frames ?? []) {
      scrubStackFrame(frame);
    }
  }
};

const scrubBreadcrumbs = (event: ErrorEvent): void => {
  for (const breadcrumb of event.breadcrumbs ?? []) {
    if (breadcrumb.message) {
      breadcrumb.message = scrubString(breadcrumb.message);
    }
  }
};

const beforeSend = (event: ErrorEvent, _hint: EventHint): ErrorEvent | null => {
  scrubExceptions(event);
  scrubBreadcrumbs(event);
  return event;
};

initSentry({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE,
  enabled: sentryEnabled,
  release: import.meta.env.VITE_SENTRY_RELEASE,
  // Performance: Low trace sample rate - Electron renderer has limited network activity
  // Removed browserTracingIntegration to reduce bundle size (~30KB)
  tracesSampleRate: isProduction ? 0.05 : 0,
  // Disable debug logging in production
  debug: !isProduction,
  // Limit breadcrumbs to reduce memory usage
  maxBreadcrumbs: isProduction ? 30 : 50,
  beforeSend,
});

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
