import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "drizzle-kit";

const DEFAULT_DB_PATH = join(homedir(), ".forks", "data.db");

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.FORKS_DB_PATH || DEFAULT_DB_PATH,
  },
});
