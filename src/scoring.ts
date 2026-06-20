import type {
  CliSignals,
  DimensionScore,
  FactorContribution,
  RepoGrade,
  RepoScores,
  RepoVerdict,
  ScoringResult,
} from "./types";

const CLAMP = (n: number) => Math.max(0, Math.min(10, n));
const ROUND1 = (n: number) => Math.round(n * 10) / 10;

function apply(base: number, factors: FactorContribution[]): number {
  let val = base;
  for (const f of factors) val += f.delta;
  return ROUND1(CLAMP(val));
}

// ── 1. Code quality ──────────────────────────────────────────────────────────

function scoreCodeQuality(s: CliSignals): DimensionScore {
  const factors: FactorContribution[] = [];
  const base = 6.5;

  if (s.has_eslint_config) factors.push({ label: "ESLint configured", delta: +1.0 });
  if (s.has_prettier_config) factors.push({ label: "Prettier configured", delta: +0.4 });
  if (s.has_editorconfig) factors.push({ label: ".editorconfig present", delta: +0.2 });
  if (s.has_pre_commit || s.has_husky) factors.push({ label: "Pre-commit hooks", delta: +0.6 });

  if (s.has_typescript_config) {
    if (s.tsconfig_strict) {
      factors.push({ label: "TypeScript strict mode", delta: +1.2 });
    } else {
      factors.push({ label: "TypeScript configured", delta: +0.4, evidence: "tsconfig.json found (strict mode not enabled)" });
    }
    if (s.tsconfig_no_unchecked) {
      factors.push({ label: "noUncheckedIndexedAccess enabled", delta: +0.4 });
    }
  }

  if (s.package_json) {
    if (s.package_json.has_lint_script) factors.push({ label: "Lint script in package.json", delta: +0.3 });
    if (s.package_json.has_typecheck_script) factors.push({ label: "Typecheck script in package.json", delta: +0.4 });
    if (s.package_json.has_build_script) factors.push({ label: "Build script in package.json", delta: +0.2 });
    if (s.package_json.risky_dep_specifiers.length > 0) {
      factors.push({
        label: "Risky dependency specifiers",
        delta: -0.6,
        evidence: `${s.package_json.risky_dep_specifiers.length} dep(s) use file:/git:/http: specifiers`,
      });
    }
  }

  if (!s.has_clean_layout) factors.push({ label: "Flat repo layout (no src/, lib/, app/ etc.)", delta: -0.3 });
  if (s.deeply_nested >= 30) factors.push({ label: `${s.deeply_nested} deeply nested paths`, delta: -0.3 });

  if (s.content) {
    const any = s.content.totals.by_rule["ts-any"] ?? 0;
    const ignore = s.content.totals.by_rule["ts-ignore"] ?? 0;
    const todo = s.content.totals.by_rule["todo-fixme"] ?? 0;
    const emptyCatch = s.content.totals.by_rule["empty-catch"] ?? 0;
    const swallowed = s.content.totals.by_rule["swallowed-promise"] ?? 0;
    const destructive = s.content.totals.by_rule["destructive-migration"] ?? 0;
    const evalUsage = s.content.totals.by_rule["eval"] ?? 0;

    if (any >= 30) factors.push({ label: "Heavy use of `any` type", delta: -0.8, evidence: `${any} matches` });
    else if (any >= 10) factors.push({ label: "Frequent `any` usage", delta: -0.3, evidence: `${any} matches` });

    if (ignore >= 10) factors.push({ label: "Many @ts-ignore suppressions", delta: -0.5, evidence: `${ignore} suppressions` });
    else if (ignore > 0) factors.push({ label: "@ts-ignore suppressions present", delta: -0.2, evidence: `${ignore} suppressions` });

    if (todo >= 50) factors.push({ label: "Large TODO/FIXME backlog", delta: -0.4, evidence: `${todo} markers` });

    if (emptyCatch >= 5) factors.push({ label: "Empty catch blocks swallow errors", delta: -0.6, evidence: `${emptyCatch} location(s)` });
    else if (emptyCatch > 0) factors.push({ label: "Empty catch blocks present", delta: -0.2, evidence: `${emptyCatch} location(s)` });

    if (swallowed >= 5) factors.push({ label: "Promise rejections silently swallowed", delta: -0.3, evidence: `${swallowed} match(es)` });
    if (destructive > 0) factors.push({ label: "Destructive migration statements", delta: -0.4, evidence: `${destructive} occurrence(s)` });
    if (evalUsage > 0) factors.push({ label: "`eval()` usage detected", delta: -0.8, evidence: `${evalUsage} call(s)` });
  }

  return { score: apply(base, factors), factors };
}

// ── 2. Security ───────────────────────────────────────────────────────────────

