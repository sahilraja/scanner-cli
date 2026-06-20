import fs from "node:fs";
import path from "node:path";
import type { LocalRepo, ScanConfig } from "./types";

const DEFAULT_EXCLUDE = new Set([
  "node_modules", "dist", "build", ".git", ".next", "coverage",
  ".turbo", "out", "__pycache__", ".pytest_cache", "vendor",
  ".gradle", ".mvn", "target", "Pods", ".yarn",
]);

export function walkLocalDirectory(projectDir: string, config: ScanConfig): LocalRepo {
  const rootDir = path.resolve(projectDir);
  const exclude = new Set([
    ...DEFAULT_EXCLUDE,
    ...(config.scan?.exclude ?? []),
  ]);
  const maxFileBytes = config.scan?.maxFileSizeBytes ?? 512 * 1024;

  const files: string[] = [];
  let totalBytes = 0;

  function walk(dir: string, prefix: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (exclude.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".env.example" && entry.name !== ".editorconfig" && entry.name !== ".eslintrc.json" && entry.name !== ".eslintrc.js" && entry.name !== ".prettierrc" && entry.name !== ".prettierrc.json" && !entry.name.includes("gitlab-ci") && !entry.name.includes("github")) continue;

      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(abs);
          if (stat.size <= maxFileBytes * 10) {
            totalBytes += stat.size;
            files.push(rel);
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(rootDir, "");

  return { rootDir, tmpDir: rootDir, files, totalBytes };
}

export function readLocalFile(
  repo: LocalRepo,
  relPath: string,
  maxBytes: number = 512 * 1024
): string | null {
  const target = path.resolve(repo.rootDir, relPath);
  if (!target.startsWith(repo.rootDir)) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > maxBytes) return null;

  try {
    return fs.readFileSync(target, "utf-8");
  } catch {
    return null;
  }
}

/** Walk directory and return the latest mtime (ms). Used by watch mode. */
export function getLatestMtime(
  dir: string,
  exclude: Set<string> = DEFAULT_EXCLUDE,
  depth = 0
): number {
  if (depth > 8) return 0;
  let latest = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (exclude.has(e.name) || e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    try {
      const stat = fs.statSync(abs);
      if (stat.mtimeMs > latest) latest = stat.mtimeMs;
      if (e.isDirectory()) {
        const sub = getLatestMtime(abs, exclude, depth + 1);
        if (sub > latest) latest = sub;
      }
    } catch {
      // skip
    }
  }
  return latest;
}
