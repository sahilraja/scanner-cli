import fs from "node:fs";
import path from "node:path";
import type {
  CliSignals,
  ContentSignals,
  DepSignals,
  LocalRepo,
  PackageJsonSignals,
  RouteSignals,
} from "./types";
import { readLocalFile } from "./local-walker";

// ── Extension sets ──────────────────────────────────────────────────────────

const SOURCE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift",
  "php", "cs", "cpp", "c", "h", "scala", "ex", "exs",
]);

const TEST_PATTERNS = [
  /\btest[s]?\//i, /\b__tests__\//i, /\.test\.[tj]sx?$/, /\.spec\.[tj]sx?$/,
  /\.test\.py$/, /_test\.go$/, /_spec\.rb$/,
];

const DOC_EXTS = new Set(["md", "mdx", "rst", "txt", "adoc"]);
const CONFIG_EXTS = new Set(["json", "yaml", "yml", "toml", "ini", "env", "lock"]);

// ── Tooling file maps ────────────────────────────────────────────────────────

const KNOWN_FRAMEWORKS: Record<string, string[]> = {
  next: ["next", "next.js"],
  express: ["express"],
  fastify: ["fastify"],
  nestjs: ["@nestjs/core"],
  react: ["react"],
  vue: ["vue"],
  angular: ["@angular/core"],
  svelte: ["svelte"],
  nuxt: ["nuxt"],
  django: ["django"],
  flask: ["flask"],
  fastapi: ["fastapi"],
  rails: ["rails"],
  spring: ["spring-boot"],
};

const KNOWN_VULNERABLE: Array<{ name: string; below: string; reason: string }> = [
  { name: "lodash", below: "4.17.21", reason: "Prototype pollution (CVE-2021-23337)" },
  { name: "axios", below: "0.21.2", reason: "SSRF vulnerability (CVE-2020-28168)" },
  { name: "node-fetch", below: "2.6.7", reason: "Open redirect (CVE-2022-0235)" },
  { name: "minimist", below: "1.2.6", reason: "Prototype pollution (CVE-2021-44906)" },
  { name: "glob-parent", below: "5.1.2", reason: "ReDoS (CVE-2020-28469)" },
  { name: "ansi-regex", below: "5.0.1", reason: "ReDoS (CVE-2021-3807)" },
  { name: "path-parse", below: "1.0.7", reason: "ReDoS (CVE-2021-23343)" },
  { name: "semver", below: "7.5.2", reason: "ReDoS (CVE-2022-25883)" },
  { name: "word-wrap", below: "1.2.4", reason: "ReDoS (CVE-2023-26115)" },
  { name: "tough-cookie", below: "4.1.3", reason: "Prototype pollution (CVE-2023-26136)" },
  { name: "jsonwebtoken", below: "9.0.0", reason: "Algorithm confusion (CVE-2022-23529)" },
  { name: "vm2", below: "3.9.19", reason: "Sandbox escape (multiple CVEs)" },
];

// ── Content rules ────────────────────────────────────────────────────────────

type ContentRule = {
  id: string;
  pattern: RegExp;
  skipInTests?: boolean;
};