function scoreSecurity(s: CliSignals): DimensionScore {
  const factors: FactorContribution[] = [];
  const base = 6.0;

  if (s.has_gitignore) factors.push({ label: ".gitignore present", delta: +0.5 });
  if (s.has_security_md) factors.push({ label: "SECURITY.md present", delta: +0.5 });
  if (s.has_dependabot || s.has_renovate) factors.push({ label: "Automated dependency updates", delta: +0.5 });
  if (s.has_env_example) factors.push({ label: ".env.example documents required vars", delta: +0.5 });
  if (s.has_lockfile) factors.push({ label: "Lockfile present (reproducible installs)", delta: +0.3 });

  if (s.has_secret_files.length > 0) {
    factors.push({
      label: `Secret files in repo (${s.has_secret_files.length} found)`,
      delta: -2.5,
      evidence: s.has_secret_files.slice(0, 3).join(", "),
    });
  }

  if (s.content) {
    const secrets = s.content.secret_hits.length;
    if (secrets >= 5) {
      factors.push({ label: "Many hardcoded credentials detected", delta: -2.0, evidence: `${secrets} potential secrets` });
    } else if (secrets > 0) {
      factors.push({ label: "Possible hardcoded credentials", delta: -1.0, evidence: `${secrets} potential secret(s)` });
    }

    const sqlInjection = s.content.totals.by_rule["sql-template"] ?? 0;
    if (sqlInjection > 0) {
      factors.push({ label: "SQL string interpolation (injection risk)", delta: -1.2, evidence: `${sqlInjection} occurrence(s)` });
    }

    const evalUsage = s.content.totals.by_rule["eval"] ?? 0;
    if (evalUsage > 0) {
      factors.push({ label: "`eval()` usage is a code injection risk", delta: -1.0, evidence: `${evalUsage} call(s)` });
    }
  }

  if (s.deps?.vulnerable && s.deps.vulnerable.length > 0) {
    factors.push({
      label: `${s.deps.vulnerable.length} vulnerable dependency/ies`,
      delta: -Math.min(3, s.deps.vulnerable.length * 0.8),
      evidence: s.deps.vulnerable.map((v) => `${v.name}@${v.installed}`).slice(0, 3).join(", "),
    });
  }

  if (s.routes && s.routes.without_auth > 0) {
    const ratio = s.routes.without_auth / Math.max(1, s.routes.total);
    if (ratio >= 0.5) {
      factors.push({ label: `${s.routes.without_auth}/${s.routes.total} routes lack auth middleware`, delta: -0.8 });
    } else if (s.routes.without_auth >= 3) {
      factors.push({ label: `${s.routes.without_auth} routes without explicit auth`, delta: -0.4 });
    }
  }

  if (s.env_vars_undocumented > 3) {
    factors.push({ label: `${s.env_vars_undocumented} env vars undocumented in .env.example`, delta: -0.3 });
  }

  return { score: apply(base, factors), factors };
}

// ── 3. Performance ────────────────────────────────────────────────────────────

function scorePerformance(s: CliSignals): DimensionScore {
  const factors: FactorContribution[] = [];
  const base = 6.5;

  if (s.has_ci_gitlab || s.has_ci_github || s.has_ci_other) {
    factors.push({ label: "CI pipeline configured", delta: +0.5 });
  }
  if (s.has_dockerfile) factors.push({ label: "Docker support", delta: +0.3 });
  if (s.has_lockfile) factors.push({ label: "Lockfile (reproducible builds)", delta: +0.3 });
  if (s.has_clean_layout) factors.push({ label: "Structured layout", delta: +0.3 });

  if (s.package_json) {
    const totalDeps = s.package_json.dep_count;
    if (totalDeps > 80) {
      factors.push({ label: `Heavy dependency footprint (${totalDeps} prod deps)`, delta: -1.0, evidence: "Large installs inflate cold-start time" });
    } else if (totalDeps > 40) {
      factors.push({ label: `Large dependency footprint (${totalDeps} prod deps)`, delta: -0.5 });
    } else if (totalDeps <= 20 && totalDeps > 0) {
      factors.push({ label: `Lean dependency count (${totalDeps} prod deps)`, delta: +0.4 });
    }
  }

  if (s.deeply_nested >= 20) {
    factors.push({ label: `${s.deeply_nested} deeply nested files (slow globbing)`, delta: -0.3 });
  }

  if (s.content) {
    const consoleLogs = s.content.totals.by_rule["console-log"] ?? 0;
    if (consoleLogs >= 50) {
      factors.push({ label: `${consoleLogs} console.log calls in production code`, delta: -0.5, evidence: "Excess logging adds I/O overhead" });
    }
  }

  if (s.total_files > 5000) {
    factors.push({ label: `Very large repo (${s.total_files} files)`, delta: -0.3, evidence: "Consider splitting or using a monorepo tool" });
  }

  return { score: apply(base, factors), factors };
}

