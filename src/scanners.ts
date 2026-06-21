/**
 * Scanner implementations for local CLI scanning
 * Mirrors mr-analyzer's scanner output format
 */

import fs from "node:fs";
import path from "node:path";
import type { LocalRepo } from "./types";
import type {
  CliSignals,
  PackageJsonSignals,
  ContentSignals,
  RouteSignals,
  DepSignals,
} from "./types";

export function runScanners(repo: LocalRepo, projectName: string): CliSignals & {
  project_path: string;
  default_branch: string | null;
  commit_sha: string | null;
  ref: string | null;
} {
  const startTime = Date.now();

  // ── Analyze file structure ──────────────────────────────────────────
  const fileStats = analyzeFiles(repo.files);

  // ── Detect frameworks and languages ─────────────────────────────────
  const languages = detectLanguages(repo.files);
  const frameworks = detectFrameworks(repo.rootDir, repo.files);

  // ── Check for common files ──────────────────────────────────────────
  const hasFiles = (patterns: string[]) =>
    repo.files.some((f) => patterns.some((p) => f.includes(p)));

  const packageJson = parsePackageJson(repo.rootDir);

  return {
    project_name: projectName,
    project_path: repo.rootDir,
    scanned_at: Date.now(),
    scan_duration_ms: Date.now() - startTime,
    root_dir: repo.rootDir,

    total_files: repo.files.length,
    source_files: fileStats.sourceFiles,
    test_files: fileStats.testFiles,
    doc_files: fileStats.docFiles,
    config_files: fileStats.configFiles,
    ext_counts: fileStats.extCounts,
    large_paths: fileStats.largePaths,
    deeply_nested: fileStats.deeplyNested,
    test_to_source_ratio:
      fileStats.sourceFiles > 0
        ? fileStats.testFiles / fileStats.sourceFiles
        : 0,

    has_ci_gitlab: hasFiles([".gitlab-ci.yml", ".gitlab/ci/"]),
    has_ci_github: hasFiles([".github/workflows/"]),
    has_ci_other: hasFiles([".circleci", ".travis.yml", "Jenkinsfile"]),
    has_dockerfile: hasFiles(["Dockerfile"]),
    has_compose: hasFiles(["docker-compose.yml", "docker-compose.yaml"]),
    has_eslint_config: hasFiles([".eslintrc", "eslint.config"]),
    has_prettier_config: hasFiles([".prettierrc", "prettier.config"]),
    has_pre_commit: hasFiles([".pre-commit-config.yaml"]),
    has_husky: hasFiles([".husky"]),
    has_editorconfig: hasFiles([".editorconfig"]),
    has_typescript_config: hasFiles(["tsconfig.json"]),
    has_python_typecheck: hasFiles(["pyproject.toml", "setup.cfg"]),
    has_dependabot: hasFiles([".dependabot"]),
    has_renovate: hasFiles(["renovate.json"]),
    has_security_md: hasFiles(["SECURITY.md", "SECURITY.txt"]),
    has_readme: hasFiles(["README.md", "README.txt", "README"]),
    has_contributing: hasFiles(["CONTRIBUTING.md"]),
    has_license: hasFiles(["LICENSE", "LICENCE"]),
    has_changelog: hasFiles(["CHANGELOG.md", "HISTORY.md"]),
    has_docs_dir: hasFiles(["docs/", "doc/"]),
    has_lockfile: hasFiles(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]),
    has_gitignore: hasFiles([".gitignore"]),
    has_env_example: hasFiles([".env.example", ".env.sample"]),
    has_secret_files: repo.files.filter((f) =>
      /\.(pem|key|secret|credentials)$/i.test(f)
    ),
    has_clean_layout: fileStats.configFiles > 0 && fileStats.sourceFiles > 0,

    package_json: packageJson,
    tsconfig_strict: checkTsConfigStrict(repo.rootDir),
    tsconfig_no_unchecked: checkTsConfigNoUnchecked(repo.rootDir),

    languages,
    frameworks,

    content: scanContent(repo.files),
    routes: scanRoutes(repo.files),
    deps: scanDeps(repo.rootDir),

    env_vars_used: 0,
    env_vars_undocumented: 0,

    default_branch: null,
    commit_sha: null,
    ref: null,
  };
}