const CONTENT_RULES: ContentRule[] = [
  { id: "ts-any", pattern: /(?<![a-zA-Z])any(?![a-zA-Z0-9_])\s*[;,)}\]]|:\s*any\b/, skipInTests: false },
  { id: "ts-ignore", pattern: /@ts-ignore|@ts-expect-error/ },
  { id: "todo-fixme", pattern: /\b(TODO|FIXME|HACK|XXX)\b/ },
  { id: "empty-catch", pattern: /catch\s*\([^)]*\)\s*\{\s*\}/ },
  { id: "console-log", pattern: /\bconsole\.(log|debug|info)\(/, skipInTests: true },
  { id: "debugger", pattern: /\bdebugger\b/, skipInTests: true },
  { id: "eval", pattern: /\beval\s*\(/ },
  { id: "sql-template", pattern: /`[^`]*\$\{[^}]+\}[^`]*(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE)/i },
  { id: "hardcoded-secret", pattern: /(?:password|passwd|api[_-]?key|secret|token|auth)\s*=\s*['"][^'"]{6,}['"]/i },
  { id: "swallowed-promise", pattern: /\.catch\s*\(\s*(?:\(\)\s*=>|function\s*\(\))\s*\{\s*\}\s*\)/ },
  { id: "destructive-migration", pattern: /\b(?:DROP\s+TABLE|TRUNCATE\s+TABLE|DROP\s+DATABASE)\b/i },
  { id: "no-return-type", pattern: /(?:export\s+)?(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*\{/ },
];

const SECRET_FILE_PATTERNS = [
  /^\.env$/, /\.pem$/, /\.p12$/, /\.pfx$/, /\.key$/,
  /id_rsa$/, /id_dsa$/, /id_ecdsa$/, /id_ed25519$/,
  /credentials\.json$/, /serviceaccount\.json$/,
];

// ── Version comparison (semver subset) ───────────────────────────────────────

function semverLt(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^[^0-9]*/, "").split(".").map(Number);
  const [a1 = 0, a2 = 0, a3 = 0] = parse(a);
  const [b1 = 0, b2 = 0, b3 = 0] = parse(b);
  if (a1 !== b1) return a1 < b1;
  if (a2 !== b2) return a2 < b2;
  return a3 < b3;
}

// ── Package.json scanner ─────────────────────────────────────────────────────

function scanPackageJson(repo: LocalRepo): PackageJsonSignals | null {
  const src = readLocalFile(repo, "package.json");
  if (!src) return null;

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(src) as Record<string, unknown>;
  } catch {
    return null;
  }

  const scripts = (pkg["scripts"] as Record<string, string> | undefined) ?? {};
  const deps = (pkg["dependencies"] as Record<string, string> | undefined) ?? {};
  const devDeps = (pkg["devDependencies"] as Record<string, string> | undefined) ?? {};
  const allDeps = { ...deps, ...devDeps };
  const depNames = Object.keys(deps);
  const allDepNames = Object.keys(allDeps);

  const frameworks: string[] = [];
  for (const [fw, pkgNames] of Object.entries(KNOWN_FRAMEWORKS)) {
    if (pkgNames.some((p) => p in allDeps)) frameworks.push(fw);
  }

  const riskySpecifiers: string[] = [];
  for (const [name, spec] of Object.entries(allDeps)) {
    if (typeof spec === "string" && /^(?:file:|git\+?http:|https?:|link:)/.test(spec)) {
      riskySpecifiers.push(`${name}@${spec}`);
    }
    if (spec === "*" || spec === "x") {
      riskySpecifiers.push(`${name}@*`);
    }
  }

  const scriptVals = Object.values(scripts);
  const has = (kw: string) => allDepNames.some((d) => d.includes(kw)) || scriptVals.some((s) => s.includes(kw));

  return {
    name: typeof pkg["name"] === "string" ? pkg["name"] : null,
    version: typeof pkg["version"] === "string" ? pkg["version"] : null,
    has_test_script: "test" in scripts || has("jest") || has("vitest") || has("mocha"),
    has_lint_script: "lint" in scripts || has("eslint") || has("biome"),
    has_typecheck_script: "typecheck" in scripts || "type-check" in scripts || has("tsc"),
    has_build_script: "build" in scripts,
    has_start_script: "start" in scripts || "dev" in scripts,
    dep_count: depNames.length,
    dev_dep_count: Object.keys(devDeps).length,
    dep_names: allDepNames,
    risky_dep_specifiers: riskySpecifiers,
    frameworks,
  };
}

// ── Route scanner ─────────────────────────────────────────────────────────────

const ROUTE_PATTERNS = [
  // Express / Koa
  { re: /(?:app|router)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi, type: "express" },
  // NestJS decorators
  { re: /@(Get|Post|Put|Patch|Delete|All)\s*\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)?/g, type: "nest" },
  // Fastify
  { re: /fastify\.(get|post|put|patch|delete|route)\s*\(\s*(?:\{[^}]*url\s*:\s*['"`]([^'"`]+)['"`]|['"`]([^'"`]+)['"`])/gi, type: "fastify" },
];

const AUTH_MIDDLEWARES = /\b(?:auth|authenticate|verify|jwt|bearer|passport|guard|protect|require(?:Auth|Login)|isAuthorized|checkToken)\b/i;

function scanRoutes(repo: LocalRepo): RouteSignals | null {
  const routes: RouteSignals["routes"] = [];
  const sourceExts = new Set(["ts", "tsx", "js", "jsx", "mjs"]);

  for (const f of repo.files) {
    const ext = f.split(".").pop()?.toLowerCase() ?? "";
    if (!sourceExts.has(ext)) continue;
    if (TEST_PATTERNS.some((p) => p.test(f))) continue;

    const src = readLocalFile(repo, f, 256 * 1024);
    if (!src) continue;

    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const { re } of ROUTE_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          const method = (m[1] ?? "ALL").toUpperCase();
          const routePath = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? "/";
          // Check nearby lines for auth middleware
          const context = lines.slice(Math.max(0, i - 3), i + 10).join("\n");
          const has_auth = AUTH_MIDDLEWARES.test(context);
          routes.push({ method, path: routePath, file: f, line: i + 1, has_auth });
        }
      }
    }
  }

  if (routes.length === 0) return null;
  return {
    total: routes.length,
    without_auth: routes.filter((r) => !r.has_auth).length,
    routes,
  };
}

