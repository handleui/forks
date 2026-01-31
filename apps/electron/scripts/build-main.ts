import { createRequire } from "node:module";
import { resolve } from "node:path";
import { sentryEsbuildPlugin } from "@sentry/esbuild-plugin";
import { build } from "esbuild";
import { UI_SENTRY_DSN } from "../src/lib/sentry-config.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const isProduction = process.env.NODE_ENV === "production";
const hasSentryAuth = !!process.env.SENTRY_AUTH_TOKEN;

const COMPONENT = "desktop";
const sentryRelease = `${COMPONENT}@${pkg.version}`;

await build({
  entryPoints: [resolve(import.meta.dirname, "../src/main.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  outfile: resolve(import.meta.dirname, "../out/main/main.js"),
  format: "esm",
  // Use 'external' in production so maps are generated for upload but without
  // sourceMappingURL comment in the bundle. Maps are deleted after upload.
  sourcemap: isProduction ? "external" : false,
  external: ["electron"],
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      isProduction ? "production" : "development"
    ),
    "process.env.SENTRY_DSN": JSON.stringify(UI_SENTRY_DSN),
  },
  banner: {
    js: `import { createRequire } from 'node:module';const require = createRequire(import.meta.url);`,
  },
  plugins: [
    // Only run Sentry plugin in production builds with auth token
    // This uploads main process source maps to match renderer behavior
    ...(isProduction && hasSentryAuth
      ? [
          sentryEsbuildPlugin({
            org: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT,
            authToken: process.env.SENTRY_AUTH_TOKEN,
            release: {
              name: sentryRelease,
            },
            sourcemaps: {
              // Delete source maps after upload to reduce bundle size
              filesToDeleteAfterUpload: ["**/out/main/**/*.map"],
            },
          }),
        ]
      : []),
  ],
});

console.log("Main process built successfully");
