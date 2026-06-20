import fs from "node:fs";
import path from "node:path";
import type { FrdSection, LocalRepo } from "./types";
import { readLocalFile } from "./local-walker";

// ── Constants first — must appear before functions that reference them ─────────

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into",
  "are", "has", "have", "was", "will", "should", "can", "not",
  "use", "used", "using", "may", "when", "what", "how", "any",
  "scope", "section", "module", "system", "based", "notes",
]);

const TOKEN_ALIASES: Record<string, string[]> = {
  auth: ["login", "authenticate", "authorization", "jwt", "token", "session"],
  authentication: ["login", "auth", "jwt", "session"],
  authorization: ["role", "permission", "guard", "policy", "rbac"],
  user: ["account", "profile", "member"],
  payment: ["invoice", "billing", "checkout", "stripe", "razorpay"],
  notification: ["email", "sms", "push", "webhook", "alert"],
  dashboard: ["overview", "metrics", "analytics", "stats"],
  search: ["query", "filter", "index", "elasticsearch"],
  upload: ["file", "attachment", "storage", "s3", "blob"],
  report: ["export", "csv", "pdf", "download"],
  api: ["endpoint", "route", "controller", "handler"],
  database: ["db", "migration", "schema", "model", "orm"],
};

const CODE_EXTS = new Set(["ts", "tsx", "js", "jsx", "py", "go", "rb", "java", "php", "cs"]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".turbo",
  "coverage", ".nyc_output", ".pnpm-store", "vendor", "__pycache__",
]);

// ── Markdown heading extractor ────────────────────────────────────────────────

function extractHeadings(src: string): Array<{ heading: string; level: number }> {
  const headings: Array<{ heading: string; level: number }> = [];
  for (const line of src.split("\n")) {
    const m = line.match(/^(#{1,4})\s+(.+)$/);
    if (!m) continue;
    const level = (m[1] ?? "").length;
    // Strip inline markdown links [text](url) but keep plain [text]
    const heading = (m[2] ?? "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
    if (heading.length > 2) headings.push({ heading, level });
  }
  return headings;
}

// ── Token-based evidence search ───────────────────────────────────────────────

function headingToSearchTokens(heading: string): string[] {
  const parts = heading
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/);

  const tokens = Array.isArray(parts)
    ? parts.filter((t) => t.length >= 3 && !STOPWORDS.has(t))
    : [];

  const expanded: string[] = tokens.slice();
  for (const t of tokens) {
    const alias = TOKEN_ALIASES[t];
    if (Array.isArray(alias)) {
      for (const a of alias) expanded.push(a);
    }
  }

  // Deduplicate without relying on Set spread
  const seen = new Set<string>();
  const result: string[] = [];
  for (const t of expanded) {
    if (!seen.has(t)) { seen.add(t); result.push(t); }
  }
  return result;
}

function findEvidence(tokens: string[], repo: LocalRepo): string[] {
  if (tokens.length === 0) return [];
  const evidence: string[] = [];

  for (const f of repo.files) {
    if (evidence.length >= 5) break;
    const ext = f.split(".").pop()?.toLowerCase() ?? "";
    if (!CODE_EXTS.has(ext)) continue;

    const src = readLocalFile(repo, f, 128 * 1024);
    if (!src) continue;

    for (const token of tokens) {
      const re = new RegExp(`\\b${escapeRe(token)}\\b`, "i");
      if (re.test(src)) {
        evidence.push(f);
        break;
      }
    }
  }

  return evidence;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Walk FRD directory (skipping build artifacts and node_modules) ─────────────

function findFrdFiles(frdDir: string): string[] {
  if (!fs.existsSync(frdDir)) return [];

  const results: string[] = [];

  function walk(d: string, depth: number) {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch { return; }

    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(abs, depth + 1);
      } else if (e.isFile() && (e.name.endsWith(".md") || e.name.endsWith(".mdx"))) {
        results.push(abs);
      }
    }
  }

  walk(frdDir, 0);
  return results;
}

// ── Main API ──────────────────────────────────────────────────────────────────

export function parseFrdDirectory(
  projectDir: string,
  frdSubDir: string,
  repo: LocalRepo
): FrdSection[] {
  const frdDir = path.isAbsolute(frdSubDir)
    ? frdSubDir
    : path.join(projectDir, frdSubDir);

  const mdFiles = findFrdFiles(frdDir);
  if (mdFiles.length === 0) return [];

  const sections: FrdSection[] = [];

  for (const mdPath of mdFiles) {
    let src: string;
    try { src = fs.readFileSync(mdPath, "utf-8"); }
    catch { continue; }

    const relFile = path.relative(projectDir, mdPath);
    for (const { heading, level } of extractHeadings(src)) {
      if (level > 3) continue;
      const tokens = headingToSearchTokens(heading);
      const evidence = findEvidence(tokens, repo);
      sections.push({ heading, level, file: relFile, evidence, covered: evidence.length > 0 });
    }
  }

  return sections;
}