function analyzeFiles(files: string[]) {
  const extCounts: Record<string, number> = {};
  let sourceFiles = 0;
  let testFiles = 0;
  let docFiles = 0;
  let configFiles = 0;
  let deeplyNestedCount = 0;
  const largePaths: string[] = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    extCounts[ext] = (extCounts[ext] || 0) + 1;

    const depth = file.split(path.sep).length;
    if (depth > 10) deeplyNestedCount = deeplyNestedCount + 1;

    const relativePath = file;
    if (/\.(test|spec)\.(ts|tsx|js|jsx|py)$/.test(relativePath)) {
      testFiles++;
    } else if (
      /\.(ts|tsx|js|jsx|py|go|rs|java|cpp|c)$/.test(relativePath) &&
      !relativePath.includes("node_modules") &&
      !relativePath.includes("dist") &&
      !relativePath.includes("build")
    ) {
      sourceFiles++;
    } else if (/\.(md|rst|txt)$/.test(relativePath)) {
      docFiles++;
    } else if (/\.(json|yaml|yml|toml|cfg|ini|xml)$/.test(relativePath)) {
      configFiles++;
    }

    if (file.length > 200) {
      largePaths.push(file);
    }
  }

  return {
    sourceFiles,
    testFiles,
    docFiles,
    configFiles,
    extCounts,
    largePaths: largePaths.slice(0, 20),
    deeplyNested: deeplyNestedCount,
  };
}

function detectLanguages(fileList: string[]): Record<string, number> {
  const langs: Record<string, number> = {};
  const langMap: Record<string, string> = {
    ".ts": "TypeScript",
    ".tsx": "TSX",
    ".js": "JavaScript",
    ".jsx": "JSX",
    ".py": "Python",
    ".go": "Go",
    ".rs": "Rust",
    ".java": "Java",
    ".cpp": "C++",
    ".c": "C",
    ".rb": "Ruby",
    ".php": "PHP",
  };

  for (const file of fileList) {
    const ext = path.extname(file).toLowerCase();
    const lang = langMap[ext];
    if (lang) {
      langs[lang] = (langs[lang] || 0) + 1;
    }
  }

  return langs;
}

function detectFrameworks(rootDir: string, _files: string[]): string[] {
  const frameworks: Set<string> = new Set();

  try {
    const pkgJsonPath = path.join(rootDir, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      const content = fs.readFileSync(pkgJsonPath, "utf-8");
      const pkg = JSON.parse(content);
      const deps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };

      if (deps.react) frameworks.add("React");
      if (deps.vue) frameworks.add("Vue");
      if (deps.angular) frameworks.add("Angular");
      if (deps.express) frameworks.add("Express");
      if (deps.fastapi) frameworks.add("FastAPI");
      if (deps.django) frameworks.add("Django");
      if (deps.next) frameworks.add("Next.js");
    }
  } catch {
    /**/
  }

  return Array.from(frameworks);
}

function parsePackageJson(rootDir: string): PackageJsonSignals | null {
  try {
    const pkgJsonPath = path.join(rootDir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) return null;

    const content = fs.readFileSync(pkgJsonPath, "utf-8");
    const pkg = JSON.parse(content);

    const scripts = pkg.scripts || {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const depNames = Object.keys(deps);

    return {
      name: pkg.name || null,
      version: pkg.version || null,
      has_test_script: !!scripts.test,
      has_lint_script: !!scripts.lint || !!scripts.eslint,
      has_typecheck_script: !!scripts.typecheck || !!scripts.tsc,
      has_build_script: !!scripts.build,
      has_start_script: !!scripts.start || !!scripts.dev,
      dep_count: Object.keys(pkg.dependencies || {}).length,
      dev_dep_count: Object.keys(pkg.devDependencies || {}).length,
      dep_names: depNames,
      risky_dep_specifiers: depNames.filter((d) => deps[d].includes("*")),
      frameworks: [],
    };
  } catch {
    return null;
  }
}

function checkTsConfigStrict(rootDir: string): boolean {
  try {
    const tsconfigPath = path.join(rootDir, "tsconfig.json");
    if (!fs.existsSync(tsconfigPath)) return false;

    const content = fs.readFileSync(tsconfigPath, "utf-8");
    const tsconfig = JSON.parse(content);
    return tsconfig.compilerOptions?.strict === true;
  } catch {
    return false;
  }
}

function checkTsConfigNoUnchecked(rootDir: string): boolean {
  try {
    const tsconfigPath = path.join(rootDir, "tsconfig.json");
    if (!fs.existsSync(tsconfigPath)) return false;

    const content = fs.readFileSync(tsconfigPath, "utf-8");
    const tsconfig = JSON.parse(content);
    return tsconfig.compilerOptions?.noUncheckedIndexedAccess === true;
  } catch {
    return false;
  }
}

function scanContent(_files: string[]): ContentSignals | null {
  return {
    totals: { by_rule: {}, critical: 0, warning: 0, suggestion: 0 },
    loc: { total: 0, median: 0, p95: 0, very_long: 0 },
    longest_files: [],
    hits: [],
    files_scanned: 0,
    secret_hits: [],
  };
}

function scanRoutes(_files: string[]): RouteSignals | null {
  return {
    total: 0,
    without_auth: 0,
    routes: [],
  };
}

function scanDeps(rootDir: string): DepSignals | null {
  return {
    vulnerable: [],
    outdated_hints: [],
  };
}
