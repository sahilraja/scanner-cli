export type ParsedMrUrl = {
  host: string;
  baseUrl: string;
  projectPath: string;
  mrIid: number;
};

export type GitlabUser = {
  id: number;
  username: string;
  name: string;
  avatar_url?: string | null;
};

export type GitlabMr = {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: string;
  draft: boolean;
  source_branch: string;
  target_branch: string;
  author: GitlabUser;
  web_url: string;
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  closed_at?: string | null;
  merge_status: string;
  has_conflicts: boolean;
  user_notes_count: number;
  upvotes: number;
  downvotes: number;
  labels: string[];
  changes_count?: string;
  project_id: number;
};

export type MrBucket = "waiting" | "reviewed" | "merged" | "closed";

export type MrInventoryRow = {
  id: number;
  mr_key: string;
  base_url: string;
  group_path: string;
  project_id: number;
  project_path: string;
  mr_iid: number;
  mr_title: string;
  mr_web_url: string;
  state: string;
  draft: number;
  merge_status: string | null;
  has_conflicts: number;
  source_branch: string | null;
  target_branch: string | null;
  author_username: string | null;
  author_name: string | null;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
  last_seen_at: number;
  last_review_id: number | null;
  last_reviewed_mr_updated_at: string | null;
  last_review_verdict: string | null;
  last_review_score: number | null;
  last_reviewed_at: number | null;
  /** Number of non-system notes on this MR authored by the GitLab user
   *  whose token we sync with. >0 means "I've already engaged with this
   *  MR" — folded into the "reviewed" bucket and excluded from "waiting". */
  my_comment_count: number;
  /** ISO timestamp of the most recent note authored by the GitLab user. */
  my_last_comment_at: string | null;
};

export type GitlabFileChange = {
  old_path: string;
  new_path: string;
  a_mode?: string;
  b_mode?: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff: string;
};

export type GitlabMrChanges = {
  changes: GitlabFileChange[];
  diff_refs?: {
    base_sha: string;
    head_sha: string;
    start_sha: string;
  };
};

export type GitlabPipeline = {
  id: number;
  iid?: number;
  status: string;
  ref: string;
  sha: string;
  web_url: string;
  created_at: string;
};

export type GitlabNote = {
  id: number;
  body: string;
  author: GitlabUser;
  created_at: string;
  system: boolean;
  resolvable: boolean;
  resolved?: boolean;
};

export type FetchedMr = {
  parsed: ParsedMrUrl;
  mr: GitlabMr;
  changes: GitlabFileChange[];
  diffRefs?: GitlabMrChanges["diff_refs"];
  pipeline: GitlabPipeline | null;
  notes: GitlabNote[];
};

export type ReviewScores = {
  code_quality: number;
  security: number;
  performance: number;
  test_coverage: number;
  readability: number;
};

export type ReviewIssue = {
  severity: "critical" | "warning" | "suggestion" | "nit";
  file?: string;
  line?: number;
  title: string;
  detail: string;
  recommendation?: string;
};

export type FileReview = {
  path: string;
  summary: string;
  risk: "low" | "medium" | "high";
  issues: ReviewIssue[];
};

export type ReviewVerdict = "approve" | "changes_requested" | "reject";

// ── Shared analytics types ────────────────────────────────────────────────────
// Canonical definitions used by the DB layer, server scanners, client exporters,
// and UI components. Do NOT redefine these elsewhere.

export type SignalCategory =
  | "code_quality"
  | "security"
  | "performance"
  | "test_coverage"
  | "readability";

export type ScannerName =
  | "routes"
  | "test-map"
  | "layering"
  | "env"
  | "schema"
  | "deadcode"
  | "deps"
  | "ast"
  | "content"
  | "vulns"
  | "docs"
  | "architecture"
  | "modules"
  | "manifests";

/**
 * Single 0-100 number that summarizes how cautious a reviewer should be
 * about merging this MR. Composed from severity counts, diff size, "blast
 * radius" signals (env / migrations / new files), and any structural
 * red flags (oversized MR, stale pipeline, conflicts). Higher = riskier.
 */
export type RiskBand = "low" | "moderate" | "elevated" | "high";

export type RiskBreakdown = {
  score: number;
  band: RiskBand;
  factors: { label: string; weight: number; detail?: string }[];
};

export type ReviewResult = {
  verdict: ReviewVerdict;
  one_liner: string;
  summary: string;
  scores: ReviewScores;
  /** Optional 0-100 risk metric. Older stored reviews may not have one. */
  risk?: RiskBreakdown;
  highlights: string[];
  critical_issues: ReviewIssue[];
  warnings: ReviewIssue[];
  suggestions: ReviewIssue[];
  file_reviews: FileReview[];
  checklist: {
    label: string;
    passed: boolean;
    note?: string;
  }[];
};
