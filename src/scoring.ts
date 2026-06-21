/**
 * Scoring algorithm for CLI scanners
 * Computes dimension scores and health grade based on signals
 */

import type { CliSignals, ScoringResult, DimensionScore, RepoGrade, RepoVerdict } from "./types";

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

  return {
    scores: dimensions,
    avg_dim: avgDim,
    health_score: healthScore,
    grade,
    verdict,
    worst_dimension: (entries[0]?.[0] || 'code_quality') as keyof typeof dimensions,
    factor_breakdown: dimensions,
    warnings: [],
    attributes: [],
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
