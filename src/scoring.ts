/**
 * Scoring algorithm for CLI scanners
 * Computes dimension scores and health grade based on signals
 */

import type { CliSignals, ScoringResult, DimensionScore, RepoGrade, RepoVerdict } from "./types";

type ProjectAttribute = {
  category: string;
  scanner: string;
  attribute_key: string;
  attribute_label: string;
  attribute_value: number;
  delta_to_score: number;
  evidence: string | null;
};

export function computeScores(signals: CliSignals & any): ScoringResult {
  const dimensions = {
    code_quality: computeCodeQuality(signals),
    security: computeSecurity(signals),
    performance: computePerformance(signals),
    test_coverage: computeTestCoverage(signals),
    readability: computeReadability(signals),
  };

  const avgDim =
    (dimensions.code_quality.score +
      dimensions.security.score +
      dimensions.performance.score +
      dimensions.test_coverage.score +
      dimensions.readability.score) /
    5;

  const healthScore = Math.round(avgDim * 10);
  const grade = scoreToGrade(avgDim);
  const verdict = scoreToVerdict(avgDim);

  const entries = Object.entries(dimensions).sort(
    ([, a], [, b]) => a.score - b.score
  );

  const attributes = generateAttributes(signals);

  return {
    scores: dimensions,
    avg_dim: avgDim,
    health_score: healthScore,
    grade,
    verdict,
    worst_dimension: (entries[0]?.[0] || 'code_quality') as keyof typeof dimensions,
    factor_breakdown: dimensions,
    warnings: [],
    attributes,
  } as any;
}

function computeCodeQuality(signals: CliSignals): DimensionScore {
  let score = 7.0;
  const factors: Array<{ label: string; delta: number; evidence?: string }> = [];

  // Config quality
  if (!signals.has_eslint_config && !signals.has_prettier_config) {
    score -= 0.5;
    factors.push({ label: "Missing linter/formatter config", delta: -0.5 });
  }

  // TypeScript strictness
  if (signals.has_typescript_config && !signals.tsconfig_strict) {
    score -= 0.3;
    factors.push({ label: "TypeScript not in strict mode", delta: -0.3 });
  }

  // Clean layout
  if (!signals.has_clean_layout) {
    score -= 0.4;
    factors.push({ label: "Unclean directory layout", delta: -0.4 });
  }

  // Build/tooling
  if (signals.package_json?.has_build_script) {
    score += 0.3;
    factors.push({ label: "Build script present", delta: 0.3 });
  }

  return {
    score: Math.max(0, Math.min(10, score)),
    factors,
  };
}

function computeSecurity(signals: CliSignals): DimensionScore {
  let score = 7.0;
  const factors: Array<{ label: string; delta: number; evidence?: string }> = [];

  // Secret files
  if (signals.has_secret_files.length > 0) {
    score -= 1.5;
    factors.push({
      label: `Secret files in repo (${signals.has_secret_files.length})`,
      delta: -1.5,
    });
  }

  // Dependency management
  if (signals.has_lockfile) {
    score += 0.5;
    factors.push({ label: "Lockfile present", delta: 0.5 });
  }

  if (signals.has_dependabot) {
    score += 0.3;
    factors.push({ label: "Dependabot enabled", delta: 0.3 });
  }

  // Env variables
  if (signals.has_env_example) {
    score += 0.2;
    factors.push({ label: ".env.example present", delta: 0.2 });
  }

  return {
    score: Math.max(0, Math.min(10, score)),
    factors,
  };
}

function computePerformance(signals: CliSignals): DimensionScore {
  let score = 6.5;
  const factors: Array<{ label: string; delta: number; evidence?: string }> = [];

  // File structure
  if (signals.deeply_nested > 10) {
    score -= 0.3;
    factors.push({
      label: `${signals.deeply_nested} deeply nested directories`,
      delta: -0.3,
    });
  }

  // Large paths
  if (signals.large_paths.length > 0) {
    score -= 0.2;
    factors.push({
      label: `${signals.large_paths.length} large file paths`,
      delta: -0.2,
    });
  }

  // Good structure bonus
  if (signals.has_clean_layout && signals.source_files > 0) {
    score += 0.4;
    factors.push({ label: "Clean project layout", delta: 0.4 });
  }

  return {
    score: Math.max(0, Math.min(10, score)),
    factors,
  };
}

