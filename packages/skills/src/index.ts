/** @forks-sh/skills – skills/runtime */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILLS_VERSION = "0.0.1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const forksMcpDir = join(__dirname, "..", "forks-mcp");

/**
 * Get the main SKILL.md content for the forks-mcp skill.
 * This is the overview document that should be injected into AI context.
 */
export const getForksMcpSkill = (): string => {
  try {
    return readFileSync(join(forksMcpDir, "SKILL.md"), "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to load forks-mcp skill: ${err instanceof Error ? err.message : err}`
    );
  }
};

/**
 * Get a specific reference document for the forks-mcp skill.
 * @param name - The reference name: "attempts", "subagents", "plans", "questions", or "tasks"
 */
export const getForksMcpReference = (
  name: "attempts" | "subagents" | "plans" | "questions" | "tasks"
): string => {
  const refPath = join(forksMcpDir, "references", `${name}.md`);
  try {
    return readFileSync(refPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to load forks-mcp reference "${name}": ${err instanceof Error ? err.message : err}`
    );
  }
};

/**
 * Get all forks-mcp skill content combined (overview + all references).
 * Use this for full context injection.
 */
export const getFullForksMcpSkill = (): string => {
  const skill = getForksMcpSkill();
  const references = [
    "attempts",
    "subagents",
    "plans",
    "questions",
    "tasks",
  ] as const;
  const refContents = references
    .map((name) => getForksMcpReference(name))
    .join("\n\n---\n\n");
  return `${skill}\n\n---\n\n${refContents}`;
};
