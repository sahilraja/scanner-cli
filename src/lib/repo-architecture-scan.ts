import "server-only";
import { readRepoFile, type ExtractedRepo } from "./archive-walker";

/**
 * Architecture-doc compliance scanner.
 *
 * Many of the repos this tool reviews are Cursor / AI-generated and ship
 * a `file-architecture.md` (or `ARCHITECTURE.md`, `docs/architecture.md`,
 * etc.) at the repo root that documents the *intended* layout, layering,
 * and tech stack. Rather than guessing what "good" looks like with
 * blanket heuristics, this module parses that document and verifies the
 * code against the project's own claims:
 *
 *   1. Layout claims — every directory/file mentioned in the tree code
 *      blocks should exist in the extracted archive.
 *   2. Tech-stack claims — every backtick-wrapped npm package mentioned
 *      under "Key dependencies" / "Tech Stack" sections should appear
 *      in *some* `package.json`'s deps.
 *   3. (Stage 2 — not yet implemented) Convention rules like
 *      "No `axios` imports in pages or components." We extract a list
 *      of declared rules but only verify the most common ones.
 *
 * The output is a per-claim pass/fail list plus an aggregate
 * `compliance_pct` that scoring rewards.
 */

export type PathClaim = {
  /** Path as derived from the tree (root-prefixed if the block had a root). */
  declared: string;
  /** Trailing `/` indicates a directory. */
  is_dir: boolean;
  /** Contains `*` / `?` — verified by matching at least one file in parent. */
  is_glob: boolean;
  /** Description text after the path (the right-hand column of the tree). */
  description: string;
};

export type StackClaim = {
  name: string;
  /** Section heading where it was found (helpful in the UI). */
  section: string;
};

export type ConventionRuleClaim = {
  /** Rule type we recognised. Right now only `import-forbidden` is verified. */
  type: "import-forbidden" | "unknown";
  raw: string;
  /** Library or symbol the rule mentions. */
  lib?: string;
  /** Directory or scope the rule applies to. */
  scope?: string;
};

export type RepoArchitectureSignals = {
  has_doc: boolean;
  doc_path: string | null;
  doc_bytes: number;
  doc_word_count: number;

  /** Top-level entries from the FIRST tree block, filtered to dirs. */
  declared_apps: string[];
  apps_present: string[];
  apps_missing: string[];

  layout: {
    total_paths: number;
    matched_paths: number;
    /** % of declared paths that exist in the extracted archive. */
    match_pct: number;
  };

  stack: {
    total_libs: number;
    matched_libs: number;
    matched_lib_names: string[];
    /** % of declared libs that exist in some package.json. */
    match_pct: number;
  };

  /** Convention rules we extracted (informational — not all are verified). */
  convention_rules: ConventionRuleClaim[];

  /** Weighted aggregate (layout 70 / stack 30). 0..100. */
  compliance_pct: number;

  duration_ms: number;
  warnings: string[];
};

const DOC_NAME_PATTERNS: RegExp[] = [
  /^file-architecture\.md$/i,
  /^architecture\.md$/i,
  /^arch\.md$/i,
  /^design\.md$/i,
];

/**
 * Find a file-architecture.md / ARCHITECTURE.md / similar at depth ≤ 2.
 * Returns the path relative to repo root, or null if no doc was found.
 */
export function findArchitectureDoc(repo: ExtractedRepo): string | null {
  // Prefer shallowest matches first (root → docs/ → .github/).
  const candidates = repo.files.filter((f) => {
    if (f.split("/").length > 3) return false; // depth ≤ 2
    const name = f.split("/").pop() ?? "";
    return DOC_NAME_PATTERNS.some((rx) => rx.test(name));
  });
  candidates.sort((a, b) => {
    const da = a.split("/").length;
    const db = b.split("/").length;
    if (da !== db) return da - db;
    // Prefer root-level "file-architecture.md" over "architecture.md".
    const an = (a.split("/").pop() ?? "").toLowerCase();
    const bn = (b.split("/").pop() ?? "").toLowerCase();
    if (an === "file-architecture.md") return -1;
    if (bn === "file-architecture.md") return 1;
    return a.localeCompare(b);
  });
  return candidates[0] ?? null;
}

