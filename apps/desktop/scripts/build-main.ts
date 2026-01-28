import { resolve } from "node:path";
import { build } from "esbuild";
import { UI_SENTRY_DSN } from "../src/lib/sentry-config.js";

const isProduction = process.env.NODE_ENV === "production";

await build({
  entryPoints: [resolve(import.meta.dirname, "../src/main.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  outfile: resolve(import.meta.dirname, "../out/main/main.js"),
  format: "esm",
  sourcemap: isProduction ? "linked" : false,
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
});

console.log("Main process built successfully");
