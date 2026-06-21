import "server-only";
import { readRepoFile, type ExtractedRepo } from "./archive-walker";
import type { ConventionRuleClaim } from "./repo-architecture-scan";
import {
  emptyAttributesBag,
  pushAttribute,
  type RepoAttributesBag,
} from "./repo-attribute-types";

/**
 * Layering / import-rule scanner.
 *
 * Verifies a small set of common layering rules — both *built-in
 * defaults* (sensible architectural conventions any TS/JS project
 * benefits from) and *project-declared* rules pulled out of the
 * `file-architecture.md`.
 *
 * Built-in defaults (always evaluated):
 *
 *   1. Components must not import from `pages/` (Next.js / React).
 *   2. Models must not import from `controllers/` or `routes/`.
 *   3. Frontend code must not import from `backend/` (and vice versa).
 *   4. Test files should only import production code, not other tests.
 *   5. No deep relative imports (`../../../../`) — refactor signal.
 *
 * Doc-declared `import-forbidden` rules from the architecture parser
 * are also enforced. We don't try to handle every shape of convention
 * the AI writes — only those marked as `type: "import-forbidden"` are
 * verified; the rest are surfaced informationally.
 *
 * For each violation we emit a `LayeringViolation` row, and the bag of
 * violations becomes the per-attribute breakdown.
 */

const SCANNER = "layering" as const;

export type LayeringRule = {
  id: string;
  description: string;
  /** Pattern matched against a source file's path. */
  source_pattern: RegExp;
  /** Pattern matched against the *resolved* import target string. */
  target_pattern: RegExp;
  /** "code_quality" by default. */
  category: "code_quality" | "readability";
  /** Source: built-in vs declared in the architecture doc. */
  source: "builtin" | "doc";
  /** Per-violation penalty contribution (capped on the scoring side). */
  weight: number;
};

export type LayeringViolation = {
  rule_id: string;
  source_file: string;
  imported: string;
  line: number;
  description: string;
};

export type RepoLayeringSignals = {
  rules_evaluated: number;
  total_files_scanned: number;
  violations: LayeringViolation[];
  by_rule: Record<string, number>;
  /** Files that import from ≥4 levels up (`../../../../`). */
  deep_relative_imports: number;
  /**
   * Up-to-15 sample deep-relative imports (file + relative target +
   * approximate line). Surfaces in the analytics evidence card.
   */
  deep_relative_examples: Array<{
    file: string;
    imported: string;
    line: number;
  }>;
  /** Cycles detected by simple two-step traversal — best-effort, not full SCC. */
  suspected_cycles: number;
  /**
   * Up-to-10 example cycle pairs. Each pair is a tuple of file paths
   * that mutually import each other.
   */
  cycle_examples: Array<[string, string]>;
  duration_ms: number;
  warnings: string[];
};

const BUILTIN_RULES: LayeringRule[] = [
  {
    id: "components-import-pages",
    description: "Components should not import from pages/",
    source_pattern: /(^|\/)components(\/|$)/,
    target_pattern: /(^|\/)pages(\/|$)/,
    category: "code_quality",
    source: "builtin",
    weight: 0.4,
  },
  {
    id: "models-import-controllers",
    description: "Models should not import from controllers/ or routes/",
    source_pattern: /(^|\/)models?(\/|$)/,
    target_pattern: /(^|\/)(controllers?|routes?)(\/|$)/,
    category: "code_quality",
    source: "builtin",
    weight: 0.5,
  },
  {
    id: "models-import-services",
    description: "Models should not import from services/",
    source_pattern: /(^|\/)models?(\/|$)/,
    target_pattern: /(^|\/)services?(\/|$)/,
    category: "code_quality",
    source: "builtin",
    weight: 0.3,
  },
  {
    id: "frontend-imports-backend",
    description: "Frontend code should not import from backend/",
    source_pattern: /(^|\/)(frontend|client|web)(\/|$)/,
    target_pattern: /(^|\/)(backend|server|api\/server)(\/|$)/,
    category: "code_quality",
    source: "builtin",
    weight: 0.6,
  },
  {
    id: "backend-imports-frontend",
    description: "Backend code should not import from frontend/",
    source_pattern: /(^|\/)(backend|server)(\/|$)/,
    target_pattern: /(^|\/)(frontend|client|web)(\/|$)/,
    category: "code_quality",
    source: "builtin",
    weight: 0.6,
  },
  {
    id: "tests-import-tests",
    description: "Test files should only import production code, not other tests",
    source_pattern: /\.(test|spec)\.[a-z]+$/i,
    target_pattern: /\.(test|spec)\.[a-z]+$/i,
    category: "readability",
    source: "builtin",
    weight: 0.2,
  },
];

