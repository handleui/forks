import { resolve } from "node:path";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";

const isProduction = process.env.NODE_ENV === "production";
const hasSentryAuth = !!process.env.SENTRY_AUTH_TOKEN;

export default defineConfig({
  plugins: [
    react(),
    // Only run Sentry plugin in production builds with auth token
    // This avoids source map upload overhead during development
    isProduction && hasSentryAuth
      ? sentryVitePlugin({
          org: process.env.SENTRY_ORG,
          project: process.env.SENTRY_PROJECT,
          authToken: process.env.SENTRY_AUTH_TOKEN,
          release: {
            name: process.env.SENTRY_RELEASE,
          },
          sourcemaps: {
            // Delete source maps after upload to reduce bundle size in production
            filesToDeleteAfterUpload: ["**/*.js.map"],
          },
          bundleSizeOptimizations: {
            // Tree shake debug statements in production
            excludeDebugStatements: true,
          },
        })
      : null,
  ].filter(Boolean),
  root: ".",
  define: {
    // Tree-shake Sentry debug code in production
    __SENTRY_DEBUG__: JSON.stringify(!isProduction),
  },
  build: {
    outDir: "out/renderer",
    emptyOutDir: true,
    // Only generate source maps in production (for Sentry upload)
    // Use 'hidden' to avoid exposing them in devtools
    sourcemap: isProduction ? "hidden" : false,
    rollupOptions: {
      input: resolve(__dirname, "index.html"),
    },
  },
  server: { port: 5173 },
} satisfies UserConfig);