function computeTestCoverage(signals: CliSignals): DimensionScore {
  let score = 6.0;
  const factors: Array<{ label: string; delta: number; evidence?: string }> = [];

  // Test files vs source
  const testRatio = signals.test_to_source_ratio || 0;
  if (testRatio > 0.8) {
    score += 2.0;
    factors.push({
      label: `High test coverage (${(testRatio * 100).toFixed(0)}%)`,
      delta: 2.0,
    });
  } else if (testRatio > 0.4) {
    score += 1.0;
    factors.push({
      label: `Moderate test coverage (${(testRatio * 100).toFixed(0)}%)`,
      delta: 1.0,
    });
  } else if (testRatio < 0.1) {
    score -= 1.0;
    factors.push({
      label: `Low test coverage (${(testRatio * 100).toFixed(0)}%)`,
      delta: -1.0,
    });
  }

  // Test script
  if (signals.package_json?.has_test_script) {
    score += 0.5;
    factors.push({ label: "Test script configured", delta: 0.5 });
  }

  return {
    score: Math.max(0, Math.min(10, score)),
    factors,
  };
}

function computeReadability(signals: CliSignals): DimensionScore {
  let score = 7.5;
  const factors: Array<{ label: string; delta: number; evidence?: string }> = [];

  // Documentation
  if (signals.has_readme) {
    score += 0.5;
    factors.push({ label: "README present", delta: 0.5 });
  }

  if (signals.has_docs_dir) {
    score += 0.5;
    factors.push({ label: "Docs directory present", delta: 0.5 });
  }

  if (signals.has_contributing) {
    score += 0.3;
    factors.push({ label: "CONTRIBUTING guide present", delta: 0.3 });
  }

  if (signals.doc_files && signals.doc_files > 0) {
    score += 0.2;
    factors.push({
      label: `${signals.doc_files} documentation files`,
      delta: 0.2,
    });
  }

  // Code style
  if (signals.has_prettier_config) {
    score += 0.3;
    factors.push({ label: "Prettier configured", delta: 0.3 });
  }

  if (signals.has_editorconfig) {
    score += 0.2;
    factors.push({ label: ".editorconfig present", delta: 0.2 });
  }

  return {
    score: Math.max(0, Math.min(10, score)),
    factors,
  };
}

function scoreToGrade(score: number): RepoGrade {
  if (score >= 8.0) return "A";
  if (score >= 6.5) return "B";
  if (score >= 5.0) return "C";
  if (score >= 3.5) return "D";
  return "F";
}

function scoreToVerdict(score: number): RepoVerdict {
  if (score >= 7.0) return "healthy";
  if (score >= 5.0) return "needs_attention";
  return "at_risk";
}