// ── 4. Test coverage ──────────────────────────────────────────────────────────

function scoreTestCoverage(s: CliSignals): DimensionScore {
  const factors: FactorContribution[] = [];
  const base = 4.5;

  const ratio = s.test_to_source_ratio;
  if (ratio >= 0.8) {
    factors.push({ label: `High test/source ratio (${(ratio * 100).toFixed(0)}%)`, delta: +3.0 });
  } else if (ratio >= 0.5) {
    factors.push({ label: `Good test coverage ratio (${(ratio * 100).toFixed(0)}%)`, delta: +2.0 });
  } else if (ratio >= 0.25) {
    factors.push({ label: `Moderate test coverage ratio (${(ratio * 100).toFixed(0)}%)`, delta: +1.0 });
  } else if (ratio >= 0.1) {
    factors.push({ label: `Low test coverage ratio (${(ratio * 100).toFixed(0)}%)`, delta: +0.2 });
  } else if (s.test_files === 0) {
    factors.push({ label: "No test files detected", delta: -2.0 });
  }

  if (s.package_json?.has_test_script) {
    factors.push({ label: "Test script in package.json", delta: +0.5 });
  }

  if (s.has_ci_gitlab || s.has_ci_github) {
    factors.push({ label: "CI present (tests likely run on push)", delta: +0.5 });
  }

  if (s.routes && s.routes.total > 0) {
    const coveredRoutes = s.routes.total - s.routes.without_auth;
    const covRatio = coveredRoutes / s.routes.total;
    if (covRatio < 0.5) {
      factors.push({ label: `${s.routes.without_auth}/${s.routes.total} API routes lack explicit guards`, delta: -0.3 });
    }
  }

  return { score: apply(base, factors), factors };
}

// ── 5. Readability ────────────────────────────────────────────────────────────

function scoreReadability(s: CliSignals): DimensionScore {
  const factors: FactorContribution[] = [];
  const base = 6.0;

  if (s.has_readme) factors.push({ label: "README present", delta: +0.5 });
  if (s.has_contributing) factors.push({ label: "CONTRIBUTING.md present", delta: +0.5 });
  if (s.has_changelog) factors.push({ label: "CHANGELOG present", delta: +0.3 });
  if (s.has_docs_dir) factors.push({ label: "docs/ directory present", delta: +0.5 });
  if (s.has_editorconfig) factors.push({ label: ".editorconfig enforces style", delta: +0.3 });
  if (s.has_prettier_config) factors.push({ label: "Prettier enforces formatting", delta: +0.4 });
  if (s.has_clean_layout) factors.push({ label: "Structured directory layout", delta: +0.4 });
  if (s.has_license) factors.push({ label: "LICENSE file present", delta: +0.2 });

  if (s.content) {
    const todo = s.content.totals.by_rule["todo-fixme"] ?? 0;
    if (todo >= 30) {
      factors.push({ label: `Large stale-comment backlog (${todo} TODO/FIXME)`, delta: -0.5 });
    }
  }

  if (!s.has_readme) factors.push({ label: "No README — project is undiscoverable", delta: -0.8 });
  if (s.doc_files === 0) factors.push({ label: "No documentation files", delta: -0.3 });

  return { score: apply(base, factors), factors };
}

// ── Final score rollup ────────────────────────────────────────────────────────

export function computeScores(signals: CliSignals): ScoringResult {
  const scores: RepoScores = {
    code_quality: scoreCodeQuality(signals),
    security: scoreSecurity(signals),
    performance: scorePerformance(signals),
    test_coverage: scoreTestCoverage(signals),
    readability: scoreReadability(signals),
  };

  const dims = Object.values(scores);
  const avg_dim = ROUND1(dims.reduce((s, d) => s + d.score, 0) / dims.length);

  // Health = avg * 10, capped at 100, with critical deductions
  let health_score = Math.round(avg_dim * 10);
  if (signals.has_secret_files.length > 0) health_score = Math.max(0, health_score - 10);
  if ((signals.content?.secret_hits.length ?? 0) >= 5) health_score = Math.max(0, health_score - 5);
  health_score = Math.min(100, health_score);

  const grade: RepoGrade =
    health_score >= 85 ? "A"
    : health_score >= 70 ? "B"
    : health_score >= 55 ? "C"
    : health_score >= 40 ? "D"
    : "F";

  const verdict: RepoVerdict =
    health_score >= 70 ? "healthy"
    : health_score >= 45 ? "needs_attention"
    : "at_risk";

  const worst_dimension = (Object.entries(scores) as [keyof RepoScores, DimensionScore][])
    .sort((a, b) => a[1].score - b[1].score)[0]?.[0] ?? "test_coverage";

  return { scores, avg_dim, health_score, grade, verdict, worst_dimension };
}
