import { resolve } from "node:path";
import { build } from "esbuild";

const isProduction = process.env.NODE_ENV === "production";
const sentryDsn =
  "https://9f8c42168ef449e11e1178bde80aa86b@o4509690474332160.ingest.us.sentry.io/4510777910165504";

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
    "process.env.SENTRY_DSN": JSON.stringify(sentryDsn),
  },
  banner: {
    js: `import { createRequire } from 'node:module';const require = createRequire(import.meta.url);`,
  },
});

console.log("Main process built successfully");
