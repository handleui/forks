#!/usr/bin/env bun

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const protocolDir = join(import.meta.dirname, "../src/protocol");

const fixImportsInFile = async (filePath: string): Promise<boolean> => {
  const content = await readFile(filePath, "utf-8");
  const fileDir = dirname(filePath);

  // Match imports/exports from relative paths without .js extension
  // Handles: from "./Foo", from "../Bar", from "./sub/Baz"
  const regex = /(from\s+["'])(\.[^"']+)(?<!\.js)(["'])/g;

  let fixedContent = content;
  const matches = [...content.matchAll(regex)];

  for (const match of matches) {
    const importPath = match[2];
    const resolvedPath = join(fileDir, importPath);

    // Check if this is a directory (in which case we add /index.js)
    let newPath = `${importPath}.js`;
    try {
      const stats = await stat(resolvedPath);
      if (stats.isDirectory()) {
        newPath = `${importPath}/index.js`;
      }
    } catch {
      // Not a directory, proceed with adding .js
    }

    // Replace this specific import with the fixed extension
    fixedContent = fixedContent.replace(
      new RegExp(
        `(from\\s+["'])${importPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(["'])`,
        "g"
      ),
      `$1${newPath}$2`
    );
  }

  if (content !== fixedContent) {
    await writeFile(filePath, fixedContent);
    return true;
  }
  return false;
};

const processDirectory = async (dirPath: string): Promise<void> => {
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      await processDirectory(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      const modified = await fixImportsInFile(fullPath);
      if (modified) {
        console.log(`Fixed: ${fullPath}`);
      }
    }
  }
};

console.log("Fixing import extensions in protocol files...");
await processDirectory(protocolDir);
console.log("Done!");
