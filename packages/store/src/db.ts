import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  attempts,
  chats,
  plans,
  projects,
  questions,
  subagents,
  tasks,
  workspaces,
} from "./schema.js";

export const DEFAULT_DB_PATH = join(homedir(), ".forks", "data.db");

// Migrations folder path relative to this file
// For development: packages/store/drizzle
// For bundled/production: set FORKS_MIGRATIONS_PATH env var
//
// Note: import.meta.url works in unbundled ESM but may resolve incorrectly
// when bundled with esbuild/tsup. The env var override handles this case.
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER =
  process.env.FORKS_MIGRATIONS_PATH || join(__dirname, "..", "drizzle");

export interface DbConnection {
  db: ReturnType<typeof drizzle>;
  close: () => void;
}

export type DrizzleDb = DbConnection["db"];

export const createDb = (dbPath: string = DEFAULT_DB_PATH): DbConnection => {
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  const db = drizzle(sqlite, {
    schema: {
      attempts,
      chats,
      plans,
      projects,
      questions,
      subagents,
      tasks,
      workspaces,
    },
  });

  // Apply migrations on startup to ensure schema is up-to-date
  // This is idempotent - already-applied migrations are skipped
  if (!existsSync(MIGRATIONS_FOLDER)) {
    sqlite.close();
    throw new Error(
      `Migrations folder not found: ${MIGRATIONS_FOLDER}. ` +
        "Ensure the drizzle migrations are available at runtime."
    );
  }

  try {
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } catch (error) {
    sqlite.close();
    throw new Error(
      `Database migration failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return {
    db,
    close: () => sqlite.close(),
  };
};