function generateAttributes(signals: CliSignals & any): ProjectAttribute[] {
  const attributes: ProjectAttribute[] = [];

  const scanners = [
    "file-census",
    "framework-detect",
    "typescript-config",
    "linting-config",
    "documentation",
    "ci-detect",
    "dependency-management",
    "env-config",
    "ast-analysis",
    "content-analysis",
    "module-detection",
    "architecture",
    "dependency-scanner",
    "security-scan",
  ];

  // File structure attributes
  if (signals.test_to_source_ratio > 0.8) {
    attributes.push({
      category: "test_coverage",
      scanner: "file-census",
      attribute_key: "high_test_ratio",
      attribute_label: "High test-to-source ratio",
      attribute_value: signals.test_files,
      delta_to_score: 0.5,
      evidence: `${(signals.test_to_source_ratio * 100).toFixed(0)}% test coverage ratio`,
    });
  }

  if (signals.total_files > 500) {
    attributes.push({
      category: "code_quality",
      scanner: "file-census",
      attribute_key: "large_codebase",
      attribute_label: "Large codebase",
      attribute_value: signals.total_files,
      delta_to_score: -0.2,
      evidence: `${signals.total_files} files found`,
    });
  }

  // Framework detection
  if (signals.frameworks && signals.frameworks.length > 0) {
    attributes.push({
      category: "code_quality",
      scanner: "framework-detect",
      attribute_key: "frameworks_detected",
      attribute_label: `Detected frameworks: ${signals.frameworks.slice(0, 3).join(", ")}`,
      attribute_value: signals.frameworks.length,
      delta_to_score: 0.3,
      evidence: signals.frameworks.join(", "),
    });
  }

  // TypeScript strict mode
  if (signals.has_typescript_config && signals.tsconfig_strict) {
    attributes.push({
      category: "code_quality",
      scanner: "typescript-config",
      attribute_key: "strict_mode",
      attribute_label: "TypeScript strict mode enabled",
      attribute_value: 1,
      delta_to_score: 0.4,
      evidence: "strict: true in tsconfig.json",
    });
  }

  // Linting and formatting
  if (signals.has_eslint_config && signals.has_prettier_config) {
    attributes.push({
      category: "readability",
      scanner: "linting-config",
      attribute_key: "lint_and_format",
      attribute_label: "ESLint + Prettier configured",
      attribute_value: 1,
      delta_to_score: 0.3,
      evidence: "Both linter and formatter present",
    });
  }

  // Documentation
  if (signals.has_readme && signals.has_docs_dir) {
    attributes.push({
      category: "readability",
      scanner: "documentation",
      attribute_key: "comprehensive_docs",
      attribute_label: "Comprehensive documentation",
      attribute_value: 1,
      delta_to_score: 0.4,
      evidence: "README and /docs directory present",
    });
  }

  // CI/CD
  if (signals.has_ci_github || signals.has_ci_gitlab) {
    const ciType = signals.has_ci_github ? "GitHub Actions" : "GitLab CI";
    attributes.push({
      category: "code_quality",
      scanner: "ci-detect",
      attribute_key: "ci_configured",
      attribute_label: `CI/CD configured (${ciType})`,
      attribute_value: 1,
      delta_to_score: 0.3,
      evidence: ciType,
    });
  }

  // Security checks
  if (signals.has_dependabot || signals.has_renovate) {
    attributes.push({
      category: "security",
      scanner: "dependency-management",
      attribute_key: "auto_updates",
      attribute_label: "Automated dependency updates",
      attribute_value: 1,
      delta_to_score: 0.2,
      evidence: signals.has_dependabot ? "Dependabot" : "Renovate",
    });
  }

  if (signals.has_env_example) {
    attributes.push({
      category: "security",
      scanner: "env-config",
      attribute_key: "env_example",
      attribute_label: "Environment template file",
      attribute_value: 1,
      delta_to_score: 0.15,
      evidence: ".env.example present",
    });
  }

  // AST metrics
  if (signals.ast && signals.ast.total_functions > 0) {
    attributes.push({
      category: "code_quality",
      scanner: "ast-analysis",
      attribute_key: "code_complexity",
      attribute_label: `${signals.ast.total_functions} functions analyzed`,
      attribute_value: signals.ast.total_functions,
      delta_to_score: signals.ast.god_functions > 5 ? -0.3 : 0.1,
      evidence: `${signals.ast.god_functions} god functions, median complexity ${signals.ast.median_complexity}`,
    });
  }

  // Documentation metrics
  if (signals.docs && signals.docs.total_md_files > 0) {
    attributes.push({
      category: "readability",
      scanner: "documentation",
      attribute_key: "doc_coverage",
      attribute_label: `${signals.docs.total_md_files} markdown files`,
      attribute_value: signals.docs.total_md_files,
      delta_to_score: 0.15,
      evidence: `${Math.round(signals.docs.total_words / 100) * 100} words of documentation`,
    });
  }

  // Content/LOC metrics
  if (signals.content && signals.content.files_scanned > 0) {
    attributes.push({
      category: "performance",
      scanner: "content-analysis",
      attribute_key: "loc_metrics",
      attribute_label: `${signals.content.loc.total.toLocaleString()} lines of code`,
      attribute_value: signals.content.loc.total,
      delta_to_score: signals.content.loc.very_long > 20 ? -0.2 : 0.1,
      evidence: `P95 file: ${signals.content.loc.p95} LOC, ${signals.content.loc.very_long} files > 500 LOC`,
    });
  }

  // Module structure
  if (signals.modules && signals.modules.length > 0) {
    attributes.push({
      category: "code_quality",
      scanner: "module-detection",
      attribute_key: "modular_structure",
      attribute_label: `${signals.modules.length} modules identified`,
      attribute_value: signals.modules.length,
      delta_to_score: 0.2,
      evidence: signals.modules.map((m: any) => m.label).join(", "),
    });
  }

  // Architecture
  if (signals.architecture && signals.architecture.has_doc) {
    attributes.push({
      category: "readability",
      scanner: "architecture",
      attribute_key: "architecture_doc",
      attribute_label: "Architecture documentation present",
      attribute_value: Math.round(signals.architecture.compliance_pct),
      delta_to_score: 0.25,
      evidence: `${signals.architecture.compliance_pct.toFixed(0)}% compliance`,
    });
  }

  // Lockfile detection
  if (signals.vulns && signals.vulns.lockfiles && signals.vulns.lockfiles.length > 0) {
    attributes.push({
      category: "security",
      scanner: "dependency-scanner",
      attribute_key: "lockfiles",
      attribute_label: `${signals.vulns.lockfiles.length} lockfile(s) found`,
      attribute_value: signals.vulns.lockfiles.length,
      delta_to_score: 0.1,
      evidence: signals.vulns.lockfiles.map((l: any) => l.lockfile).join(", "),
    });
  }

  // Generate additional comprehensive attributes
  // Code quality - file analysis
  attributes.push(
    {
      category: "code_quality",
      scanner: "file-census",
      attribute_key: "file_count",
      attribute_label: `Total source files: ${signals.source_files}`,
      attribute_value: signals.source_files,
      delta_to_score: signals.source_files > 300 ? -0.15 : 0.05,
      evidence: `${signals.source_files} source files`,
    },
    {
      category: "test_coverage",
      scanner: "file-census",
      attribute_key: "test_files",
      attribute_label: `Test files present: ${signals.test_files}`,
      attribute_value: signals.test_files,
      delta_to_score: signals.test_files > 50 ? 0.3 : -0.1,
      evidence: `${signals.test_files} test files identified`,
    },
    {
      category: "readability",
      scanner: "documentation",
      attribute_key: "doc_files",
      attribute_label: `Documentation files: ${signals.doc_files}`,
      attribute_value: signals.doc_files,
      delta_to_score: signals.doc_files > 5 ? 0.2 : -0.1,
      evidence: `${signals.doc_files} markdown/doc files`,
    }
  );

  // Security attributes from package.json
  if (signals.package_json) {
    attributes.push(
      {
        category: "security",
        scanner: "dependency-management",
        attribute_key: "dep_count",
        attribute_label: `Dependencies: ${signals.package_json.dep_count}`,
        attribute_value: signals.package_json.dep_count,
        delta_to_score: signals.package_json.dep_count > 100 ? -0.2 : 0.05,
        evidence: `${signals.package_json.dep_count} runtime dependencies`,
      },
      {
        category: "code_quality",
        scanner: "typescript-config",
        attribute_key: "dev_deps",
        attribute_label: `Dev dependencies: ${signals.package_json.dev_dep_count}`,
        attribute_value: signals.package_json.dev_dep_count,
        delta_to_score: signals.package_json.dev_dep_count > 30 ? 0.15 : -0.1,
        evidence: `${signals.package_json.dev_dep_count} dev dependencies`,
      }
    );
  }

  // Performance attributes
  attributes.push(
    {
      category: "performance",
      scanner: "content-analysis",
      attribute_key: "deeply_nested",
      attribute_label: `Deeply nested directories: ${signals.deeply_nested}`,
      attribute_value: signals.deeply_nested,
      delta_to_score: signals.deeply_nested > 10 ? -0.25 : 0.1,
      evidence: `${signals.deeply_nested} directories with nesting > 10 levels`,
    },
    {
      category: "code_quality",
      scanner: "file-census",
      attribute_key: "large_paths",
      attribute_label: `Large file paths detected: ${signals.large_paths.length}`,
      attribute_value: signals.large_paths.length,
      delta_to_score: signals.large_paths.length > 0 ? -0.15 : 0.05,
      evidence: `${signals.large_paths.length} paths with > 200 characters`,
    }
  );

  // CI/CD attributes
  if (!signals.has_ci_github && !signals.has_ci_gitlab && !signals.has_ci_other) {
    attributes.push({
      category: "code_quality",
      scanner: "ci-detect",
      attribute_key: "missing_ci",
      attribute_label: "No CI/CD pipeline detected",
      attribute_value: 0,
      delta_to_score: -0.4,
      evidence: "No GitHub Actions, GitLab CI, or other CI configured",
    });
  }

  // Docker/container attributes
  if (signals.has_dockerfile) {
    attributes.push({
      category: "code_quality",
      scanner: "docker-detect",
      attribute_key: "dockerfile_present",
      attribute_label: "Docker support",
      attribute_value: 1,
      delta_to_score: 0.15,
      evidence: "Dockerfile found",
    });
  }

  // Pre-commit/hooks
  if (signals.has_pre_commit || signals.has_husky) {
    attributes.push({
      category: "code_quality",
      scanner: "git-hooks",
      attribute_key: "pre_commit_hooks",
      attribute_label: `Git hooks configured (${signals.has_husky ? "Husky" : "Pre-commit"})`,
      attribute_value: 1,
      delta_to_score: 0.2,
      evidence: signals.has_husky ? "Husky found" : "Pre-commit config found",
    });
  }

  // License and legal
  if (signals.has_license) {
    attributes.push({
      category: "readability",
      scanner: "legal",
      attribute_key: "license",
      attribute_label: "License file present",
      attribute_value: 1,
      delta_to_score: 0.1,
      evidence: "LICENSE file included",
    });
  }

  if (signals.has_security_md) {
    attributes.push({
      category: "security",
      scanner: "security-policy",
      attribute_key: "security_policy",
      attribute_label: "Security policy documented",
      attribute_value: 1,
      delta_to_score: 0.2,
      evidence: "SECURITY.md file present",
    });
  }

  // Build and test scripts
  if (signals.package_json) {
    if (signals.package_json.has_build_script) {
      attributes.push({
        category: "code_quality",
        scanner: "build-system",
        attribute_key: "build_script",
        attribute_label: "Build script configured",
        attribute_value: 1,
        delta_to_score: 0.2,
        evidence: "build script in package.json",
      });
    }
    if (signals.package_json.has_test_script) {
      attributes.push({
        category: "test_coverage",
        scanner: "test-system",
        attribute_key: "test_script",
        attribute_label: "Test script configured",
        attribute_value: 1,
        delta_to_score: 0.2,
        evidence: "test script in package.json",
      });
    }
    if (signals.package_json.has_lint_script) {
      attributes.push({
        category: "code_quality",
        scanner: "linting-config",
        attribute_key: "lint_script",
        attribute_label: "Linting script configured",
        attribute_value: 1,
        delta_to_score: 0.15,
        evidence: "lint script in package.json",
      });
    }
  }

  // Editor config
  if (signals.has_editorconfig) {
    attributes.push({
      category: "readability",
      scanner: "editor-config",
      attribute_key: "editorconfig",
      attribute_label: "EditorConfig present",
      attribute_value: 1,
      delta_to_score: 0.1,
      evidence: ".editorconfig file found",
    });
  }

  // .gitignore
  if (signals.has_gitignore) {
    attributes.push({
      category: "code_quality",
      scanner: "git-config",
      attribute_key: "gitignore",
      attribute_label: "Git ignore rules configured",
      attribute_value: 1,
      delta_to_score: 0.1,
      evidence: ".gitignore file present",
    });
  }

  // Secret files warning
  if (signals.has_secret_files.length > 0) {
    attributes.push({
      category: "security",
      scanner: "secret-scanner",
      attribute_key: "secret_files",
      attribute_label: `Secret files in repo: ${signals.has_secret_files.length}`,
      attribute_value: signals.has_secret_files.length,
      delta_to_score: -1.0,
      evidence: signals.has_secret_files.join(", "),
    });
  }

  // Changelog
  if (signals.has_changelog) {
    attributes.push({
      category: "readability",
      scanner: "documentation",
      attribute_key: "changelog",
      attribute_label: "Changelog maintained",
      attribute_value: 1,
      delta_to_score: 0.1,
      evidence: "CHANGELOG.md file present",
    });
  }

  // Contributing guide
  if (signals.has_contributing) {
    attributes.push({
      category: "readability",
      scanner: "documentation",
      attribute_key: "contributing_guide",
      attribute_label: "Contributing guide present",
      attribute_value: 1,
      delta_to_score: 0.15,
      evidence: "CONTRIBUTING.md file found",
    });
  }

  return attributes;
}
