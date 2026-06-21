/**
 * Per-attribute remediation hints + severity classification used on
 * the analytics page (drill-down "How to fix" panel) and the
 * "Critical hotlist" banner.
 *
 * Each entry maps a `(scanner, attribute_key)` pair to:
 *
 *   - `severity` — used by the hotlist to filter the must-fix items.
 *   - `summary`  — one-sentence description of why this matters.
 *   - `playbook` — bullet list of concrete next steps. Stays generic
 *     across stacks — language/ORM-specific tips are added inline
 *     where they're cheap to express.
 *   - `docs`     — optional external link for deeper reading.
 *
 * Adding a new finding type? Just append to the registry. Unknown
 * attribute keys are still rendered with a generic explanation, so
 * forgetting to add an entry doesn't break the UI.
 */

export type FixHintSeverity = "critical" | "warning" | "info";

export type FixHint = {
  severity: FixHintSeverity;
  summary: string;
  playbook: string[];
  docs?: { label: string; url: string };
};

const HINTS: Record<string, FixHint> = {
  // ── routes ────────────────────────────────────────────────────────────
  "routes:total_routes": {
    severity: "info",
    summary: "Inventory of every HTTP endpoint detected across the repo.",
    playbook: [
      "Use this list to confirm coverage of OpenAPI/Postman docs.",
      "Cross-check with the test-map scanner to spot endpoints without router-level tests.",
    ],
  },
  "routes:routes_without_validation": {
    severity: "warning",
    summary: "Handlers that accept request bodies/queries without a validator.",
    playbook: [
      "Wire Zod / Joi / class-validator before the handler reads `req.body`.",
      "Reject unknown fields by default (`strict()` in Zod / `forbidNonWhitelisted` in NestJS).",
      "Cover the validator with a unit test that exercises a malformed payload.",
    ],
  },
  "routes:routes_without_rate_limit": {
    severity: "warning",
    summary: "Routes lacking a rate-limit middleware.",
    playbook: [
      "Add `express-rate-limit` / `@fastify/rate-limit` / `@nestjs/throttler` at the router or app level.",
      "Tighten the limit on auth-sensitive paths (login, password reset, signup).",
      "Verify the limiter respects the proxy's X-Forwarded-For header in your deployment.",
    ],
  },
  "routes:duplicate_paths": {
    severity: "warning",
    summary:
      "Same `(method, path)` declared more than once — only the last handler wins.",
    playbook: [
      "Search the repo for the duplicate path and merge the handlers.",
      "Use a router-level prefix to disambiguate (e.g. /v1/users vs /v2/users).",
    ],
  },
  "routes:public_routes": {
    severity: "info",
    summary: "Routes you've explicitly opted into being public.",
    playbook: [
      "Audit which paths show up here — accidental opt-in is a common security gap.",
    ],
  },

  // ── test map ─────────────────────────────────────────────────────────
  "test-map:test_deserts": {
    severity: "warning",
    summary:
      "Modules with many source files and zero co-located / sibling tests.",
    playbook: [
      "Add at least one happy-path + one error-path test per module.",
      "If the module is a thin facade, consider deleting it instead of testing it.",
      "Wire a coverage threshold in CI to keep new test deserts from appearing.",
    ],
  },
  "test-map:files_per_test": {
    severity: "warning",
    summary: "Source-files-per-test ratio. Higher is worse.",
    playbook: [
      "Aim for ≤ 3 source files per test as a rough rule of thumb.",
      "Prioritise tests around the highest-churn modules first.",
    ],
  },
  "test-map:coverage_pct": {
    severity: "info",
    summary: "Percentage of source files with at least one matching test file.",
    playbook: [
      "Publish a coverage report from CI and gate merges on a minimum threshold.",
    ],
  },
  "test-map:well_tested": {
    severity: "info",
    summary: "Modules where tests outnumber the source files. Keep going!",
    playbook: ["Use these as templates when adding tests elsewhere."],
  },

  // ── layering ─────────────────────────────────────────────────────────
  "layering:violations": {
    severity: "warning",
    summary: "Imports that break declared architectural layering rules.",
    playbook: [
      "Refactor the offending import: bubble shared code up to a common layer (e.g. `lib/`).",
      "If the rule is genuinely too strict, update `file-architecture.md` so reality matches the doc.",
    ],
  },
  "layering:deep_relative_imports": {
    severity: "info",
    summary: "Files that reach across the tree via `../../..` chains.",
    playbook: [
      "Replace deep relatives with a project-root alias (tsconfig `paths`, ESM imports map).",
      "Long chains usually signal a misplaced module — consider relocating it.",
    ],
  },
  "layering:suspected_cycles": {
    severity: "warning",
    summary: "Modules whose imports likely form a cycle.",
    playbook: [
      "Run `madge` / `tsc --listFiles` locally to confirm and visualise.",
      "Break cycles by extracting shared types/interfaces to a leaf module.",
    ],
  },

  // ── env ──────────────────────────────────────────────────────────────
  "env:undeclared_keys": {
    severity: "warning",
    summary:
      "`process.env.X` references in code that aren't documented in any `.env.example`.",
    playbook: [
      "Add the key to `.env.example` so onboarding instructions stay accurate.",
      "Wrap reads in a `requireEnv()` helper that throws at boot if the var is unset.",
    ],
  },
  "env:unused_keys": {
    severity: "info",
    summary: "Keys declared in `.env.example` that no code reads.",
    playbook: [
      "Remove dead config — stale env vars confuse new contributors.",
    ],
  },
  "env:committed_env_files": {
    severity: "critical",
    summary:
      "`.env` files (or similar) committed to the repo — likely contains real secrets.",
    playbook: [
      "Rotate every credential that ever appeared in git history (treat them as leaked).",
      "Add the file to `.gitignore` and replace it with a sanitised `.env.example`.",
      "Use `git filter-repo` / BFG to scrub the file from history before publishing.",
    ],
    docs: {
      label: "GitHub: removing sensitive data",
      url: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository",
    },
  },
  "env:has_no_example": {
    severity: "info",
    summary: "Repo has env-var usage but ships no `.env.example`.",
    playbook: [
      "Generate one from the env-scan's discovered keys to unblock onboarding.",
    ],
  },

  // ── schema ───────────────────────────────────────────────────────────
  "schema:tables_missing_indexes": {
    severity: "critical",
    summary: "Tables/models that don't declare a single non-PK index.",
    playbook: [
      "Add an index on the most-queried column(s). For ORMs:",
      "  • Prisma: `@@index([col])` in the model block.",
      "  • TypeORM: `@Index(['col'])` on the entity class.",
      "  • Mongoose: `schema.index({ col: 1 })` after the schema definition.",
      "  • SQL: `CREATE INDEX idx_table_col ON table(col);` in a migration.",
      "Verify the planner uses it (`EXPLAIN`, `db.collection.explain()`).",
    ],
  },
  "schema:unindexed_lookup_fields": {
    severity: "warning",
    summary:
      "Foreign-key-shaped or commonly filtered columns without an index.",
    playbook: [
      "Index every FK column unless the table is < 1k rows and stays that way.",
      "Composite indexes win for `WHERE a = ? AND b = ?` queries — order columns by selectivity.",
    ],
  },
  "schema:index_coverage_pct": {
    severity: "info",
    summary: "Share of tables that have at least one non-PK index.",
    playbook: [
      "Aim for 100% on tables with > 10k rows. Smaller lookup tables can be exempt.",
    ],
  },

  // ── deadcode ─────────────────────────────────────────────────────────
  "deadcode:unused_named_exports": {
    severity: "info",
    summary:
      "Named exports that aren't imported anywhere in the repo (coarse graph).",
    playbook: [
      "Delete unused exports — fewer public symbols = simpler refactors.",
      "Whitelist intentionally-public re-exports via a barrel file.",
    ],
  },
  "deadcode:unreferenced_files": {
    severity: "warning",
    summary: "Source files no other module imports.",
    playbook: [
      "Delete or move them under an `examples/` / `scripts/` folder excluded from the build.",
      "If they're entry points (e.g. CLI scripts), add a comment so the next scan skips them.",
    ],
  },

  // ── deps ──────────────────────────────────────────────────────────────
  "deps:phantom_dependencies": {
    severity: "critical",
    summary:
      "Code imports packages that aren't listed in any `package.json` reachable from the importer. They work today via hoisting; they can vanish tomorrow.",
    playbook: [
      "Run `npm ls <pkg>` to confirm the transitive that's resolving the import.",
      "Add the package as a direct dependency in the importing workspace's `package.json`.",
      "If the import is only used in tests, add it to `devDependencies` instead.",
    ],
  },
  "deps:unused_dependencies": {
    severity: "info",
    summary:
      "Packages declared in `package.json` that no source file imports. Bloats install + bundle.",
    playbook: [
      "Search the repo for the package name to be sure (some get consumed via config or scripts).",
      "Run `npm uninstall <pkg>` and rerun the scan to confirm the cleanup.",
      "Common false positives: tooling like prettier/lint-staged consumed only by config files.",
    ],
  },
  "deps:imports_seen": {
    severity: "info",
    summary: "Total unique third-party packages imported across the repo.",
    playbook: [
      "Use this as a proxy for dependency surface. Lower is generally better.",
    ],
  },
};

export function getFixHint(scanner: string, attributeKey: string): FixHint {
  const exact = HINTS[`${scanner}:${attributeKey}`];
  if (exact) return exact;
  // Fallback so the UI always renders something useful — even for
  // attributes we haven't catalogued yet. The summary is intentionally
  // vague; we'd rather over-explain than mis-explain.
  return {
    severity: "info",
    summary:
      "This attribute contributed to the project's score. See the per-scanner docs for details.",
    playbook: [
      "Check the evidence in the row above for context.",
      "Compare against a healthy project to gauge what 'good' looks like.",
    ],
  };
}

export const FIX_HINT_SEVERITY_LABEL: Record<FixHintSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};

export const FIX_HINT_SEVERITY_TONE: Record<FixHintSeverity, string> = {
  critical:
    "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  warning:
    "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  info: "border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
};
