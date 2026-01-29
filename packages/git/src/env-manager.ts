import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { EnvProfileFile, EnvProfileSuggestion } from "@forks-sh/protocol";

export interface ApplyResult {
  success: boolean;
  applied: string[];
  skipped: string[];
  errors: string[];
}

export interface EnvManager {
  applyProfile(
    workspacePath: string,
    projectPath: string,
    files: EnvProfileFile[]
  ): ApplyResult;
  clearProfile(workspacePath: string, targetPaths: string[]): void;
  detectEnvFiles(projectPath: string): EnvProfileSuggestion[];
}

const ENV_PATTERNS: Array<{
  profileName: string;
  sourcePatterns: RegExp[];
  targetPath: string;
}> = [
  {
    profileName: "development",
    sourcePatterns: [/^\.env\.development$/i, /^\.env\.dev$/i],
    targetPath: ".env",
  },
  {
    profileName: "production",
    sourcePatterns: [/^\.env\.production$/i, /^\.env\.prod$/i],
    targetPath: ".env",
  },
  {
    profileName: "staging",
    sourcePatterns: [/^\.env\.staging$/i, /^\.env\.stage$/i],
    targetPath: ".env",
  },
  {
    profileName: "test",
    sourcePatterns: [/^\.env\.test$/i, /^\.env\.testing$/i],
    targetPath: ".env",
  },
  {
    profileName: "local",
    sourcePatterns: [/^\.env\.local$/i],
    targetPath: ".env",
  },
];

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const isValidRelativePath = (relativePath: string): boolean => {
  if (
    !relativePath ||
    relativePath.length === 0 ||
    relativePath.startsWith("/")
  ) {
    return false;
  }

  // Block null bytes which can be used in path attacks
  if (relativePath.includes("\0")) {
    return false;
  }

  // Block backslashes (potential Windows path injection on some platforms)
  if (relativePath.includes("\\")) {
    return false;
  }

  const parts = relativePath.split("/");
  let depth = 0;
  for (const part of parts) {
    if (part === "..") {
      depth--;
      if (depth < 0) {
        return false;
      }
    } else if (part !== "." && part !== "") {
      depth++;
    }
  }
  return true;
};

const isPathWithinBase = (realBase: string, fullPath: string): boolean => {
  try {
    const normalizedPath = resolve(fullPath);

    return (
      normalizedPath === realBase || normalizedPath.startsWith(`${realBase}/`)
    );
  } catch {
    return false;
  }
};

const isSymlinkLocationSafe = (
  realBase: string,
  targetFullPath: string
): boolean => {
  try {
    const parentDir = dirname(targetFullPath);

    if (!existsSync(parentDir)) {
      const normalizedParent = resolve(parentDir);
      return (
        normalizedParent === realBase ||
        normalizedParent.startsWith(`${realBase}/`)
      );
    }

    const realParent = realpathSync(parentDir);
    return realParent === realBase || realParent.startsWith(`${realBase}/`);
  } catch {
    return false;
  }
};

interface FileApplyContext {
  sourcePath: string;
  targetPath: string;
  sourceFullPath: string;
  targetFullPath: string;
}

type FileApplyOutcome =
  | { type: "applied" }
  | { type: "skipped" }
  | { type: "error"; message: string };