const SOURCE_EXT_RX = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const IMPORT_RX = /(?:import\s+[^'"\n]+from\s+|require\s*\(|import\s*\(\s*)['"`]([^'"`]+)['"`]/g;

function looksLikeSource(p: string): boolean {
  if (!SOURCE_EXT_RX.test(p)) return false;
  if (p.includes("/node_modules/") || p.includes("/dist/") || p.includes("/build/"))
    return false;
  return true;
}

function lineForOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * Resolve a relative import target into a normalised "logical path"
 * suitable for matching the rule's `target_pattern`. We don't need the
 * actual file extension — we just need a string the regex can match.
 */
function resolveTarget(sourceFile: string, target: string): string | null {
  if (target.startsWith(".")) {
    const sourceDir = sourceFile.split("/").slice(0, -1).join("/");
    const parts = target.split("/").filter(Boolean);
    const stack = sourceDir.split("/").filter(Boolean);
    for (const part of parts) {
      if (part === ".") continue;
      else if (part === "..") stack.pop();
      else stack.push(part);
    }
    return stack.join("/");
  }
  if (target.startsWith("@/")) {
    return target.slice(2); // strip the alias prefix
  }
  if (target.startsWith("~/")) {
    return target.slice(2);
  }
  // Bare specifier (npm package) — useless for layout rules.
  if (!target.startsWith("/")) return null;
  return target.slice(1);
}

/**
 * Translate a doc-declared `import-forbidden` convention rule into a
 * concrete `LayeringRule` we can run.
 */
function ruleFromConvention(
  c: ConventionRuleClaim
): LayeringRule | null {
  if (c.type !== "import-forbidden") return null;
  if (!c.lib || !c.scope) return null;
  // The scope text may be a list ("pages or components"); split on
  // common conjunctions and keep word characters only.
  const scopes = c.scope
    .split(/\b(?:or|and)\b|,/)
    .map((s) => s.replace(/[^\w/-]/g, "").trim())
    .filter(Boolean);
  if (scopes.length === 0) return null;
  // Build a regex like `/(^|\/)(pages|components)(\/|$)/` to match the
  // source file's path against any declared scope.
  const sourceRx = new RegExp(
    `(^|/)(${scopes.map((s) => s.replace(/[.\\+*?^$|()[\]{}]/g, "\\$&")).join("|")})(/|$)`,
    "i"
  );
  // Target is a literal lib match against the import specifier.
  const lib = c.lib.replace(/[.\\+*?^$|()[\]{}]/g, "\\$&");
  const targetRx = new RegExp(`^${lib}(/|$)`);
  return {
    id: `doc:${scopes.join("+")}-no-${c.lib}`,
    description: c.raw,
    source_pattern: sourceRx,
    target_pattern: targetRx,
    category: "code_quality",
    source: "doc",
    weight: 0.5,
  };
}

export type ScanLayeringOpts = {
  conventionRules: ConventionRuleClaim[];
};

export function scanRepoLayering(
  repo: ExtractedRepo,
  opts: ScanLayeringOpts = { conventionRules: [] }
): RepoLayeringSignals {
  const startedAt = Date.now();
  const warnings: string[] = [];

  const docRules = opts.conventionRules
    .map(ruleFromConvention)
    .filter((r): r is LayeringRule => r != null);
  const allRules: LayeringRule[] = [...BUILTIN_RULES, ...docRules];

  const violations: LayeringViolation[] = [];
  const byRule: Record<string, number> = {};
  for (const r of allRules) byRule[r.id] = 0;

  const candidates = repo.files.filter(looksLikeSource);
  let deepRel = 0;
  const deepRelExamples: Array<{
    file: string;
    imported: string;
    line: number;
  }> = [];
  // Lightweight cycle detection: per file, track which other files in
  // the same module bucket import it. After scanning, any pair of files
  // that mutually import each other counts as a suspected cycle.
  // (Two-file cycles only — full SCC analysis would be too heavy here.)
  const importsBy = new Map<string, Set<string>>();

  for (const filePath of candidates) {
    const text = readRepoFile(repo, filePath, 256 * 1024);
    if (!text) continue;
    let m: RegExpExecArray | null;
    IMPORT_RX.lastIndex = 0;
    const importsForFile = new Set<string>();
    while ((m = IMPORT_RX.exec(text)) !== null) {
      const target = m[1];
      // Deep relative imports (`../../../../`) are usually a refactor
      // smell. We count the number of `..` segments at the start.
      let dotdots = 0;
      let probe = target;
      while (probe.startsWith("../")) {
        dotdots += 1;
        probe = probe.slice(3);
      }
      if (dotdots >= 4) {
        deepRel += 1;
        if (deepRelExamples.length < 15) {
          deepRelExamples.push({
            file: filePath,
            imported: target,
            line: lineForOffset(text, m.index ?? 0),
          });
        }
      }

      const resolved = resolveTarget(filePath, target);
      if (resolved) importsForFile.add(resolved);
      const candidate = resolved ?? target;
      for (const r of allRules) {
        if (!r.source_pattern.test(filePath)) continue;
        if (!r.target_pattern.test(candidate)) continue;
        // Skip self-import (e.g. `services/foo.ts` importing from
        // `services/bar` matches `services-import-services` if we ever
        // add such a rule). We don't currently have one, but we still
        // want to avoid `tests-import-tests` flagging on the same file.
        if (resolved === filePath.replace(SOURCE_EXT_RX, "")) continue;
        violations.push({
          rule_id: r.id,
          source_file: filePath,
          imported: target,
          line: lineForOffset(text, m.index ?? 0),
          description: r.description,
        });
        byRule[r.id] = (byRule[r.id] ?? 0) + 1;
      }
    }
    importsBy.set(filePath, importsForFile);
  }

  // Two-file cycles: A imports B AND B imports A (using normalised path
  // matching — drop extension when comparing).
  let cycles = 0;
  const cycleExamples: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [a, aImports] of importsBy) {
    const aStem = a.replace(SOURCE_EXT_RX, "");
    for (const ti of aImports) {
      // Find a real file matching the imported logical path.
      // Cheap check: any candidate that startsWith(ti).
      const matchedB = candidates.find((c) => c.startsWith(ti + "."));
      if (!matchedB) continue;
      // Self-import (e.g. `import x from "./worklog.service"` from
      // inside `worklog.service.ts`) is not a cycle — it's a
      // re-export pattern in a barrel file. Skip it; otherwise the
      // detector reports `A ⇄ A` cycles which look like a bug to
      // candidates reading the report.
      if (matchedB === a) continue;
      const bImports = importsBy.get(matchedB);
      if (!bImports) continue;
      const matchedA = Array.from(bImports).some((bi) =>
        aStem.endsWith("/" + bi.split("/").pop()!)
      );
      if (!matchedA) continue;
      const key = [a, matchedB].sort().join("\n");
      if (seen.has(key)) continue;
      seen.add(key);
      cycles += 1;
      if (cycleExamples.length < 10) cycleExamples.push([a, matchedB]);
    }
  }

  return {
    rules_evaluated: allRules.length,
    total_files_scanned: candidates.length,
    violations: violations.slice(0, 200), // cap for storage / UI
    by_rule: byRule,
    deep_relative_imports: deepRel,
    deep_relative_examples: deepRelExamples,
    suspected_cycles: cycles,
    cycle_examples: cycleExamples,
    duration_ms: Date.now() - startedAt,
    warnings,
  };
}