// ── Content scanner ──────────────────────────────────────────────────────────

function scanContent(repo: LocalRepo): ContentSignals | null {
  const byRule: Record<string, number> = {};
  const secretHits: ContentSignals["secret_hits"] = [];
  const scanExts = new Set(["ts", "tsx", "js", "jsx", "mjs", "py", "go", "rb", "php", "java"]);

  let scannedCount = 0;
  for (const f of repo.files) {
    const ext = f.split(".").pop()?.toLowerCase() ?? "";
    if (!scanExts.has(ext)) continue;
    const src = readLocalFile(repo, f, 256 * 1024);
    if (!src) continue;

    scannedCount++;
    const isTest = TEST_PATTERNS.some((p) => p.test(f));
    const lines = src.split("\n");

    for (const rule of CONTENT_RULES) {
      if (rule.skipInTests && isTest) continue;
      let count = 0;
      for (const line of lines) {
        if (rule.pattern.test(line)) count++;
      }
      if (count > 0) {
        byRule[rule.id] = (byRule[rule.id] ?? 0) + count;
      }
    }

    // Secret detection — report file+line for each hit
    lines.forEach((line, idx) => {
      if (/(?:password|passwd|api[_-]?key|secret|token|auth)\s*=\s*['"][^'"]{8,}['"]/.test(line) && !isTest) {
        secretHits.push({
          file: f,
          line: idx + 1,
          rule: "hardcoded-secret",
          snippet: line.trim().slice(0, 80),
        });
      }
    });
  }

  if (scannedCount === 0) return null;
  return { totals: { by_rule: byRule }, secret_hits: secretHits.slice(0, 20) };
}

// ── Dependency risk scanner ──────────────────────────────────────────────────

function scanDeps(repo: LocalRepo, pkg: PackageJsonSignals | null): DepSignals | null {
  if (!pkg) return null;

  // Read lockfile for installed versions
  const lockSrc = readLocalFile(repo, "package-lock.json", 4 * 1024 * 1024)
    ?? readLocalFile(repo, "yarn.lock", 4 * 1024 * 1024);

  const vulnerable: DepSignals["vulnerable"] = [];
  const outdated: string[] = [];

  for (const { name, below, reason } of KNOWN_VULNERABLE) {
    if (!pkg.dep_names.includes(name)) continue;
    // Try to extract installed version from lockfile
    if (lockSrc) {
      const vMatch = lockSrc.match(new RegExp(`"${name}"\\s*:\\s*\\{[^}]*"version"\\s*:\\s*"([^"]+)"`, "m"))
        ?? lockSrc.match(new RegExp(`${name}@([\\d.]+)`));
      if (vMatch?.[1] && semverLt(vMatch[1], below)) {
        vulnerable.push({ name, installed: vMatch[1], reason });
      }
    } else {
      // No lockfile — flag as potentially vulnerable
      outdated.push(name);
    }
  }

  return { vulnerable, outdated_hints: outdated };
}

// ── ENV scanner ───────────────────────────────────────────────────────────────

