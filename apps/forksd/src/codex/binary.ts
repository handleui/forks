import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export const getCodexBinaryPath = (): string => {
  let codexPackagePath: string;
  try {
    codexPackagePath = require.resolve("@openai/codex/package.json");
  } catch {
    throw new Error(
      "@openai/codex package not found. Run: bun add @openai/codex"
    );
  }
  const codexDir = dirname(codexPackagePath);
  return join(codexDir, "bin", "codex.js");
};