export function layeringAttributes(
  s: RepoLayeringSignals
): RepoAttributesBag {
  const bag = emptyAttributesBag();
  if (s.total_files_scanned === 0) return bag;

  const totalViolations = s.violations.length;
  if (totalViolations === 0 && s.rules_evaluated > 0) {
    pushAttribute(bag, {
      category: "code_quality",
      scanner: SCANNER,
      attribute_key: "no_layering_violations",
      attribute_value: 1,
      attribute_label: `Zero layering-rule violations across ${s.rules_evaluated} rule(s)`,
      delta_to_score: +0.6,
      evidence: {
        rules_evaluated: s.rules_evaluated,
        total_files_scanned: s.total_files_scanned,
      },
    });
  } else if (totalViolations <= 5) {
    pushAttribute(bag, {
      category: "code_quality",
      scanner: SCANNER,
      attribute_key: "layering_violations",
      attribute_value: totalViolations,
      attribute_label: `${totalViolations} layering-rule violation(s)`,
      delta_to_score: -0.2,
      evidence: s.violations.map(
        (v) => `${v.source_file}:${v.line} → ${v.imported} (${v.rule_id})`
      ),
    });
  } else {
    pushAttribute(bag, {
      category: "code_quality",
      scanner: SCANNER,
      attribute_key: "layering_violations",
      attribute_value: totalViolations,
      attribute_label: `${totalViolations} layering-rule violations across rules: ${Object.entries(s.by_rule).filter(([, v]) => v > 0).map(([k, v]) => `${k}(${v})`).join(", ")}`,
      delta_to_score: -Math.min(1.2, 0.3 + totalViolations * 0.04),
      evidence: s.violations.map(
        (v) => `${v.source_file}:${v.line} → ${v.imported} (${v.rule_id})`
      ),
    });
  }

  if (s.deep_relative_imports >= 5) {
    pushAttribute(bag, {
      category: "readability",
      scanner: SCANNER,
      attribute_key: "deep_relative_imports",
      attribute_value: s.deep_relative_imports,
      attribute_label: `${s.deep_relative_imports} deep relative imports (\`../../../../\`)`,
      delta_to_score: -Math.min(0.6, 0.1 + s.deep_relative_imports * 0.02),
      evidence: s.deep_relative_examples.map(
        (e) => `${e.file}:${e.line} → ${e.imported}`
      ),
    });
  } else if (s.deep_relative_imports > 0) {
    pushAttribute(bag, {
      category: "readability",
      scanner: SCANNER,
      attribute_key: "deep_relative_imports",
      attribute_value: s.deep_relative_imports,
      attribute_label: `${s.deep_relative_imports} deep relative import(s)`,
      delta_to_score: 0,
      evidence: s.deep_relative_examples.map(
        (e) => `${e.file}:${e.line} → ${e.imported}`
      ),
    });
  }

  if (s.suspected_cycles > 0) {
    pushAttribute(bag, {
      category: "code_quality",
      scanner: SCANNER,
      attribute_key: "import_cycles",
      attribute_value: s.suspected_cycles,
      attribute_label: `${s.suspected_cycles} suspected two-file import cycle(s)`,
      delta_to_score: -Math.min(0.6, s.suspected_cycles * 0.2),
      evidence: s.cycle_examples.map(([a, b]) => `${a} ⇄ ${b}`),
    });
  }

  return bag;
}
