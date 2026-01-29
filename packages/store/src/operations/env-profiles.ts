import { randomUUID } from "node:crypto";
import type {
  EnvProfile,
  EnvProfileFile,
  EnvProfileWithFiles,
} from "@forks-sh/protocol";
import { desc, eq } from "drizzle-orm";
import type { DrizzleDb } from "../db.js";
import { envProfileFiles, envProfiles } from "../schema.js";

interface CreateProfileFileInput {
  sourcePath: string;
  targetPath: string;
}

export const createEnvProfileOps = (db: DrizzleDb) => ({
  create: (
    projectId: string,
    name: string,
    files: CreateProfileFileInput[]
  ): EnvProfileWithFiles => {
    const id = randomUUID();
    const now = Date.now();

    // Use transaction to ensure atomicity - profile and files are created together or not at all
    return db.transaction((tx) => {
      const profileRow = tx
        .insert(envProfiles)
        .values({ id, projectId, name, createdAt: now })
        .returning()
        .get();

      if (!profileRow) {
        throw new Error("Failed to create env profile");
      }

      // Batch insert all files in a single query
      const insertedFiles: EnvProfileFile[] = [];
      if (files.length > 0) {
        const fileRows = tx
          .insert(envProfileFiles)
          .values(
            files.map((file) => ({
              profileId: id,
              sourcePath: file.sourcePath,
              targetPath: file.targetPath,
            }))
          )
          .returning()
          .all();

        for (const row of fileRows) {
          insertedFiles.push(mapProfileFile(row));
        }
      }

      return {
        ...mapProfile(profileRow),
        files: insertedFiles,
      };
    });
  },

  get: (id: string): EnvProfileWithFiles | null => {
    // Single query with LEFT JOIN to fetch profile and files together
    const rows = db
      .select()
      .from(envProfiles)
      .leftJoin(envProfileFiles, eq(envProfiles.id, envProfileFiles.profileId))
      .where(eq(envProfiles.id, id))
      .all();

    const firstRow = rows[0];
    if (!firstRow) {
      return null;
    }

    // First row contains the profile data
    const profileRow = firstRow.env_profiles;
    const files: EnvProfileFile[] = [];

    // Collect all non-null file rows
    for (const row of rows) {
      if (row.env_profile_files) {
        files.push(mapProfileFile(row.env_profile_files));
      }
    }

    return {
      ...mapProfile(profileRow),
      files,
    };
  },

  list: (projectId: string): EnvProfile[] => {
    return db
      .select()
      .from(envProfiles)
      .where(eq(envProfiles.projectId, projectId))
      .orderBy(desc(envProfiles.createdAt))
      .all()
      .map(mapProfile);
  },

  delete: (id: string): void => {
    db.delete(envProfiles).where(eq(envProfiles.id, id)).run();
  },
});

const mapProfile = (row: typeof envProfiles.$inferSelect): EnvProfile => ({
  id: row.id,
  projectId: row.projectId,
  name: row.name,
  createdAt: row.createdAt,
});

const mapProfileFile = (
  row: typeof envProfileFiles.$inferSelect
): EnvProfileFile => ({
  profileId: row.profileId,
  sourcePath: row.sourcePath,
  targetPath: row.targetPath,
});
