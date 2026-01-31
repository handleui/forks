import {
  scrubBreadcrumbs as scrubBreadcrumbsShared,
  scrubExceptions as scrubExceptionsShared,
} from "@forks-sh/sentry";
import type { ErrorEvent } from "@sentry/electron/renderer";
import { init as initSentry } from "@sentry/electron/renderer";
import { UI_SENTRY_DSN } from "./lib/sentry-config.js";

const COMPONENT = "desktop";
const PRODUCT = "forks";

const isProduction = import.meta.env.PROD;
const sentryEnabled = isProduction;

const scrubExceptions = (event: ErrorEvent): void => {
  if (event.exception?.values) {
    scrubExceptionsShared(event.exception.values);
  }
};

const scrubBreadcrumbs = (event: ErrorEvent): void => {
  if (event.breadcrumbs) {
    scrubBreadcrumbsShared(event.breadcrumbs);
  }
};

const beforeSend = (event: ErrorEvent): ErrorEvent => {
  scrubExceptions(event);
  scrubBreadcrumbs(event);
  return event;
};

// HACK: beforeSend is inherited from BrowserOptions but not exposed on ElectronRendererOptions
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