function scanEnv(repo: LocalRepo): { used: number; undocumented: number } {
  const envExampleSrc = readLocalFile(repo, ".env.example")
    ?? readLocalFile(repo, ".env.template")
    ?? readLocalFile(repo, ".env.sample");

  const documentedVars = new Set<string>();
  if (envExampleSrc) {
    for (const line of envExampleSrc.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
      if (m?.[1]) documentedVars.add(m[1]);
    }
  }

  const usedVars = new Set<string>();
  const sourceExts = new Set(["ts", "tsx", "js", "jsx", "py", "go", "rb", "java"]);

  for (const f of repo.files) {
    const ext = f.split(".").pop()?.toLowerCase() ?? "";
    if (!sourceExts.has(ext)) continue;
    const src = readLocalFile(repo, f, 256 * 1024);
    if (!src) continue;

    const re = /process\.env\.([A-Z_][A-Z0-9_]*)|os\.environ(?:\.get)?\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]|os\.Getenv\s*\(\s*"([A-Z_][A-Z0-9_]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const varName = m[1] ?? m[2] ?? m[3];
      if (varName) usedVars.add(varName);
    }
  }

  const undocumented = envExampleSrc
    ? [...usedVars].filter((v) => !documentedVars.has(v)).length
    : usedVars.size;

  return { used: usedVars.size, undocumented };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export function runScanners(repo: LocalRepo, projectName: string): CliSignals {
  const t0 = Date.now();

  // ── File census ────────────────────────────────────────────────────────────
  let sourceFiles = 0, testFiles = 0, docFiles = 0, configFiles = 0;
  const extCounts: Record<string, number> = {};
  const largePaths: string[] = [];
  let deeplyNested = 0;

  for (const f of repo.files) {
    const ext = f.split(".").pop()?.toLowerCase() ?? "";
    extCounts[ext] = (extCounts[ext] ?? 0) + 1;

    const segments = f.split("/");
    if (segments.length > 6) deeplyNested++;

    const isTest = TEST_PATTERNS.some((p) => p.test(f));
    if (isTest) {
      testFiles++;
    } else if (SOURCE_EXTS.has(ext)) {
      sourceFiles++;
    } else if (DOC_EXTS.has(ext)) {
      docFiles++;
    } else if (CONFIG_EXTS.has(ext)) {
      configFiles++;
    }

    // Check file size heuristic via segment count (we can't easily get byte size per file here)
    if (f.length > 120) largePaths.push(f);
  }

  // ── Language breakdown ─────────────────────────────────────────────────────
  const langMap: Record<string, string[]> = {
    TypeScript: ["ts", "tsx"],
    JavaScript: ["js", "jsx", "mjs", "cjs"],
    Python: ["py"],
    Go: ["go"],
    Rust: ["rs"],
    Java: ["java"],
    "C#": ["cs"],
    PHP: ["php"],
    Ruby: ["rb"],
    Swift: ["swift"],
    Kotlin: ["kt"],
  };
  const languages: Record<string, number> = {};
  for (const [lang, exts] of Object.entries(langMap)) {
    const count = exts.reduce((s, e) => s + (extCounts[e] ?? 0), 0);
    if (count > 0) languages[lang] = count;
  }

  // ── Tooling presence ───────────────────────────────────────────────────────
  const fileSet = new Set(repo.files.map((f) => f.toLowerCase()));
  const hasFile = (...names: string[]) => names.some((n) => fileSet.has(n.toLowerCase()) || repo.files.some((f) => f.toLowerCase().endsWith("/" + n.toLowerCase())));
  const hasDir = (d: string) => repo.files.some((f) => f.toLowerCase().startsWith(d.toLowerCase() + "/"));

  const has_ci_gitlab = hasFile(".gitlab-ci.yml");
  const has_ci_github = hasDir(".github/workflows") || repo.files.some((f) => f.startsWith(".github/workflows/"));
  const has_ci_other = hasFile("Jenkinsfile", ".circleci/config.yml", "azure-pipelines.yml", ".travis.yml");
  const has_dockerfile = hasFile("Dockerfile");
  const has_compose = hasFile("docker-compose.yml", "docker-compose.yaml", "compose.yml");
  const has_eslint_config = hasFile(".eslintrc", ".eslintrc.js", ".eslintrc.json", ".eslintrc.yaml", "eslint.config.js", "eslint.config.mjs", "eslint.config.ts");
  const has_prettier_config = hasFile(".prettierrc", ".prettierrc.json", ".prettierrc.js", "prettier.config.js");
  const has_husky = hasDir(".husky");
  const has_pre_commit = hasFile(".pre-commit-config.yaml");
  const has_editorconfig = hasFile(".editorconfig");
  const has_typescript_config = hasFile("tsconfig.json");
  const has_python_typecheck = hasFile("mypy.ini", ".mypy.ini", "pyproject.toml") && repo.files.some((f) => f.endsWith(".py"));
  const has_dependabot = repo.files.some((f) => f.includes(".github/dependabot"));
  const has_renovate = hasFile("renovate.json", ".renovaterc", ".renovaterc.json");
  const has_security_md = hasFile("SECURITY.md", "SECURITY.txt");
  const has_readme = hasFile("README.md", "README.txt", "README.rst", "README");
  const has_contributing = hasFile("CONTRIBUTING.md", "CONTRIBUTING.txt");
  const has_license = hasFile("LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE");
  const has_changelog = hasFile("CHANGELOG.md", "CHANGELOG.txt", "HISTORY.md");
  const has_docs_dir = hasDir("docs") || hasDir("documentation");
  const has_lockfile = hasFile("package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "Pipfile.lock", "poetry.lock", "go.sum", "Cargo.lock");
  const has_gitignore = hasFile(".gitignore");
  const has_env_example = hasFile(".env.example", ".env.template", ".env.sample");

  const has_secret_files: string[] = repo.files.filter((f) =>
    SECRET_FILE_PATTERNS.some((p) => p.test(f))
  );

  const has_clean_layout = hasDir("src") || hasDir("lib") || hasDir("app") || hasDir("packages") || hasDir("services") || hasDir("modules");

  // ── tsconfig signals ───────────────────────────────────────────────────────
  let tsconfig_strict = false;
  let tsconfig_no_unchecked = false;
  if (has_typescript_config) {
    const tsrcSrc = readLocalFile(repo, "tsconfig.json");
    if (tsrcSrc) {
      tsconfig_strict = /"strict"\s*:\s*true/.test(tsrcSrc);
      tsconfig_no_unchecked = /"noUncheckedIndexedAccess"\s*:\s*true/.test(tsrcSrc);
    }
  }

  // ── Deep scans ─────────────────────────────────────────────────────────────
  const package_json = scanPackageJson(repo);
  const content = scanContent(repo);
  const routes = scanRoutes(repo);
  const deps = scanDeps(repo, package_json);
  const { used: env_vars_used, undocumented: env_vars_undocumented } = scanEnv(repo);

  const frameworks = [
    ...(package_json?.frameworks ?? []),
    ...Object.keys(languages),
  ].filter((v, i, a) => a.indexOf(v) === i);

  return {
    project_name: projectName,
    scanned_at: t0,
    scan_duration_ms: Date.now() - t0,
    root_dir: repo.rootDir,

    total_files: repo.files.length,
    source_files: sourceFiles,
    test_files: testFiles,
    doc_files: docFiles,
    config_files: configFiles,
    ext_counts: extCounts,
    large_paths: largePaths.slice(0, 20),
    deeply_nested: deeplyNested,
    test_to_source_ratio: sourceFiles > 0 ? testFiles / sourceFiles : 0,

    has_ci_gitlab,
    has_ci_github,
    has_ci_other,
    has_dockerfile,
    has_compose,
    has_eslint_config,
    has_prettier_config,
    has_pre_commit,
    has_husky,
    has_editorconfig,
    has_typescript_config,
    has_python_typecheck,
    has_dependabot,
    has_renovate,
    has_security_md,
    has_readme,
    has_contributing,
    has_license,
    has_changelog,
    has_docs_dir,
    has_lockfile,
    has_gitignore,
    has_env_example,
    has_secret_files,
    has_clean_layout,

    package_json,
    tsconfig_strict,
    tsconfig_no_unchecked,

    languages,
    frameworks,
    content,
    routes,
    deps,
    env_vars_used,
    env_vars_undocumented,
  };
}
