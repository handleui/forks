/**
 * Sentry DSN configuration for desktop and daemon.
 *
 * Desktop owns all telemetry consent. The daemon never enables telemetry
 * unless launched by the desktop app with telemetry enabled.
 */

/** Sentry DSN for desktop UI (main + renderer processes) */
export const UI_SENTRY_DSN =
  "https://9f8c42168ef449e11e1178bde80aa86b@o4509690474332160.ingest.us.sentry.io/4510777910165504";

/** Sentry DSN for daemon (passed via FORKSD_SENTRY_DSN env var) */
export const DAEMON_SENTRY_DSN =
  "https://c230990da1dee48d64e3d2a4c7625307@o4509690474332160.ingest.us.sentry.io/4510777923076096";