const prepareTargetForSymlink = (
  targetFullPath: string
): { ready: boolean; error?: string } => {
  const targetExists = existsSync(targetFullPath);
  const targetIsSymlink = isSymlink(targetFullPath);

  if (!(targetExists || targetIsSymlink)) {
    return { ready: true };
  }

  if (targetIsSymlink) {
    try {
      unlinkSync(targetFullPath);
      return { ready: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return {
        ready: false,
        error: `Failed to remove existing symlink: ${msg}`,
      };
    }
  }

  return { ready: false, error: "Target file already exists (not a symlink)" };
};

const applySingleFile = (ctx: FileApplyContext): FileApplyOutcome => {
  if (!existsSync(ctx.sourceFullPath)) {
    return { type: "skipped" };
  }

  const prep = prepareTargetForSymlink(ctx.targetFullPath);
  if (!prep.ready) {
    return { type: "error", message: `${prep.error}: ${ctx.targetPath}` };
  }

  try {
    symlinkSync(ctx.sourceFullPath, ctx.targetFullPath);
    return { type: "applied" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return {
      type: "error",
      message: `Failed to create symlink ${ctx.targetPath}: ${msg}`,
    };
  }
};

const matchEnvPattern = (
  envFile: string
): { profileName: string; targetPath: string } | null => {
  for (const pattern of ENV_PATTERNS) {
    if (pattern.sourcePatterns.some((p) => p.test(envFile))) {
      return {
        profileName: pattern.profileName,
        targetPath: pattern.targetPath,
      };
    }
  }
  return null;
};

type PathValidationResult =
  | { valid: true; sourceFullPath: string; targetFullPath: string }
  | { valid: false; error: string };

interface ResolvedPaths {
  realProjectPath: string;
  realWorkspacePath: string;
}

const validateFilePaths = (
  file: EnvProfileFile,
  projectPath: string,
  workspacePath: string,
  resolved: ResolvedPaths
): PathValidationResult => {
  const { sourcePath, targetPath } = file;

  if (!isValidRelativePath(sourcePath)) {
    return { valid: false, error: `Invalid source path: ${sourcePath}` };
  }
  if (!isValidRelativePath(targetPath)) {
    return { valid: false, error: `Invalid target path: ${targetPath}` };
  }

  const sourceFullPath = join(projectPath, sourcePath);
  const targetFullPath = join(workspacePath, targetPath);

  if (!isPathWithinBase(resolved.realProjectPath, sourceFullPath)) {
    return {
      valid: false,
      error: `Source path escapes project: ${sourcePath}`,
    };
  }
  if (!isSymlinkLocationSafe(resolved.realWorkspacePath, targetFullPath)) {
    return {
      valid: false,
      error: `Target path escapes workspace: ${targetPath}`,
    };
  }

  return { valid: true, sourceFullPath, targetFullPath };
};

const processFileEntry = (
  file: EnvProfileFile,
  projectPath: string,
  workspacePath: string,
  result: ApplyResult,
  resolved: ResolvedPaths
): void => {
  const validation = validateFilePaths(
    file,
    projectPath,
    workspacePath,
    resolved
  );

  if (!validation.valid) {
    result.errors.push(validation.error);
    result.success = false;
    return;
  }

  const ctx: FileApplyContext = {
    sourcePath: file.sourcePath,
    targetPath: file.targetPath,
    sourceFullPath: validation.sourceFullPath,
    targetFullPath: validation.targetFullPath,
  };

  const outcome = applySingleFile(ctx);

  if (outcome.type === "applied") {
    result.applied.push(file.targetPath);
  } else if (outcome.type === "skipped") {
    result.skipped.push(file.targetPath);
  } else {
    result.errors.push(outcome.message);
    result.success = false;
  }
};

export const createEnvManager = (): EnvManager => {
  return {
    applyProfile(workspacePath, projectPath, files) {
      const result: ApplyResult = {
        success: true,
        applied: [],
        skipped: [],
        errors: [],
      };

      // Resolve real paths once upfront to avoid repeated realpathSync calls
      let resolved: ResolvedPaths;
      try {
        resolved = {
          realProjectPath: realpathSync(projectPath),
          realWorkspacePath: realpathSync(workspacePath),
        };
      } catch {
        result.success = false;
        result.errors.push("Failed to resolve project or workspace path");
        return result;
      }

      for (const file of files) {
        processFileEntry(file, projectPath, workspacePath, result, resolved);
      }

      return result;
    },

    clearProfile(workspacePath, targetPaths) {
      // Resolve real workspace path once upfront
      let realWorkspacePath: string;
      try {
        realWorkspacePath = realpathSync(workspacePath);
      } catch {
        // Workspace path doesn't exist or can't be resolved - nothing to clear
        return;
      }

      for (const targetPath of targetPaths) {
        if (!isValidRelativePath(targetPath)) {
          continue;
        }

        const fullPath = join(workspacePath, targetPath);

        if (!isSymlinkLocationSafe(realWorkspacePath, fullPath)) {
          continue;
        }

        if (isSymlink(fullPath)) {
          try {
            unlinkSync(fullPath);
          } catch {
            // Ignore errors during cleanup
          }
        }
      }
    },

    detectEnvFiles(projectPath) {
      let files: string[];
      try {
        files = readdirSync(projectPath);
      } catch {
        return [];
      }

      const envFiles = files.filter(
        (f) => f.startsWith(".env") && !f.endsWith(".example")
      );

      const profileMap = new Map<
        string,
        Array<{ sourcePath: string; targetPath: string }>
      >();

      for (const envFile of envFiles) {
        const match = matchEnvPattern(envFile);
        if (match) {
          const existing = profileMap.get(match.profileName) ?? [];
          existing.push({ sourcePath: envFile, targetPath: match.targetPath });
          profileMap.set(match.profileName, existing);
        }
      }

      if (envFiles.includes(".env")) {
        const existing = profileMap.get("default") ?? [];
        existing.push({ sourcePath: ".env", targetPath: ".env" });
        profileMap.set("default", existing);
      }

      const suggestions: EnvProfileSuggestion[] = [];
      for (const [name, fileList] of profileMap) {
        suggestions.push({ name, files: fileList });
      }

      suggestions.sort((a, b) => a.name.localeCompare(b.name));

      return suggestions;
    },
  };
};
