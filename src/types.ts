// ── Local repo ─────────────────────────────────────────────────────────────

/** Drop-in replacement for ExtractedRepo (archive-walker.ts) for local scans. */
export type LocalRepo = {
  rootDir: string;
  tmpDir: string;
  files: string[];
  totalBytes: number;
};

// ── Config ─────────────────────────────────────────────────────────────────

export type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure?: boolean;
};

export type EmailNotifyConfig = {
  from: string;
  extraRecipients?: string[];
  smtp?: SmtpConfig;
  resend?: { apiKey: string };
};

export type GoogleChatConfig = {
  webhookUrl: string;
};

export type ScanConfig = {
  name: string;
  description?: string;
  gitlab?: {
    baseUrl: string;
    projectId: number;
    token?: string;
  };
  frd?: {
    dir: string;
    pattern?: string;
  };
  notify?: {
    email?: EmailNotifyConfig;
    googleChat?: GoogleChatConfig;
  };
  scan?: {
    exclude?: string[];
    reportDir?: string;
    maxFileSizeBytes?: number;
    failBelow?: number;
  };
};

// ── Scanner signals ─────────────────────────────────────────────────────────

export type PackageJsonSignals = {
  name: string | null;
  version: string | null;
  has_test_script: boolean;
  has_lint_script: boolean;
  has_typecheck_script: boolean;
  has_build_script: boolean;
  has_start_script: boolean;
  dep_count: number;
  dev_dep_count: number;
  dep_names: string[];
  risky_dep_specifiers: string[];
  frameworks: string[];
};

export type ContentSignals = {
  totals: {
    by_rule: Record<string, number>;
    critical?: number;
    warning?: number;
    suggestion?: number;
  };
  loc?: { total: number; median: number; p95: number; very_long: number };
  longest_files?: Array<{ file: string; lines: number }>;
  hits?: Array<{ severity: string; file: string; line: number; title: string; evidence: string }>;
  files_scanned?: number;
  secret_hits: Array<{ file: string; line: number; rule: string; snippet: string }>;
};

export type RouteSignals = {
  total: number;
  without_auth: number;
  routes: Array<{ method: string; path: string; file: string; line: number; has_auth: boolean }>;
};

export type DepSignals = {
  vulnerable: Array<{ name: string; installed: string; reason: string }>;
  outdated_hints: string[];
};

export type CliSignals = {
  // ── Identity ──────────────────────────────────────────────────────────────
  project_name: string;
  scanned_at: number;
  scan_duration_ms: number;
  root_dir: string;

  // ── Tree census ───────────────────────────────────────────────────────────
  total_files: number;
  source_files: number;
  test_files: number;
  doc_files: number;
  config_files: number;
  ext_counts: Record<string, number>;
  large_paths: string[];
  deeply_nested: number;
  test_to_source_ratio: number;

  // ── Tooling presence ──────────────────────────────────────────────────────
  has_ci_gitlab: boolean;
  has_ci_github: boolean;
  has_ci_other: boolean;
  has_dockerfile: boolean;
  has_compose: boolean;
  has_eslint_config: boolean;
  has_prettier_config: boolean;
  has_pre_commit: boolean;
  has_husky: boolean;
  has_editorconfig: boolean;
  has_typescript_config: boolean;
  has_python_typecheck: boolean;
  has_dependabot: boolean;
  has_renovate: boolean;
  has_security_md: boolean;
  has_readme: boolean;
  has_contributing: boolean;
  has_license: boolean;
  has_changelog: boolean;
  has_docs_dir: boolean;
  has_lockfile: boolean;
  has_gitignore: boolean;
  has_env_example: boolean;
  has_secret_files: string[];
  has_clean_layout: boolean;

  // ── Manifest parsing ─────────────────────────────────────────────────────
  package_json: PackageJsonSignals | null;
  tsconfig_strict: boolean;
  tsconfig_no_unchecked: boolean;

  // ── Language breakdown ───────────────────────────────────────────────────
  languages: Record<string, number>;
  frameworks: string[];

  // ── Deep content scan ────────────────────────────────────────────────────
  content: ContentSignals | null;

  // ── Dependency risk ──────────────────────────────────────────────────────
  deps: DepSignals | null;

  // ── ENV signals ──────────────────────────────────────────────────────────
  env_vars_used: number;
  env_vars_undocumented: number;

  // ── Deep scanners ───────────────────────────────────────────────────────────
  vulns?: any;
  ast?: any;
  docs?: any;
  architecture?: any;
  modules?: any;
  db_schema?: any;
  layering?: any;
  test_map?: any;
  routes?: any;
};

// ── Scoring ────────────────────────────────────────────────────────────────

export type FactorContribution = {
  label: string;
  delta: number;
  evidence?: string;
};

export type DimensionScore = {
  score: number;
  factors: FactorContribution[];
};

export type RepoScores = {
  code_quality: DimensionScore;
  security: DimensionScore;
  performance: DimensionScore;
  test_coverage: DimensionScore;
  readability: DimensionScore;
};

export type RepoGrade = "A" | "B" | "C" | "D" | "F";
export type RepoVerdict = "healthy" | "needs_attention" | "at_risk";

export type ScoringResult = {
  scores: RepoScores;
  avg_dim: number;
  health_score: number;
  grade: RepoGrade;
  verdict: RepoVerdict;
  worst_dimension: keyof RepoScores;
};

// ── FRD ───────────────────────────────────────────────────────────────────

export type FrdSection = {
  heading: string;
  level: number;
  file: string;
  evidence: string[];
  covered: boolean;
};

// ── Final output ──────────────────────────────────────────────────────────

export type ScanOutput = {
  signals: CliSignals;
  scoring: ScoringResult;
  frd: FrdSection[];
  pdfPath: string | null;
};
