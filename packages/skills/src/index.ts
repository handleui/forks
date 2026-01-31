/** @forks-sh/skills – skills/runtime */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILLS_VERSION = "0.0.1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const forksMcpDir = join(__dirname, "..", "forks-mcp");

export const forksMcpReferenceNames = [
  "attempts",
  "subagents",
  "plans",
  "questions",
  "tasks",
  "terminals",
  "graphite",
] as const;

export type ForksMcpReferenceName = (typeof forksMcpReferenceNames)[number];

export const getForksMcpSkillPath = (): string => join(forksMcpDir, "SKILL.md");

export const getForksMcpReferencePath = (name: ForksMcpReferenceName): string =>
  join(forksMcpDir, "references", `${name}.md`);

/**
 * Get the main SKILL.md content for the forks-mcp skill.
 * This is the overview document that should be injected into AI context.
 */
export const getForksMcpSkill = (): string => {
  try {
    return readFileSync(getForksMcpSkillPath(), "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to load forks-mcp skill: ${err instanceof Error ? err.message : err}`
    );
  }
};

/**
 * Get a specific reference document for the forks-mcp skill.
 * @param name - The reference name from forksMcpReferenceNames
 */
export const getForksMcpReference = (name: ForksMcpReferenceName): string => {
  try {
    return readFileSync(getForksMcpReferencePath(name), "utf-8");
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
  const refContents = forksMcpReferenceNames
    .map((name) => getForksMcpReference(name))
    .join("\n\n---\n\n");
  return `${skill}\n\n---\n\n${refContents}`;
};