/**
 * Parse fenced code blocks that look like ASCII trees and extract the
 * declared file/directory paths, plus tech-stack mentions and a few
 * common convention rules.
 */
export function parseArchitectureDoc(text: string): {
  paths: PathClaim[];
  stack_libs: StackClaim[];
  declared_apps: string[];
  convention_rules: ConventionRuleClaim[];
} {
  const paths: PathClaim[] = [];
  const declaredApps: string[] = [];

  // 1. Find every fenced code block.
  const blocks: string[] = [];
  const fenceRx = /```[a-zA-Z0-9_+-]*\s*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRx.exec(text)) !== null) {
    blocks.push(m[1]);
  }

  // 2. For every block that contains box-drawing characters, parse it
  //    as an ASCII tree and extract paths.
  let isFirstTree = true;
  for (const block of blocks) {
    if (!/[├└│─]/.test(block)) continue;
    const claims = parseTreeBlock(block);
    if (claims.length === 0) continue;

    // Top-level entries from the very first tree are treated as the
    // "declared apps" — directories the project promises to ship at
    // the repo root. We deliberately exclude files (CI configs like
    // `.gitlab-ci.yml`, READMEs, MR templates, lockfiles, etc.) since
    // they're not "apps" — flagging them as `apps_missing` produced
    // false-positive readability hits when a candidate moved their
    // CI file or simply omitted it from the doc tree.
    if (isFirstTree) {
      for (const c of claims) {
        if (!c.is_dir || c.is_glob) continue;
        const segs = c.declared.split("/");
        if (segs.length === 2) declaredApps.push(segs[1]);
      }
      isFirstTree = false;
    }
    paths.push(...claims);
  }

  // 3. Stack mentions — pull backtick-wrapped npm-package-looking
  //    tokens, but only inside sections whose heading hints at deps /
  //    stack / tooling. This dramatically reduces false positives
  //    from things like `useExams` or `req.body` being treated as deps.
  const stack_libs: StackClaim[] = [];
  const seenStackLib = new Set<string>();
  const sectionMatches = Array.from(text.matchAll(/^#{1,6}\s+(.*)$/gm));
  for (let i = 0; i < sectionMatches.length; i += 1) {
    const heading = sectionMatches[i][1].trim();
    if (
      !/(depend|stack|tooling|tech|librar|infrastruct|tool\b)/i.test(heading)
    )
      continue;
    const start = sectionMatches[i].index ?? 0;
    const end =
      i + 1 < sectionMatches.length
        ? (sectionMatches[i + 1].index ?? text.length)
        : text.length;
    const content = text.slice(start, end);
    // Backtick-wrapped tokens. Allow scoped packages (@x/y) and dotted
    // names (next.js, …) but reject anything with whitespace or '/'
    // outside of scoped packages.
    const tokenRx = /`([@a-z0-9][a-z0-9._/-]*)`/gi;
    let tm: RegExpExecArray | null;
    while ((tm = tokenRx.exec(content)) !== null) {
      const name = tm[1];
      if (name.length > 60) continue;
      if (name.includes("/") && !name.startsWith("@")) continue;
      if (/^v?\d+(\.\d+)*$/.test(name)) continue; // version strings
      const key = name.toLowerCase();
      if (seenStackLib.has(key)) continue;
      seenStackLib.add(key);
      stack_libs.push({ name, section: heading });
    }
  }

  // 4. Convention rules — text patterns that *look* like architectural
  //    rules. We extract them for the UI even though most are not yet
  //    auto-verified. Recognised patterns:
  //       - "No `LIB` imports in DIR (and|or) DIR …"
  //       - "All X must use Y."
  //       - "Each X mirrors Y."
  const convention_rules: ConventionRuleClaim[] = [];
  const noImportRx =
    /No\s+`([^`]+)`\s+imports?\s+in\s+([^.\n]+?)(?:\.|\n)/gi;
  let nm: RegExpExecArray | null;
  while ((nm = noImportRx.exec(text)) !== null) {
    convention_rules.push({
      type: "import-forbidden",
      raw: nm[0].trim(),
      lib: nm[1].trim(),
      scope: nm[2].trim(),
    });
  }
  // Pull a couple of catch-all "Each X" / "All X" rules so the UI has
  // something to display, even if we can't verify them automatically.
  const generalRuleRx =
    /(?:^|\n)\s*-\s*\*\*([^.*\n]{3,80})\.\*\*\s+([^\n]+)/g;
  let gm: RegExpExecArray | null;
  while ((gm = generalRuleRx.exec(text)) !== null) {
    convention_rules.push({
      type: "unknown",
      raw: `${gm[1].trim()}. ${gm[2].trim()}`.slice(0, 240),
    });
  }

  return { paths, stack_libs, declared_apps: declaredApps, convention_rules };
}

/**
 * Parse a single ASCII-tree fenced block (e.g. the contents of one
 * code fence) into a list of declared paths.
 *
 * Algorithm:
 *   - The first non-empty line that ends with `/` (or is just an
 *     identifier) is the *root* of the tree. We push it onto the stack.
 *   - Every subsequent line that contains a branch marker (`├── ` or
 *     `└── `) declares a path. The depth of the path is determined by
 *     the column where the box-drawing char appears (4 columns = 1 nest
 *     level). The path is reconstructed by joining the running stack of
 *     parent dirs.
 *   - Lines whose content is `…` / `...` are skipped (they're
 *     intentionally elided in the doc).
 *   - Names ending with `/` are dirs and pushed onto the stack;
 *     everything else is a file leaf.
 */
function parseTreeBlock(block: string): PathClaim[] {
  const lines = block.split("\n");
  const out: PathClaim[] = [];
  // `stack[i]` = the directory name at depth i. The root sits at
  // stack[0]; first-level children are at depth 1.
  const stack: string[] = [];
  let rootSet = false;

  for (const raw of lines) {
    if (!raw.trim()) continue;

    if (!rootSet) {
      // First non-empty line — try to treat it as the root.
      const rootMatch = raw.trim().match(/^([\w.@-]+)\/?\s*$/);
      if (rootMatch) {
        stack.push(rootMatch[1].replace(/\/$/, ""));
        rootSet = true;
        continue;
      }
      // If the first line isn't a clean root, give up and treat
      // subsequent paths as relative to repo root (no prefix).
      rootSet = true;
    }

    // Branch lines must contain `── ` (two dashes + space) somewhere.
    const branchIdx = raw.indexOf("── ");
    if (branchIdx === -1) continue;
    const branchCharCol = Math.max(0, branchIdx - 1);
    const depth = Math.floor(branchCharCol / 4) + 1;

    let after = raw.slice(branchIdx + 3); // skip "── "
    after = after.replace(/^\s+/, "");
    if (!after) continue;

    // Skip ellipsis-only entries.
    if (/^(\.{3,}|…)\s*$/.test(after)) continue;

    // Extract the file/dir name (until 2+ spaces, which separate the
    // "right-hand column" comment).
    const nameMatch = after.match(/^(\S+(?:\s\S+)*?)(?:\s{2,}(.*))?$/);
    if (!nameMatch) continue;
    const rawName = nameMatch[1].trim();
    if (!rawName) continue;

    let description = (nameMatch[2] ?? "").trim();
    if (description.length > 200) description = description.slice(0, 200);

    const cleanedRaw = rawName.replace(/[`'"]/g, "");

    // Truncate the parent stack to `depth` (i.e. drop anything at our
    // depth or deeper) so the path is rebuilt from valid ancestors.
    while (stack.length > depth) stack.pop();

    // ── Case A: comma-separated batch ───────────────────────────────
    // Real-world docs compress many files onto one tree line, e.g.
    //   ├── User.ts, Organization.ts, License.ts, LicenseRequest.ts
    // We recognise the pattern and emit one PathClaim per filename.
    const commaItems = expandCommaList(cleanedRaw, description);
    if (commaItems) {
      for (const item of commaItems) {
        out.push({
          declared: [...stack, item.name].join("/"),
          is_dir: item.is_dir,
          is_glob: item.is_glob,
          description: "",
        });
      }
      continue;
    }

    // ── Case B: single-space description glued to filename ──────────
    // Some docs use only ONE space between the name column and the
    // description column (e.g. `└── file-architecture.md This document`).
    // The 2+ space heuristic above misses these, so we fall back to
    // splitting at the first space when the head-portion still looks
    // like a clean filename / dirname / glob.
    let name = cleanedRaw;
    if (name.includes(" ")) {
      const firstSpace = name.indexOf(" ");
      const head = name.slice(0, firstSpace);
      if (/^[\w@./*?-]+\/?$/.test(head)) {
        description = (name.slice(firstSpace + 1) + " " + description).trim();
        name = head;
      }
    }

    const isDir = name.endsWith("/");
    if (isDir) name = name.slice(0, -1);
    if (!name) continue;
    const isGlob = /[*?]/.test(name);

    out.push({
      declared: [...stack, name].join("/"),
      is_dir: isDir,
      is_glob: isGlob,
      description,
    });

    if (isDir && !isGlob) stack.push(name);
  }

  return out;
}

/**
 * Detect a comma-separated batch like `User.ts, Organization.ts, License.ts`
 * (with or without a trailing comma indicating "list continues on next
 * line"). Returns null if the input doesn't look like a valid batch.
 *
 * We're conservative: every item must look like a clean filename / dir
 * name / glob (no internal spaces, no slashes). If even one part has a
 * space or slash we fall back to single-name parsing.
 */
function expandCommaList(
  raw: string,
  trailingDescription: string
): Array<{ name: string; is_dir: boolean; is_glob: boolean }> | null {
  // Combine the raw name with the description because docs sometimes
  // wrap mid-list:  `User.ts, Organization.ts,   License.ts`
  // (the column-splitter sees 3 spaces and sends the tail to description.)
  const combined = trailingDescription
    ? `${raw}, ${trailingDescription}`
    : raw;
  if (!combined.includes(",")) return null;
  const parts = combined.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  // Also accept "and" as a final separator: `A.ts, B.ts and C.ts`.
  const flat: string[] = [];
  for (const p of parts) {
    if (/\s+and\s+/i.test(p)) {
      const sub = p.split(/\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
      flat.push(...sub);
    } else {
      flat.push(p);
    }
  }
  const FILE_RX = /^[\w@.*?-]+\/?$/;
  if (!flat.every((p) => FILE_RX.test(p))) return null;
  return flat.map((p) => {
    const is_dir = p.endsWith("/");
    const name = is_dir ? p.slice(0, -1) : p;
    return { name, is_dir, is_glob: /[*?]/.test(name) };
  });
}

export type ScanArchOpts = {
  /** Set of npm package names already known to the repo (union of all package.jsons). */
  knownLibs?: Set<string>;
};

export function scanRepoArchitecture(
  repo: ExtractedRepo,
  opts: ScanArchOpts = {}
): RepoArchitectureSignals {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const docPath = findArchitectureDoc(repo);

  if (!docPath) {
    return emptyResult({
      duration_ms: Date.now() - startedAt,
      warning:
        "No file-architecture.md / ARCHITECTURE.md / docs/architecture.md found at depth ≤ 2.",
    });
  }

  const text = readRepoFile(repo, docPath, 256 * 1024);
  if (text === null) {
    return emptyResult({
      duration_ms: Date.now() - startedAt,
      docPath,
      warning: `Architecture doc found at ${docPath} but is too large or unreadable.`,
    });
  }

  const { paths, stack_libs, declared_apps, convention_rules } =
    parseArchitectureDoc(text);

  // Build a fast lookup of every file and every directory in the repo.
  const fileSet = new Set(repo.files);
  const dirSet = new Set<string>();
  for (const f of repo.files) {
    const segs = f.split("/");
    for (let i = 1; i < segs.length; i += 1) {
      dirSet.add(segs.slice(0, i).join("/"));
    }
  }

  // ── Layout verification ────────────────────────────────────────────
  const matchedPaths: string[] = [];
  const unmatchedPaths: string[] = [];
  let skippedRuntimePaths = 0;

  for (const claim of paths) {
    // Skip declared files that we know will *never* appear in a git
    // archive — log files, runtime caches, dotfiles like `.env`, build
    // outputs, dependency dirs, etc. These are commonly listed in arch
    // docs as "where the runtime puts X" but are .gitignore'd.
    if (isRuntimePath(claim.declared)) {
      skippedRuntimePaths += 1;
      continue;
    }

    const variants = pathVariants(claim.declared);
    let matched = false;

    if (claim.is_glob) {
      // Glob entries (e.g. `*.controller.ts`): the parent dir must
      // contain at least one file matching the pattern.
      for (const v of variants) {
        const lastSlash = v.lastIndexOf("/");
        const parent = lastSlash === -1 ? "" : v.slice(0, lastSlash);
        const baseName = v.slice(lastSlash + 1);
        const rx = globToRegex(baseName);
        if (
          repo.files.some((f) => {
            if (parent === "") {
              if (f.includes("/")) return false;
            } else {
              if (!f.startsWith(parent + "/")) return false;
              const rest = f.slice(parent.length + 1);
              if (rest.includes("/")) return false; // direct child only
            }
            const fname = f.split("/").pop() ?? "";
            return rx.test(fname);
          })
        ) {
          matched = true;
          break;
        }
      }
    } else if (claim.is_dir) {
      for (const v of variants) {
        if (dirSet.has(v)) {
          matched = true;
          break;
        }
      }
    } else {
      for (const v of variants) {
        if (fileSet.has(v)) {
          matched = true;
          break;
        }
        // For "leaf" claims like `*.test.ts` slipped through without
        // is_glob, also try the parent + name match.
      }
    }

    if (matched) matchedPaths.push(claim.declared);
    else unmatchedPaths.push(claim.declared);
  }

  // ── App verification (subset of layout — surfaced separately) ──────
  const appsPresent: string[] = [];
  const appsMissing: string[] = [];
  for (const app of declared_apps) {
    const cleaned = app.replace(/\/$/, "");
    if (dirSet.has(cleaned) || fileSet.has(cleaned)) {
      appsPresent.push(app);
    } else {
      appsMissing.push(app);
    }
  }

  // ── Stack verification ─────────────────────────────────────────────
  const knownLibs = opts.knownLibs ?? new Set<string>();
  const knownLibsLc = new Set(
    Array.from(knownLibs).map((s) => s.toLowerCase())
  );
  const matchedLibSet = new Set<string>();
  for (const claim of stack_libs) {
    const lc = claim.name.toLowerCase();
    if (knownLibsLc.has(lc)) {
      matchedLibSet.add(claim.name);
      continue;
    }
    // Allow flexible matching: doc says "tensorflow.js" but pkg has
    // "@tensorflow/tfjs-core". Accept either-direction substrings.
    const fuzzy = Array.from(knownLibsLc).some(
      (lib) => lib.includes(lc) || lc.includes(lib)
    );
    if (fuzzy) matchedLibSet.add(claim.name);
  }

  if (skippedRuntimePaths > 0) {
    warnings.push(
      `${skippedRuntimePaths} declared path(s) skipped (runtime / .gitignored — e.g. logs, .env, node_modules).`
    );
  }

  // ── Aggregate compliance ───────────────────────────────────────────
  const totalVerifiedPaths = matchedPaths.length + unmatchedPaths.length;
  const layoutPct =
    totalVerifiedPaths > 0 ? matchedPaths.length / totalVerifiedPaths : 0;
  const stackPct =
    stack_libs.length > 0 ? matchedLibSet.size / stack_libs.length : 0;
  // Weight: layout 70 / stack 30. If either is missing, fall back.
  let compliance: number;
  if (paths.length === 0 && stack_libs.length === 0) compliance = 0;
  else if (stack_libs.length === 0) compliance = layoutPct;
  else if (paths.length === 0) compliance = stackPct;
  else compliance = layoutPct * 0.7 + stackPct * 0.3;

  return {
    has_doc: true,
    doc_path: docPath,
    doc_bytes: text.length,
    doc_word_count: text.split(/\s+/).filter(Boolean).length,
    declared_apps,
    apps_present: appsPresent,
    apps_missing: appsMissing,
    layout: {
      total_paths: totalVerifiedPaths,
      matched_paths: matchedPaths.length,
      match_pct: Math.round(layoutPct * 100),
    },
    stack: {
      total_libs: stack_libs.length,
      matched_libs: matchedLibSet.size,
      matched_lib_names: Array.from(matchedLibSet).slice(0, 30),
      match_pct: Math.round(stackPct * 100),
    },
    convention_rules: convention_rules.slice(0, 30),
    compliance_pct: Math.round(compliance * 100),
    duration_ms: Date.now() - startedAt,
    warnings,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * For a declared path like `wecp/backend/src/server.ts`, generate
 * candidate paths to try against the actual repo:
 *   - as declared
 *   - first segment stripped (if it was the project name like `wecp/`)
 *   - first two segments stripped (defensive — for nested doc roots)
 */
function pathVariants(declared: string): string[] {
  const variants = [declared];
  const segs = declared.split("/");
  if (segs.length > 1) variants.push(segs.slice(1).join("/"));
  if (segs.length > 2) variants.push(segs.slice(2).join("/"));
  return variants;
}

/**
 * Patterns for files that are typically *runtime artefacts* or
 * gitignored — they often appear in architecture docs ("where logs go",
 * "env file template lives here") but won't be in a git archive. We
 * skip them entirely so they don't drag compliance % down.
 */
const RUNTIME_PATH_PATTERNS: RegExp[] = [
  /\.log$/i,
  /\.tmp$/i,
  /\.cache$/i,
  /\.pid$/i,
  /\.lock$/i,
  /\.swp$/i,
  /\.DS_Store$/,
  /(^|\/)logs?(\/|$)/i,
  /(^|\/)tmp(\/|$)/i,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)\.cache(\/|$)/,
  /(^|\/)\.parcel-cache(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /(^|\/)\.nyc_output(\/|$)/,
  /(^|\/)\.env$/,
  /(^|\/)\.env\.local$/,
];

function isRuntimePath(declared: string): boolean {
  return RUNTIME_PATH_PATTERNS.some((rx) => rx.test(declared));
}

function globToRegex(glob: string): RegExp {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else if (/[.+^${}()|[\]\\]/.test(ch)) out += "\\" + ch;
    else out += ch;
  }
  return new RegExp("^" + out + "$");
}

function emptyResult(opts: {
  duration_ms: number;
  docPath?: string;
  warning?: string;
}): RepoArchitectureSignals {
  return {
    has_doc: !!opts.docPath,
    doc_path: opts.docPath ?? null,
    doc_bytes: 0,
    doc_word_count: 0,
    declared_apps: [],
    apps_present: [],
    apps_missing: [],
    layout: {
      total_paths: 0,
      matched_paths: 0,
      match_pct: 0,
    },
    stack: {
      total_libs: 0,
      matched_libs: 0,
      matched_lib_names: [],
      match_pct: 0,
    },
    convention_rules: [],
    compliance_pct: 0,
    duration_ms: opts.duration_ms,
    warnings: opts.warning ? [opts.warning] : [],
  };
}
