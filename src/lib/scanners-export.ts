/**
 * Client-side exporters for the "Structural scanners" panel.
 *
 *   1. **Project report** — single-project breakdown. PDF opens with a
 *      cover page (scorecard + executive summary: top issues, strengths,
 *      file census) and continues with one per-category section, each
 *      grouped by scanner. CSV uses a structured header block that
 *      opens cleanly in Excel followed by a flat findings table.
 *
 *   2. **Rollup report** — cross-project aggregation. PDF leads with a
 *      portfolio-level summary card + the worst-impact attributes, then
 *      the full table. CSV mirrors that with a stats header block.
 *
 * PDFs use lazy-loaded jspdf + jspdf-autotable (~400 KB on click).
 * Severity badges come from `scanner-fix-hints.ts` so the report and
 * the analytics drill-down always agree on what's "critical" vs "info".
 */
import {
  getFixHint,
  type FixHintSeverity,
} from "./scanner-fix-hints";
import type { SignalCategory, ScannerName } from "./types";

export type { SignalCategory, ScannerName };

export type ProjectAttribute = {
  category: SignalCategory;
  scanner: ScannerName;
  attribute_key: string;
  attribute_label: string;
  attribute_value: number;
  delta_to_score: number;
  evidence: string | null;
};

/** ── Rich-signal types (mirror the API response, kept local so this
 *     module stays decoupled from the server scanner). */

export type FactorRow = { label: string; delta: number; evidence?: string };
export type DimensionFactors = { score: number; factors: FactorRow[] };

export type ContentHit = {
  rule_id: string;
  severity: "critical" | "warning" | "suggestion";
  file: string;
  line: number;
  title: string;
  evidence: string;
};

export type ContentRichSignals = {
  totals: {
    critical: number;
    warning: number;
    suggestion: number;
    by_rule: Record<string, number>;
  };
  loc: { total: number; median: number; p95: number; very_long: number };
  longest_files: Array<{ file: string; lines: number }>;
  hits: ContentHit[];
  files_scanned: number;
};

export type VulnFinding = {
  ecosystem: string;
  package: string;
  version: string;
  lockfile: string;
  advisory: {
    id: string;
    severity: "critical" | "high" | "medium" | "low";
    range: string;
    summary: string;
  };
};

export type VulnRichSignals = {
  total_resolved: number;
  totals: { critical: number; high: number; medium: number; low: number };
  findings: VulnFinding[];
  lockfiles: Array<{ ecosystem: string; lockfile: string; package_count: number }>;
};

export type AstFunctionRow = {
  name: string;
  file: string;
  start_line: number;
  end_line: number;
  loc: number;
  params: number;
  complexity: number;
  max_nesting: number;
  is_exported: boolean;
  has_doc_comment: boolean;
  is_untested: boolean;
};

export type AstRichSignals = {
  total_functions: number;
  total_files_parsed: number;
  total_files_skipped: number;
  median_complexity: number;
  p95_complexity: number;
  max_complexity: number;
  median_function_loc: number;
  p95_function_loc: number;
  god_functions: number;
  long_functions: number;
  high_param_functions: number;
  deeply_nested_functions: number;
  god_files: number;
  exported_function_count: number;
  documented_export_count: number;
  doc_coverage_pct: number;
  untested_complex_functions: number;
  functions?: AstFunctionRow[];
};

export type DocRichSignals = {
  total_md_files: number;
  total_words: number;
  has_docs_dir: boolean;
  has_architecture_doc: boolean;
  has_api_doc: boolean;
  files_in_docs_dir: number;
  sections: Partial<Record<
    | "setup"
    | "usage"
    | "test"
    | "deploy"
    | "api"
    | "architecture"
    | "contributing"
    | "changelog"
    | "troubleshooting"
    | "faq",
    boolean
  >>;
};

export type ArchitectureRichSignals = {
  has_doc: boolean;
  doc_path: string | null;
  doc_word_count?: number;
  declared_apps: string[];
  apps_present: string[];
  apps_missing: string[];
  layout: {
    match_pct: number;
    matched_paths: number;
    total_paths: number;
  };
  stack: {
    match_pct: number;
    matched_libs: number;
    total_libs: number;
    matched_lib_names: string[];
  };
  convention_rules: Array<{ type: string; raw: string }>;
  compliance_pct: number;
};

export type ModuleRichRow = {
  path: string;
  label: string;
  kind: string;
  framework: string | null;
};

/** ── Raw shapes returned by `/api/projects/[id]/scan` (GET).
 *     Mirrored here so the export module can ingest them directly
 *     and produce a `ProjectScanSummary`. */

export type ProjectScanRawSignals = {
  project_id: number;
  project_path: string;
  health_score: number;
  grade: string;
  worst_dimension?: string | null;
  code_quality: number;
  security: number;
  performance: number;
  test_coverage: number;
  readability: number;
  scanned_at: number;
  scan_duration_ms?: number | null;
  default_branch?: string | null;
  ref?: string | null;
  commit_sha?: string | null;
  total_files: number;
  source_files: number;
  test_files?: number | null;
  doc_files?: number | null;
  config_files?: number | null;
};

export type ProjectScanFactorsPayload = {
  dimensions?: Partial<
    Record<
      "code_quality" | "security" | "performance" | "test_coverage" | "readability",
      DimensionFactors
    >
  >;
  verdict?: "healthy" | "needs_attention" | "at_risk";
  warnings?: string[];
  signals?: {
    content?: ContentRichSignals | null;
    vulns?: VulnRichSignals | null;
    ast?: AstRichSignals | null;
    docs?: DocRichSignals | null;
    architecture?: ArchitectureRichSignals | null;
    modules?: ModuleRichRow[] | null;
    frameworks?: string[] | null;
  };
};

/**
 * Translate the raw `/scan` API response into a `ProjectScanSummary`
 * that the exporter can consume. Both call sites (analytics export +
 * project detail "download report") use this so the report and the UI
 * stay in lock-step.
 */
export function buildProjectScanSummary(
  projectId: number,
  signals: ProjectScanRawSignals | null,
  factors: ProjectScanFactorsPayload | null,
  languages: Record<string, number> | null
): ProjectScanSummary {
  const path = signals?.project_path || "";
  const groupPath =
    path && path.includes("/")
      ? path.slice(0, path.lastIndexOf("/"))
      : null;
  return {
    project_id: projectId,
    project_path: path,
    group_path: groupPath,
    last_scanned_at: signals?.scanned_at ?? null,
    health_score: signals?.health_score ?? null,
    grade: signals?.grade ?? null,
    scores: signals
      ? {
          code_quality: signals.code_quality,
          security: signals.security,
          performance: signals.performance,
          test_coverage: signals.test_coverage,
          readability: signals.readability,
        }
      : null,
    total_files: signals?.total_files ?? null,
    source_files: signals?.source_files ?? null,
    test_files: signals?.test_files ?? null,
    doc_files: signals?.doc_files ?? null,
    config_files: signals?.config_files ?? null,
    scan_duration_ms: signals?.scan_duration_ms ?? null,
    default_branch: signals?.default_branch ?? null,
    ref: signals?.ref ?? null,
    commit_sha: signals?.commit_sha ?? null,
    verdict: factors?.verdict ?? null,
    worst_dimension: signals?.worst_dimension ?? null,
    languages: languages ?? null,
    factor_breakdown: factors?.dimensions ?? null,
    warnings: factors?.warnings ?? null,
    architecture: factors?.signals?.architecture ?? null,
    modules: factors?.signals?.modules ?? null,
    frameworks: factors?.signals?.frameworks ?? null,
    docs: factors?.signals?.docs ?? null,
    vulns: factors?.signals?.vulns ?? null,
    content: factors?.signals?.content ?? null,
    ast: factors?.signals?.ast ?? null,
  };
}

export type ProjectScanSummary = {
  project_id: number;
  project_path: string;
  group_path: string | null;
  last_scanned_at: number | null;
  health_score: number | null;
  grade: string | null;
  scores?: {
    code_quality: number;
    security: number;
    performance: number;
    test_coverage: number;
    readability: number;
  } | null;
  total_files?: number | null;
  source_files?: number | null;

  // ── Optional rich fields. When supplied, the corresponding section
  //    is rendered in PDF + CSV. The exporter degrades gracefully
  //    when any of these are missing so older callers stay compatible.
  scan_duration_ms?: number | null;
  default_branch?: string | null;
  ref?: string | null;
  commit_sha?: string | null;
  verdict?: "healthy" | "needs_attention" | "at_risk" | null;
  worst_dimension?: string | null;
  test_files?: number | null;
  doc_files?: number | null;
  config_files?: number | null;
  languages?: Record<string, number> | null;
  factor_breakdown?: Partial<Record<
    "code_quality" | "security" | "performance" | "test_coverage" | "readability",
    DimensionFactors
  >> | null;
  warnings?: string[] | null;
  architecture?: ArchitectureRichSignals | null;
  modules?: ModuleRichRow[] | null;
  frameworks?: string[] | null;
  docs?: DocRichSignals | null;
  vulns?: VulnRichSignals | null;
  content?: ContentRichSignals | null;
  ast?: AstRichSignals | null;
};

export type RollupAttribute = {
  category: SignalCategory;
  scanner: ScannerName;
  attribute_key: string;
  attribute_label: string;
  total_value: number;
  total_delta: number;
  project_count: number;
  avg_value: number;
};

const CATEGORY_LABEL: Record<SignalCategory, string> = {
  code_quality: "Code quality",
  security: "Security",
  performance: "Performance",
  test_coverage: "Test coverage",
  readability: "Readability",
};

const SCANNER_LABEL: Record<string, string> = {
  routes: "Routes",
  "test-map": "Test map",
  layering: "Layering",
  env: "Env vars",
  schema: "DB schema",
  deadcode: "Dead code",
  deps: "Deps & license",
};

const CATEGORY_ORDER: SignalCategory[] = [
  "code_quality",
  "security",
  "performance",
  "test_coverage",
  "readability",
];

const SCANNER_ORDER: ScannerName[] = [
  "routes",
  "test-map",
  "layering",
  "env",
  "schema",
  "deadcode",
  "deps",
];

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

function escapeCsvCell(value: string | number | null | undefined): string {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s) || /^[=+\-@]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Render evidence (which can be string / array / object) into a human
 * readable summary string. Used for both CSV (single cell) and PDF
 * (table cell + line wrap). Lists are flattened and capped so the cell
 * never grows to dozens of lines.
 */
export function summariseEvidence(evidence: unknown, maxItems = 12): string {
  if (evidence == null) return "";
  if (typeof evidence === "string") {
    if (!evidence) return "";
    try {
      // Some attributes were stored as JSON-encoded strings — try to
      // parse and re-summarise so the report always shows readable
      // text rather than `["a","b","c"]` literal output.
      const parsed = JSON.parse(evidence);
      if (typeof parsed !== "string") return summariseEvidence(parsed, maxItems);
    } catch {
      /* fallthrough — treat as plain text */
    }
    return evidence;
  }
  if (Array.isArray(evidence)) {
    if (evidence.length === 0) return "";
    const items = evidence
      .slice(0, maxItems)
      .map((it) => (typeof it === "string" ? it : JSON.stringify(it)));
    if (evidence.length > maxItems) {
      items.push(`… +${evidence.length - maxItems} more`);
    }
    return items.join(", ");
  }
  if (typeof evidence === "object") {
    const entries = Object.entries(evidence as Record<string, unknown>);
    if (entries.length === 0) return "";
    return entries
      .slice(0, maxItems)
      .map(([k, v]) => `${k}: ${summariseEvidence(v, 4)}`)
      .join(" · ");
  }
  return String(evidence);
}

/**
 * Like {@link summariseEvidence} but returns the **complete** content,
 * one item per line, so the report shows every entry the scanner
 * emitted (no "+N more" truncation). Single-item entries are still
 * trimmed to a sane line length so a stack trace doesn't blow up the
 * PDF cell, but counts and lists are never dropped. Use this for
 * candidate-facing reports where seeing every offending file matters
 * more than visual compactness.
 */
export function expandEvidence(
  evidence: unknown,
  opts: { maxLineChars?: number } = {}
): string {
  const maxLine = opts.maxLineChars ?? 240;
  if (evidence == null) return "";

  const trimLine = (s: string) => {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > maxLine
      ? flat.slice(0, maxLine - 1).trimEnd() + "…"
      : flat;
  };

  if (typeof evidence === "string") {
    if (!evidence) return "";
    try {
      const parsed = JSON.parse(evidence);
      if (typeof parsed !== "string") return expandEvidence(parsed, opts);
    } catch {
      /* plain text */
    }
    return trimLine(evidence);
  }

  if (Array.isArray(evidence)) {
    if (evidence.length === 0) return "";
    return evidence
      .map((it, i) => {
        const body =
          typeof it === "string"
            ? it
            : typeof it === "object" && it !== null
              ? expandEvidence(it, opts)
              : String(it);
        // Number each row so the candidate can reference findings
        // (e.g. "row 17 in the orphan-exports table").
        return `${i + 1}. ${trimLine(body)}`;
      })
      .join("\n");
  }

  if (typeof evidence === "object") {
    const entries = Object.entries(evidence as Record<string, unknown>);
    if (entries.length === 0) return "";
    return entries
      .map(([k, v]) => `${k}: ${trimLine(summariseEvidence(v, 200))}`)
      .join("\n");
  }

  return String(evidence);
}

function formatDate(epochMs: number | null | undefined): string {
  if (!epochMs) return "—";
  return new Date(epochMs).toISOString().slice(0, 16).replace("T", " ");
}

function shortName(path: string): string {
  if (!path) return "(unknown)";
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function categoryRank(c: SignalCategory): number {
  const i = CATEGORY_ORDER.indexOf(c);
  return i === -1 ? 99 : i;
}

function scannerRank(s: ScannerName): number {
  const i = SCANNER_ORDER.indexOf(s);
  return i === -1 ? 99 : i;
}

function sortAttributes<
  T extends { category: SignalCategory; scanner: ScannerName; attribute_key: string }
>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ca = categoryRank(a.category) - categoryRank(b.category);
    if (ca !== 0) return ca;
    const sa = scannerRank(a.scanner) - scannerRank(b.scanner);
    if (sa !== 0) return sa;
    return a.attribute_key.localeCompare(b.attribute_key);
  });
}

// ─── Tone palette (PDF traffic-light cells) ─────────────────────────────

type Tone = "good" | "warn" | "bad" | "info";
const TONE_BG: Record<Tone, [number, number, number]> = {
  good: [220, 252, 231],
  warn: [254, 243, 199],
  bad: [254, 226, 226],
  info: [224, 231, 255],
};
const TONE_FG: Record<Tone, [number, number, number]> = {
  good: [5, 122, 85],
  warn: [180, 83, 9],
  bad: [185, 28, 28],
  info: [55, 48, 163],
};

function applyTone(data: unknown, tone: Tone): void {
  const styles = (data as { cell?: { styles?: Record<string, unknown> } })?.cell
    ?.styles;
  if (!styles) return;
  styles.fillColor = TONE_BG[tone];
  styles.textColor = TONE_FG[tone];
  styles.fontStyle = "bold";
}

function deltaTone(delta: number): Tone {
  if (delta > 0.5) return "good";
  if (delta > 0) return "info";
  if (delta > -0.5) return "warn";
  return "bad";
}

const SEVERITY_LABEL: Record<FixHintSeverity, string> = {
  critical: "CRITICAL",
  warning: "WARNING",
  info: "INFO",
};

const SEVERITY_TONE: Record<FixHintSeverity, Tone> = {
  critical: "bad",
  warning: "warn",
  info: "info",
};

/**
 * Combine the hint-based severity (which reflects the *type* of finding)
 * with the actual delta on the scan (which reflects how much it moved
 * the score). Negative deltas with hint=info still surface as info, but
 * positive deltas always render as `good` so strengths read clearly.
 */
function effectiveSeverity(
  scanner: string,
  attributeKey: string,
  delta: number
): { label: string; tone: Tone } {
  if (delta > 0.05) return { label: "STRENGTH", tone: "good" };
  const hint = getFixHint(scanner, attributeKey);
  return { label: SEVERITY_LABEL[hint.severity], tone: SEVERITY_TONE[hint.severity] };
}

function gradeColor(grade: string | null): [number, number, number] {
  const g = (grade ?? "").toUpperCase();
  if (g === "A") return [16, 185, 129]; // emerald
  if (g === "B") return [34, 197, 94]; // green
  if (g === "C") return [234, 179, 8]; // amber
  if (g === "D") return [249, 115, 22]; // orange
  return [239, 68, 68]; // red
}

function healthColor(score: number | null): [number, number, number] {
  if (score == null || !Number.isFinite(score)) return [148, 163, 184];
  if (score >= 80) return [16, 185, 129];
  if (score >= 60) return [234, 179, 8];
  if (score >= 40) return [249, 115, 22];
  return [239, 68, 68];
}

function dimensionColor(score: number | null): [number, number, number] {
  if (score == null || !Number.isFinite(score)) return [148, 163, 184];
  if (score >= 8) return [16, 185, 129];
  if (score >= 6) return [234, 179, 8];
  if (score >= 4) return [249, 115, 22];
  return [239, 68, 68];
}

/**
 * Pick top-N items from a list using a comparator, preserving original
 * order for ties (stable sort) and capping at `n`.
 */
function topN<T>(items: T[], n: number, compare: (a: T, b: T) => number): T[] {
  return [...items].sort(compare).slice(0, n);
}

/** Trim long evidence strings to fit a PDF cell without breaking layout. */
function trimEvidence(s: string, maxChars = 220): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 1).trimEnd() + "…";
}

/**
 * Plain-English methodology for any score number we surface. Re-used
 * across PDF cover pages and CSV header blocks so reports never leave
 * the reader guessing what a `-1.5` means.
 */
export const METHODOLOGY_LINES = [
  "Each project earns 5 dimension scores (0-10): Code quality, Security, Performance, Test coverage, Readability.",
  "Dimensions start at a neutral base near 6.5 and shift up/down per detected signal. Final values are clamped to 0..10 — they never go negative.",
  "A finding's 'Score impact' is how much it shifts ONE dimension on ONE project. Negative means the project lost points, positive means it gained.",
  "Health (0-100) = average dimension * 10, minus a few global penalties (committed secrets, no CI, critical CVEs). Capped at 0 and 100.",
  "Grade is derived from the average dimension: A>=8.0, B>=6.5, C>=5.0, D>=3.5, otherwise F.",
  "In the portfolio rollup, 'Score impact' is summed across every project that triggered the finding. A large negative number means many projects share the same issue.",
];

function drawMethodologyBox(
  doc: import("jspdf").jsPDF,
  x: number,
  y: number,
  width: number
): number {
  const pad = 12;
  const lineHeight = 11;
  const titleHeight = 18;
  const totalHeight = titleHeight + METHODOLOGY_LINES.length * lineHeight + pad;

  doc.setFillColor(241, 245, 249);
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(x, y, width, totalHeight, 4, 4, "FD");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(15, 23, 42);
  doc.text("How scoring works", x + pad, y + 14);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(51, 65, 85);
  let textY = y + titleHeight + 6;
  for (const line of METHODOLOGY_LINES) {
    const wrapped = doc.splitTextToSize(`• ${line}`, width - pad * 2);
    for (const w of wrapped) {
      doc.text(w, x + pad, textY);
      textY += lineHeight;
    }
  }
  doc.setTextColor(0);
  return y + totalHeight;
}

// ─── Project report (CSV) ──────────────────────────────────────────────

/**
 * Section-block CSV. Excel happily renders the empty-row separators as
 * visual breaks, and the layout reads like a "report" rather than a
 * raw dump. The findings table at the bottom is filterable like any
 * normal CSV.
 */
function buildProjectCsv(
  proj: ProjectScanSummary,
  attributes: ProjectAttribute[]
): string {
  const sorted = sortAttributes(attributes);
  const lines: string[] = [];
  const kv = (k: string, v: string | number | null | undefined) =>
    [escapeCsvCell(k), escapeCsvCell(v ?? "")].join(",");

  lines.push(escapeCsvCell("Code Quality Report"));
  lines.push(escapeCsvCell(`Generated ${new Date().toLocaleString()}`));
  lines.push("");

  lines.push(escapeCsvCell("# How to read this"));
  for (const ln of METHODOLOGY_LINES) {
    lines.push(escapeCsvCell(ln));
  }
  lines.push("");

  lines.push(escapeCsvCell("# Project"));
  lines.push(kv("Project path", proj.project_path));
  lines.push(kv("Group", proj.group_path ?? "—"));
  lines.push(kv("Project ID", proj.project_id));
  lines.push(kv("Last scanned", formatDate(proj.last_scanned_at)));
  if (proj.scan_duration_ms != null) {
    lines.push(
      kv("Scan duration (s)", (proj.scan_duration_ms / 1000).toFixed(2))
    );
  }
  if (proj.default_branch) lines.push(kv("Default branch", proj.default_branch));
  if (proj.ref) lines.push(kv("Ref", proj.ref));
  if (proj.commit_sha) lines.push(kv("Commit SHA", proj.commit_sha));
  if (proj.verdict) lines.push(kv("Verdict", verdictLabel(proj.verdict)));
  if (proj.worst_dimension)
    lines.push(kv("Worst dimension", proj.worst_dimension));
  lines.push("");

  lines.push(escapeCsvCell("# Scores"));
  lines.push(kv("Health", proj.health_score ?? "—"));
  lines.push(kv("Grade", proj.grade ?? "—"));
  lines.push(
    kv("Code quality", proj.scores?.code_quality?.toFixed(1) ?? "—")
  );
  lines.push(kv("Security", proj.scores?.security?.toFixed(1) ?? "—"));
  lines.push(kv("Performance", proj.scores?.performance?.toFixed(1) ?? "—"));
  lines.push(
    kv("Test coverage", proj.scores?.test_coverage?.toFixed(1) ?? "—")
  );
  lines.push(kv("Readability", proj.scores?.readability?.toFixed(1) ?? "—"));
  lines.push("");

  lines.push(escapeCsvCell("# Files"));
  lines.push(kv("Total files", proj.total_files ?? "—"));
  lines.push(kv("Source files", proj.source_files ?? "—"));
  lines.push(kv("Test files", proj.test_files ?? "—"));
  lines.push(kv("Doc files", proj.doc_files ?? "—"));
  lines.push(kv("Config files", proj.config_files ?? "—"));
  if (
    proj.source_files != null &&
    proj.source_files > 0 &&
    proj.test_files != null
  ) {
    lines.push(
      kv(
        "Test:Source ratio (%)",
        Math.round((proj.test_files / proj.source_files) * 100)
      )
    );
  }
  lines.push("");

  // Languages
  if (proj.languages && Object.keys(proj.languages).length > 0) {
    const totalLang = Object.values(proj.languages).reduce(
      (s, n) => s + (typeof n === "number" ? n : 0),
      0
    );
    lines.push(escapeCsvCell("# Languages"));
    lines.push(["Language", "Files", "Share"].map(escapeCsvCell).join(","));
    Object.entries(proj.languages)
      .sort((a, b) => b[1] - a[1])
      .forEach(([lang, n]) => {
        lines.push(
          [
            lang,
            String(n),
            totalLang > 0 ? `${Math.round((n / totalLang) * 100)}%` : "—",
          ]
            .map(escapeCsvCell)
            .join(",")
        );
      });
    lines.push("");
  }

  // Architecture
  if (proj.architecture && proj.architecture.has_doc) {
    const arch = proj.architecture;
    lines.push(escapeCsvCell("# Architecture compliance"));
    lines.push(kv("Doc path", arch.doc_path ?? "—"));
    lines.push(kv("Doc word count", arch.doc_word_count ?? "—"));
    lines.push(kv("Compliance %", arch.compliance_pct.toFixed(0)));
    lines.push(kv("Declared apps", arch.declared_apps.join("; ") || "—"));
    lines.push(kv("Apps present", arch.apps_present.join("; ") || "—"));
    lines.push(kv("Apps missing", arch.apps_missing.join("; ") || "—"));
    lines.push(
      kv(
        "Layout match",
        `${arch.layout.matched_paths}/${
          arch.layout.total_paths
        } (${arch.layout.match_pct.toFixed(0)}%)`
      )
    );
    lines.push(
      kv(
        "Stack match",
        `${arch.stack.matched_libs}/${
          arch.stack.total_libs
        } (${arch.stack.match_pct.toFixed(0)}%)`
      )
    );
    if (arch.convention_rules.length > 0) {
      lines.push("");
      lines.push(escapeCsvCell("## Convention rules"));
      lines.push(["Type", "Rule"].map(escapeCsvCell).join(","));
      for (const r of arch.convention_rules) {
        lines.push([r.type, r.raw].map(escapeCsvCell).join(","));
      }
    }
    lines.push("");
  }

  // Modules
  if (proj.modules && proj.modules.length > 0) {
    lines.push(escapeCsvCell("# Modules & frameworks"));
    if (proj.frameworks && proj.frameworks.length > 0) {
      lines.push(kv("Frameworks", proj.frameworks.join("; ")));
    }
    lines.push(
      ["#", "Path", "Label", "Kind", "Framework"]
        .map(escapeCsvCell)
        .join(",")
    );
    proj.modules.forEach((m, i) => {
      lines.push(
        [
          String(i + 1),
          m.path,
          m.label,
          m.kind,
          m.framework ?? "—",
        ]
          .map(escapeCsvCell)
          .join(",")
      );
    });
    lines.push("");
  }

  // Docs
  if (proj.docs) {
    const d = proj.docs;
    lines.push(escapeCsvCell("# Documentation"));
    lines.push(kv("Total markdown files", d.total_md_files));
    lines.push(kv("Total words", d.total_words));
    lines.push(kv("Has /docs directory", d.has_docs_dir ? "Yes" : "No"));
    lines.push(kv("Files in /docs", d.files_in_docs_dir));
    lines.push(kv("Has architecture doc", d.has_architecture_doc ? "Yes" : "No"));
    lines.push(kv("Has API doc", d.has_api_doc ? "Yes" : "No"));
    const sections: Array<[
      keyof NonNullable<DocRichSignals["sections"]>,
      string
    ]> = [
      ["setup", "Setup / Getting started"],
      ["usage", "Usage / Examples"],
      ["test", "Testing"],
      ["deploy", "Deploy / Operations"],
      ["api", "API reference"],
      ["architecture", "Architecture"],
      ["contributing", "Contributing"],
      ["changelog", "Changelog"],
      ["troubleshooting", "Troubleshooting"],
      ["faq", "FAQ"],
    ];
    lines.push("");
    lines.push(escapeCsvCell("## Section presence"));
    lines.push(["Section", "Present"].map(escapeCsvCell).join(","));
    for (const [k, label] of sections) {
      lines.push(
        [label, d.sections[k] ? "Yes" : "No"]
          .map(escapeCsvCell)
          .join(",")
      );
    }
    lines.push("");
  }

  // Vulns
  if (proj.vulns) {
    const v = proj.vulns;
    lines.push(escapeCsvCell("# Vulnerabilities"));
    lines.push(kv("Total resolved packages", v.total_resolved));
    lines.push(kv("Critical", v.totals.critical));
    lines.push(kv("High", v.totals.high));
    lines.push(kv("Medium", v.totals.medium));
    lines.push(kv("Low", v.totals.low));
    lines.push(kv("Lockfiles", v.lockfiles.length));
    if (v.lockfiles.length > 0) {
      lines.push("");
      lines.push(escapeCsvCell("## Lockfiles parsed"));
      lines.push(
        ["Ecosystem", "Lockfile", "Packages"].map(escapeCsvCell).join(",")
      );
      for (const l of v.lockfiles) {
        lines.push(
          [l.ecosystem, l.lockfile, String(l.package_count)]
            .map(escapeCsvCell)
            .join(",")
        );
      }
    }
    if (v.findings.length > 0) {
      lines.push("");
      lines.push(escapeCsvCell("## Findings"));
      lines.push(
        [
          "Severity",
          "Package",
          "Version",
          "Ecosystem",
          "Lockfile",
          "Advisory",
          "Range",
          "Summary",
        ]
          .map(escapeCsvCell)
          .join(",")
      );
      for (const f of v.findings) {
        lines.push(
          [
            f.advisory.severity,
            f.package,
            f.version,
            f.ecosystem,
            f.lockfile,
            f.advisory.id,
            f.advisory.range,
            f.advisory.summary,
          ]
            .map(escapeCsvCell)
            .join(",")
        );
      }
    }
    lines.push("");
  }

  // Content scan
  if (proj.content) {
    const c = proj.content;
    lines.push(escapeCsvCell("# Content scan"));
    lines.push(kv("Files scanned", c.files_scanned));
    lines.push(kv("Total LOC", c.loc.total));
    lines.push(kv("Median file LOC", c.loc.median));
    lines.push(kv("P95 file LOC", c.loc.p95));
    lines.push(kv("Very long files (>500 LOC)", c.loc.very_long));
    lines.push(kv("Critical hits", c.totals.critical));
    lines.push(kv("Warning hits", c.totals.warning));
    lines.push(kv("Suggestion hits", c.totals.suggestion));
    const byRule = Object.entries(c.totals.by_rule).sort(
      (a, b) => b[1] - a[1]
    );
    if (byRule.length > 0) {
      lines.push("");
      lines.push(escapeCsvCell("## Hits by rule"));
      lines.push(["Rule", "Count"].map(escapeCsvCell).join(","));
      for (const [r, n] of byRule) {
        lines.push([r, String(n)].map(escapeCsvCell).join(","));
      }
    }
    if (c.hits.length > 0) {
      lines.push("");
      lines.push(escapeCsvCell("## Hits"));
      lines.push(
        ["Severity", "Rule", "File", "Line", "Title", "Evidence"]
          .map(escapeCsvCell)
          .join(",")
      );
      for (const h of c.hits) {
        lines.push(
          [
            h.severity,
            h.rule_id,
            h.file,
            String(h.line),
            h.title,
            trimEvidence(h.evidence, 400),
          ]
            .map(escapeCsvCell)
            .join(",")
        );
      }
    }
    if (c.longest_files.length > 0) {
      lines.push("");
      lines.push(escapeCsvCell("## Longest files"));
      lines.push(["#", "File", "Lines"].map(escapeCsvCell).join(","));
      c.longest_files.forEach((f, i) => {
        lines.push(
          [String(i + 1), f.file, String(f.lines)]
            .map(escapeCsvCell)
            .join(",")
        );
      });
    }
    lines.push("");
  }

  // AST / functions
  if (proj.ast && proj.ast.total_functions > 0) {
    const a = proj.ast;
    lines.push(escapeCsvCell("# Functions & complexity"));
    lines.push(kv("Total functions", a.total_functions));
    lines.push(kv("Files parsed", a.total_files_parsed));
    lines.push(kv("Files skipped", a.total_files_skipped));
    lines.push(kv("Median complexity", a.median_complexity));
    lines.push(kv("P95 complexity", a.p95_complexity));
    lines.push(kv("Max complexity", a.max_complexity));
    lines.push(kv("Median function LOC", a.median_function_loc));
    lines.push(kv("P95 function LOC", a.p95_function_loc));
    lines.push(kv("God functions (very complex)", a.god_functions));
    lines.push(kv("Long functions", a.long_functions));
    lines.push(kv("High-param functions", a.high_param_functions));
    lines.push(kv("Deeply nested functions", a.deeply_nested_functions));
    lines.push(kv("God files", a.god_files));
    lines.push(kv("Exported functions", a.exported_function_count));
    lines.push(kv("Documented exports", a.documented_export_count));
    lines.push(kv("Doc coverage %", a.doc_coverage_pct.toFixed(1)));
    lines.push(kv("Untested complex functions", a.untested_complex_functions));

    const fns = a.functions ?? [];
    if (fns.length > 0) {
      lines.push("");
      lines.push(escapeCsvCell("## Top functions by complexity"));
      lines.push(
        [
          "Complexity",
          "Function",
          "File",
          "Start line",
          "End line",
          "LOC",
          "Params",
          "Max nesting",
          "Exported",
          "Has doc comment",
          "Untested complex",
        ]
          .map(escapeCsvCell)
          .join(",")
      );
      const ranked = [...fns].sort(
        (x, y) => y.complexity - x.complexity || y.loc - x.loc
      );
      for (const fn of ranked) {
        lines.push(
          [
            String(fn.complexity),
            fn.name,
            fn.file,
            String(fn.start_line),
            String(fn.end_line),
            String(fn.loc),
            String(fn.params),
            String(fn.max_nesting),
            fn.is_exported ? "Yes" : "No",
            fn.has_doc_comment ? "Yes" : "No",
            fn.is_untested ? "Yes" : "No",
          ]
            .map(escapeCsvCell)
            .join(",")
        );
      }
    }
    lines.push("");
  }

  // Factor breakdown
  if (proj.factor_breakdown) {
    const dims = Object.entries(proj.factor_breakdown).filter(
      ([, v]) => !!v
    ) as Array<[string, DimensionFactors]>;
    if (dims.length > 0) {
      lines.push(escapeCsvCell("# Factor breakdown"));
      lines.push(
        ["Dimension", "Score", "Factor", "Score impact", "Evidence"]
          .map(escapeCsvCell)
          .join(",")
      );
      for (const [k, dim] of dims) {
        const label =
          DIMENSIONS.find((d) => d.key === k)?.label ?? k;
        if (dim.factors.length === 0) {
          lines.push(
            [
              label,
              dim.score.toFixed(1),
              "(no factors emitted for this dimension)",
              "—",
              "",
            ]
              .map(escapeCsvCell)
              .join(",")
          );
          continue;
        }
        for (const f of [...dim.factors].sort((a, b) => a.delta - b.delta)) {
          lines.push(
            [
              label,
              dim.score.toFixed(1),
              f.label,
              (f.delta >= 0 ? "+" : "") + f.delta.toFixed(2),
              f.evidence ?? "",
            ]
              .map(escapeCsvCell)
              .join(",")
          );
        }
      }
      lines.push("");
    }
  }

  // Warnings
  if (proj.warnings && proj.warnings.length > 0) {
    lines.push(escapeCsvCell("# Scan warnings"));
    lines.push(["#", "Warning"].map(escapeCsvCell).join(","));
    proj.warnings.forEach((w, i) => {
      lines.push([String(i + 1), w].map(escapeCsvCell).join(","));
    });
    lines.push("");
  }

  // Top issues block (worst Δ, severity ≠ info, capped at 5)
  const issues = topN(
    sorted.filter((a) => a.delta_to_score < -0.05),
    5,
    (a, b) => a.delta_to_score - b.delta_to_score
  );
  if (issues.length > 0) {
    lines.push(escapeCsvCell("# Top issues"));
    lines.push(
      ["Severity", "Category", "Scanner", "Finding", "Score impact"]
        .map(escapeCsvCell)
        .join(",")
    );
    for (const a of issues) {
      const sev = effectiveSeverity(a.scanner, a.attribute_key, a.delta_to_score);
      lines.push(
        [
          sev.label,
          CATEGORY_LABEL[a.category] ?? a.category,
          SCANNER_LABEL[a.scanner] ?? a.scanner,
          a.attribute_label,
          (a.delta_to_score >= 0 ? "+" : "") + a.delta_to_score.toFixed(2),
        ]
          .map(escapeCsvCell)
          .join(",")
      );
    }
    lines.push("");
  }

  // Strengths
  const strengths = topN(
    sorted.filter((a) => a.delta_to_score > 0.05),
    5,
    (a, b) => b.delta_to_score - a.delta_to_score
  );
  if (strengths.length > 0) {
    lines.push(escapeCsvCell("# Strengths"));
    lines.push(
      ["Category", "Scanner", "Finding", "Score impact"]
        .map(escapeCsvCell)
        .join(",")
    );
    for (const a of strengths) {
      lines.push(
        [
          CATEGORY_LABEL[a.category] ?? a.category,
          SCANNER_LABEL[a.scanner] ?? a.scanner,
          a.attribute_label,
          "+" + a.delta_to_score.toFixed(2),
        ]
          .map(escapeCsvCell)
          .join(",")
      );
    }
    lines.push("");
  }

  // Findings table — flat, filterable.
  lines.push(escapeCsvCell("# All findings"));
  lines.push(
    [
      "Severity",
      "Category",
      "Scanner",
      "Attribute key",
      "Attribute label",
      "Value",
      "Score impact",
      "Evidence",
    ]
      .map(escapeCsvCell)
      .join(",")
  );
  if (sorted.length === 0) {
    lines.push(
      ["—", "", "", "", "(no scanner attributes captured)", "", "", ""]
        .map(escapeCsvCell)
        .join(",")
    );
  } else {
    for (const a of sorted) {
      const sev = effectiveSeverity(a.scanner, a.attribute_key, a.delta_to_score);
      lines.push(
        [
          sev.label,
          CATEGORY_LABEL[a.category] ?? a.category,
          SCANNER_LABEL[a.scanner] ?? a.scanner,
          a.attribute_key,
          a.attribute_label,
          a.attribute_value,
          (a.delta_to_score >= 0 ? "+" : "") + a.delta_to_score.toFixed(2),
          // Full evidence (newline separated) so candidates can paste a
          // single CSV row into a ticket without losing rows.
          expandEvidence(a.evidence),
        ]
          .map(escapeCsvCell)
          .join(",")
      );
    }
  }

  return "\uFEFF" + lines.join("\r\n");
}

export function exportProjectReportToCsv(
  proj: ProjectScanSummary,
  attributes: ProjectAttribute[],
  filename?: string
): void {
  const csv = buildProjectCsv(proj, attributes);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  downloadBlob(
    blob,
    filename ??
      `${shortName(proj.project_path)}-scanners-${new Date()
        .toISOString()
        .slice(0, 10)}.csv`
  );
}

// ─── Project report (PDF) ──────────────────────────────────────────────

const DIMENSIONS: Array<{ key: keyof NonNullable<ProjectScanSummary["scores"]>; label: string }> = [
  { key: "code_quality", label: "Code quality" },
  { key: "security", label: "Security" },
  { key: "performance", label: "Performance" },
  { key: "test_coverage", label: "Test coverage" },
  { key: "readability", label: "Readability" },
];

/**
 * Draw a compact dimension card: label on top, score in the middle,
 * tinted background based on the score band. Used in a 5-up grid on
 * the cover page.
 */
function drawDimensionCard(
  doc: import("jspdf").jsPDF,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  score: number | null
) {
  const [r, g, b] = dimensionColor(score);
  doc.setFillColor(r, g, b);
  doc.setDrawColor(r, g, b);
  doc.roundedRect(x, y, w, h, 4, 4, "FD");
  doc.setTextColor(255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text(label, x + w / 2, y + 14, { align: "center" });
  doc.setFontSize(20);
  doc.text(
    score == null ? "—" : score.toFixed(1),
    x + w / 2,
    y + h - 10,
    { align: "center" }
  );
  doc.setTextColor(0);
}

function drawHealthHero(
  doc: import("jspdf").jsPDF,
  x: number,
  y: number,
  w: number,
  h: number,
  health: number | null,
  grade: string | null
) {
  const [r, g, b] = healthColor(health);
  doc.setFillColor(r, g, b);
  doc.roundedRect(x, y, w, h, 6, 6, "F");
  doc.setTextColor(255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("HEALTH", x + 14, y + 18);
  doc.setFontSize(40);
  doc.text(
    health == null ? "—" : Math.round(health).toString(),
    x + 14,
    y + h - 14
  );
  doc.setFontSize(11);
  doc.text("/100", x + 14 + (health == null ? 26 : 60), y + h - 14);

  // Grade chip in the upper-right.
  const [gr, gg, gb] = gradeColor(grade);
  doc.setFillColor(255, 255, 255);
  doc.roundedRect(x + w - 60, y + 12, 46, h - 24, 6, 6, "F");
  doc.setTextColor(gr, gg, gb);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text("GRADE", x + w - 37, y + 26, { align: "center" });
  doc.setFontSize(28);
  doc.text(grade ?? "—", x + w - 37, y + h - 18, { align: "center" });
  doc.setTextColor(0);
}

function setFooter(
  doc: import("jspdf").jsPDF,
  pageWidth: number,
  pageHeight: number,
  projectTitle: string
) {
  const pageCount = doc.getNumberOfPages();
  const current = doc.getCurrentPageInfo().pageNumber;
  doc.setFontSize(8);
  doc.setTextColor(140);
  doc.text(
    `${projectTitle}  ·  Page ${current} of ${pageCount}`,
    pageWidth - 40,
    pageHeight - 20,
    { align: "right" }
  );
  doc.setTextColor(0);
}

function verdictLabel(v: string | null | undefined): string {
  if (v === "healthy") return "Healthy";
  if (v === "needs_attention") return "Needs attention";
  if (v === "at_risk") return "At risk";
  return "—";
}

/** Severity tone for vulnerability findings (matches UI semantics). */
function vulnSeverityTone(sev: string): Tone {
  const s = (sev || "").toLowerCase();
  if (s === "critical" || s === "high") return "bad";
  if (s === "medium") return "warn";
  return "info";
}

/** ──────────────────────────────────────────────────────────────────
 *  Section heading helpers used by the rich detail pages. Each opens
 *  on a fresh A4-landscape page, paints a heading + subtitle and
 *  returns the y-cursor below the heading so the caller can start
 *  drawing tables.
 *  ────────────────────────────────────────────────────────────────*/
type AutoTableFn = (
  doc: import("jspdf").jsPDF,
  options: import("jspdf-autotable").UserOptions
) => void;

function startSectionPage(
  doc: import("jspdf").jsPDF,
  pageWidth: number,
  title: string,
  subtitle?: string
): number {
  doc.addPage();
  doc.setFillColor(248, 250, 252);
  doc.rect(0, 0, pageWidth, 56, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(15, 23, 42);
  doc.text(title, 40, 32);
  if (subtitle) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text(subtitle, 40, 48);
  }
  doc.setTextColor(0);
  return 76;
}

function drawSubSectionTitle(
  doc: import("jspdf").jsPDF,
  x: number,
  y: number,
  title: string
): number {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(51, 65, 85);
  doc.text(title, x, y);
  doc.setTextColor(0);
  return y + 14;
}

function lastTableY(
  doc: import("jspdf").jsPDF,
  fallback: number
): number {
  const last = (doc as unknown as { lastAutoTable?: { finalY?: number } })
    .lastAutoTable;
  return last?.finalY ?? fallback;
}

const KV_TABLE_STYLES: import("jspdf-autotable").UserOptions = {
  styles: { fontSize: 9, cellPadding: 5, valign: "top" },
  headStyles: {
    fillColor: [241, 245, 249],
    textColor: [51, 65, 85],
    fontStyle: "bold",
    lineColor: [226, 232, 240],
    lineWidth: 0.5,
  },
  bodyStyles: {
    lineColor: [226, 232, 240],
    lineWidth: 0.25,
    textColor: [30, 41, 59],
  },
  alternateRowStyles: { fillColor: [248, 250, 252] },
};

function renderProjectDetailsPage(
  doc: import("jspdf").jsPDF,
  autoTable: AutoTableFn,
  proj: ProjectScanSummary,
  pageWidth: number,
  pageHeight: number,
  projectTitle: string
): void {
  let cursor = startSectionPage(
    doc,
    pageWidth,
    "Project details",
    "Scan metadata, file census and languages — full mirror of the UI's header strip."
  );

  // Scan metadata key/value table
  const meta: Array<[string, string]> = [
    ["Project path", proj.project_path],
    ["Group", proj.group_path ?? "—"],
    ["Project ID", String(proj.project_id)],
    ["Scanned at", formatDate(proj.last_scanned_at)],
    [
      "Scan duration",
      proj.scan_duration_ms != null
        ? `${(proj.scan_duration_ms / 1000).toFixed(2)} s`
        : "—",
    ],
    ["Default branch", proj.default_branch ?? "—"],
    ["Ref", proj.ref ?? "—"],
    [
      "Commit SHA",
      proj.commit_sha ? proj.commit_sha.slice(0, 12) : "—",
    ],
    ["Verdict", verdictLabel(proj.verdict)],
    ["Worst dimension", proj.worst_dimension ?? "—"],
  ];

  cursor = drawSubSectionTitle(doc, 40, cursor, "Scan metadata");
  autoTable(doc, {
    ...KV_TABLE_STYLES,
    startY: cursor,
    margin: { left: 40, right: 40 },
    head: [["Field", "Value"]],
    body: meta,
    columnStyles: { 0: { cellWidth: 160 }, 1: { cellWidth: "auto" } },
    didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
  });
  cursor = lastTableY(doc, cursor) + 18;

  // File census table
  if (cursor > pageHeight - 160) {
    doc.addPage();
    cursor = 40;
  }
  cursor = drawSubSectionTitle(doc, 40, cursor, "File census");
  const total = proj.total_files ?? 0;
  const bucketRow = (label: string, n: number | null | undefined) => {
    const v = n ?? 0;
    const pct = total > 0 ? Math.round((v / total) * 100) : 0;
    return [label, String(v), total > 0 ? `${pct}%` : "—"];
  };
  autoTable(doc, {
    ...KV_TABLE_STYLES,
    startY: cursor,
    margin: { left: 40, right: 40 },
    head: [["Bucket", "Count", "Share of total"]],
    body: [
      ["Total", String(total), "100%"],
      bucketRow("Source", proj.source_files),
      bucketRow("Test", proj.test_files),
      bucketRow("Doc", proj.doc_files),
      bucketRow("Config", proj.config_files),
    ],
    columnStyles: {
      0: { cellWidth: 160 },
      1: { cellWidth: 100, halign: "right" },
      2: { cellWidth: 140, halign: "right" },
    },
    didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
  });
  cursor = lastTableY(doc, cursor) + 18;

  // Languages
  if (proj.languages && Object.keys(proj.languages).length > 0) {
    if (cursor > pageHeight - 160) {
      doc.addPage();
      cursor = 40;
    }
    cursor = drawSubSectionTitle(doc, 40, cursor, "Languages");
    const totalLang = Object.values(proj.languages).reduce(
      (s, n) => s + (typeof n === "number" ? n : 0),
      0
    );
    const langRows = Object.entries(proj.languages)
      .sort((a, b) => b[1] - a[1])
      .map(([lang, n]) => [
        lang,
        String(n),
        totalLang > 0 ? `${Math.round((n / totalLang) * 100)}%` : "—",
      ]);
    autoTable(doc, {
      ...KV_TABLE_STYLES,
      startY: cursor,
      margin: { left: 40, right: 40 },
      head: [["Language", "Files", "Share"]],
      body: langRows,
      columnStyles: {
        0: { cellWidth: 200 },
        1: { cellWidth: 100, halign: "right" },
        2: { cellWidth: 100, halign: "right" },
      },
      didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
    });
    cursor = lastTableY(doc, cursor) + 18;
  }

  // Warnings
  if (proj.warnings && proj.warnings.length > 0) {
    if (cursor > pageHeight - 140) {
      doc.addPage();
      cursor = 40;
    }
    cursor = drawSubSectionTitle(doc, 40, cursor, "Scan warnings");
    autoTable(doc, {
      ...KV_TABLE_STYLES,
      startY: cursor,
      margin: { left: 40, right: 40 },
      head: [["#", "Warning"]],
      body: proj.warnings.map((w, i) => [String(i + 1), w]),
      columnStyles: {
        0: { cellWidth: 36, halign: "right" },
        1: { cellWidth: "auto" },
      },
      didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
    });
  }
}

function renderArchitecturePage(
  doc: import("jspdf").jsPDF,
  autoTable: AutoTableFn,
  arch: ArchitectureRichSignals,
  pageWidth: number,
  pageHeight: number,
  projectTitle: string
): void {
  if (!arch.has_doc) return;
  let cursor = startSectionPage(
    doc,
    pageWidth,
    "Architecture compliance",
    `Compliance ${arch.compliance_pct.toFixed(0)}%  ·  declared apps ${
      arch.declared_apps.length
    }  ·  layout match ${arch.layout.match_pct.toFixed(
      0
    )}%  ·  stack match ${arch.stack.match_pct.toFixed(0)}%`
  );

  cursor = drawSubSectionTitle(doc, 40, cursor, "Summary");
  autoTable(doc, {
    ...KV_TABLE_STYLES,
    startY: cursor,
    margin: { left: 40, right: 40 },
    head: [["Field", "Value"]],
    body: [
      ["Doc path", arch.doc_path ?? "—"],
      ["Doc word count", String(arch.doc_word_count ?? "—")],
      ["Compliance %", `${arch.compliance_pct.toFixed(0)}%`],
      ["Declared apps", arch.declared_apps.join(", ") || "—"],
      ["Apps present", arch.apps_present.join(", ") || "—"],
      ["Apps missing", arch.apps_missing.join(", ") || "—"],
      [
        "Layout paths matched",
        `${arch.layout.matched_paths} / ${
          arch.layout.total_paths
        } (${arch.layout.match_pct.toFixed(0)}%)`,
      ],
      [
        "Stack libs matched",
        `${arch.stack.matched_libs} / ${
          arch.stack.total_libs
        } (${arch.stack.match_pct.toFixed(0)}%)`,
      ],
    ],
    columnStyles: { 0: { cellWidth: 220 }, 1: { cellWidth: "auto" } },
    didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
  });
  cursor = lastTableY(doc, cursor) + 18;

  if (arch.convention_rules.length > 0) {
    if (cursor > pageHeight - 140) {
      doc.addPage();
      cursor = 40;
    }
    cursor = drawSubSectionTitle(
      doc,
      40,
      cursor,
      `Convention rules (${arch.convention_rules.length})`
    );
    autoTable(doc, {
      ...KV_TABLE_STYLES,
      startY: cursor,
      margin: { left: 40, right: 40 },
      head: [["Type", "Rule"]],
      body: arch.convention_rules.map((r) => [r.type, r.raw]),
      columnStyles: { 0: { cellWidth: 160 }, 1: { cellWidth: "auto" } },
      didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
    });
  }
}

function renderModulesPage(
  doc: import("jspdf").jsPDF,
  autoTable: AutoTableFn,
  modules: ModuleRichRow[],
  frameworks: string[] | null | undefined,
  pageWidth: number,
  pageHeight: number,
  projectTitle: string
): void {
  if (!modules || modules.length === 0) return;
  const subtitle = `${modules.length} module${
    modules.length === 1 ? "" : "s"
  }${
    frameworks && frameworks.length > 0
      ? `  ·  Frameworks: ${frameworks.slice(0, 8).join(", ")}`
      : ""
  }`;
  const cursor = startSectionPage(
    doc,
    pageWidth,
    "Modules & frameworks",
    subtitle
  );
  autoTable(doc, {
    ...KV_TABLE_STYLES,
    startY: cursor,
    margin: { left: 40, right: 40 },
    head: [["#", "Path", "Label", "Kind", "Framework"]],
    body: modules.map((m, i) => [
      String(i + 1),
      m.path,
      m.label,
      m.kind,
      m.framework ?? "—",
    ]),
    columnStyles: {
      0: { cellWidth: 36, halign: "right" },
      1: { cellWidth: 240 },
      2: { cellWidth: 140 },
      3: { cellWidth: 100 },
      4: { cellWidth: "auto" },
    },
    didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
  });
}

function renderDocsPage(
  doc: import("jspdf").jsPDF,
  autoTable: AutoTableFn,
  docs: DocRichSignals,
  pageWidth: number,
  pageHeight: number,
  projectTitle: string
): void {
  if (
    docs.total_md_files === 0 &&
    !docs.has_docs_dir &&
    !docs.has_architecture_doc &&
    !docs.has_api_doc
  ) {
    return;
  }
  let cursor = startSectionPage(
    doc,
    pageWidth,
    "Documentation",
    `${docs.total_md_files} markdown file${
      docs.total_md_files === 1 ? "" : "s"
    }  ·  ${docs.total_words.toLocaleString()} words`
  );

  cursor = drawSubSectionTitle(doc, 40, cursor, "Summary");
  autoTable(doc, {
    ...KV_TABLE_STYLES,
    startY: cursor,
    margin: { left: 40, right: 40 },
    head: [["Field", "Value"]],
    body: [
      ["Total markdown files", String(docs.total_md_files)],
      ["Total words", docs.total_words.toLocaleString()],
      ["Has /docs directory", docs.has_docs_dir ? "Yes" : "No"],
      ["Files in /docs", String(docs.files_in_docs_dir)],
      ["Has architecture doc", docs.has_architecture_doc ? "Yes" : "No"],
      ["Has API doc", docs.has_api_doc ? "Yes" : "No"],
    ],
    columnStyles: { 0: { cellWidth: 220 }, 1: { cellWidth: "auto" } },
    didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
  });
  cursor = lastTableY(doc, cursor) + 18;

  // Sections checklist
  const sectionLabels: Array<[
    keyof NonNullable<DocRichSignals["sections"]>,
    string
  ]> = [
    ["setup", "Setup / Getting started"],
    ["usage", "Usage / Examples"],
    ["test", "Testing"],
    ["deploy", "Deploy / Operations"],
    ["api", "API reference"],
    ["architecture", "Architecture"],
    ["contributing", "Contributing"],
    ["changelog", "Changelog"],
    ["troubleshooting", "Troubleshooting"],
    ["faq", "FAQ"],
  ];
  if (cursor > pageHeight - 140) {
    doc.addPage();
    cursor = 40;
  }
  cursor = drawSubSectionTitle(doc, 40, cursor, "Sections checklist");
  autoTable(doc, {
    ...KV_TABLE_STYLES,
    startY: cursor,
    margin: { left: 40, right: 40 },
    head: [["Section", "Present"]],
    body: sectionLabels.map(([k, label]) => [
      label,
      docs.sections[k] ? "Yes" : "No",
    ]),
    columnStyles: {
      0: { cellWidth: 240 },
      1: { cellWidth: 100, halign: "center" },
    },
    didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
    didParseCell: (data) => {
      if (data.section !== "body") return;
      if (data.column.index === 1) {
        if (String(data.cell.raw) === "Yes") applyTone(data, "good");
        else applyTone(data, "warn");
      }
    },
  });
}

function renderVulnsPage(
  doc: import("jspdf").jsPDF,
  autoTable: AutoTableFn,
  vulns: VulnRichSignals,
  pageWidth: number,
  pageHeight: number,
  projectTitle: string
): void {
  if (
    vulns.total_resolved === 0 &&
    vulns.findings.length === 0 &&
    vulns.lockfiles.length === 0
  ) {
    return;
  }
  let cursor = startSectionPage(
    doc,
    pageWidth,
    "Vulnerabilities",
    `${vulns.total_resolved.toLocaleString()} resolved package${
      vulns.total_resolved === 1 ? "" : "s"
    }  ·  ${vulns.findings.length} finding${
      vulns.findings.length === 1 ? "" : "s"
    }  ·  ${vulns.lockfiles.length} lockfile${
      vulns.lockfiles.length === 1 ? "" : "s"
    }`
  );

  cursor = drawSubSectionTitle(doc, 40, cursor, "Severity totals");
  autoTable(doc, {
    ...KV_TABLE_STYLES,
    startY: cursor,
    margin: { left: 40, right: 40 },
    head: [["Severity", "Count"]],
    body: [
      ["Critical", String(vulns.totals.critical)],
      ["High", String(vulns.totals.high)],
      ["Medium", String(vulns.totals.medium)],
      ["Low", String(vulns.totals.low)],
    ],
    columnStyles: {
      0: { cellWidth: 160 },
      1: { cellWidth: 120, halign: "right" },
    },
    didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
    didParseCell: (data) => {
      if (data.section !== "body" || data.column.index !== 0) return;
      const sev = String(data.cell.raw).toLowerCase();
      applyTone(data, vulnSeverityTone(sev));
    },
  });
  cursor = lastTableY(doc, cursor) + 18;

  if (vulns.lockfiles.length > 0) {
    if (cursor > pageHeight - 140) {
      doc.addPage();
      cursor = 40;
    }
    cursor = drawSubSectionTitle(doc, 40, cursor, "Lockfiles parsed");
    autoTable(doc, {
      ...KV_TABLE_STYLES,
      startY: cursor,
      margin: { left: 40, right: 40 },
      head: [["Ecosystem", "Lockfile", "Packages"]],
      body: vulns.lockfiles.map((l) => [
        l.ecosystem,
        l.lockfile,
        String(l.package_count),
      ]),
      columnStyles: {
        0: { cellWidth: 100 },
        1: { cellWidth: "auto" },
        2: { cellWidth: 100, halign: "right" },
      },
      didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
    });
    cursor = lastTableY(doc, cursor) + 18;
  }

  if (vulns.findings.length > 0) {
    if (cursor > pageHeight - 160) {
      doc.addPage();
      cursor = 40;
    }
    cursor = drawSubSectionTitle(
      doc,
      40,
      cursor,
      `Findings (${vulns.findings.length})`
    );
    autoTable(doc, {
      ...KV_TABLE_STYLES,
      startY: cursor,
      margin: { left: 40, right: 40 },
      head: [
        [
          "Severity",
          "Package",
          "Version",
          "Ecosystem",
          "Advisory",
          "Range",
          "Summary",
        ],
      ],
      body: vulns.findings.map((f) => [
        f.advisory.severity,
        f.package,
        f.version,
        f.ecosystem,
        f.advisory.id,
        f.advisory.range,
        f.advisory.summary,
      ]),
      columnStyles: {
        0: { cellWidth: 60, halign: "center" },
        1: { cellWidth: 130 },
        2: { cellWidth: 70 },
        3: { cellWidth: 70 },
        4: { cellWidth: 110 },
        5: { cellWidth: 90 },
        6: { cellWidth: "auto" },
      },
      didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
      didParseCell: (data) => {
        if (data.section !== "body" || data.column.index !== 0) return;
        const sev = String(data.cell.raw).toLowerCase();
        applyTone(data, vulnSeverityTone(sev));
      },
    });
  }
}

function renderContentFindingsPage(
  doc: import("jspdf").jsPDF,
  autoTable: AutoTableFn,
  content: ContentRichSignals,
  pageWidth: number,
  pageHeight: number,
  projectTitle: string
): void {
  if (
    content.hits.length === 0 &&
    content.longest_files.length === 0 &&
    content.totals.critical === 0 &&
    content.totals.warning === 0 &&
    content.totals.suggestion === 0
  ) {
    return;
  }
  let cursor = startSectionPage(
    doc,
    pageWidth,
    "Content scan",
    `${content.hits.length} hit${
      content.hits.length === 1 ? "" : "s"
    }  ·  ${content.totals.critical} critical / ${
      content.totals.warning
    } warning / ${content.totals.suggestion} suggestion  ·  ${
      content.files_scanned
    } files scanned`
  );

  // LOC stats
  cursor = drawSubSectionTitle(doc, 40, cursor, "LOC distribution");
  autoTable(doc, {
    ...KV_TABLE_STYLES,
    startY: cursor,
    margin: { left: 40, right: 40 },
    head: [["Metric", "Value"]],
    body: [
      ["Total lines of code", content.loc.total.toLocaleString()],
      ["Median file LOC", String(content.loc.median)],
      ["P95 file LOC", String(content.loc.p95)],
      ["Very long files (>500 LOC)", String(content.loc.very_long)],
      ["Files scanned", String(content.files_scanned)],
    ],
    columnStyles: {
      0: { cellWidth: 240 },
      1: { cellWidth: 160, halign: "right" },
    },
    didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
  });
  cursor = lastTableY(doc, cursor) + 18;

  // Per-rule counts
  const byRule = Object.entries(content.totals.by_rule).sort(
    (a, b) => b[1] - a[1]
  );
  if (byRule.length > 0) {
    if (cursor > pageHeight - 160) {
      doc.addPage();
      cursor = 40;
    }
    cursor = drawSubSectionTitle(
      doc,
      40,
      cursor,
      `Hits by rule (${byRule.length})`
    );
    autoTable(doc, {
      ...KV_TABLE_STYLES,
      startY: cursor,
      margin: { left: 40, right: 40 },
      head: [["Rule", "Count"]],
      body: byRule.map(([r, n]) => [r, String(n)]),
      columnStyles: {
        0: { cellWidth: 320 },
        1: { cellWidth: 100, halign: "right" },
      },
      didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
    });
    cursor = lastTableY(doc, cursor) + 18;
  }

  // Every content-rules hit, fully enumerated. The candidate-facing
  // PDF is the source of truth so we don't truncate the list — the
  // table will simply overflow onto extra pages as needed.
  if (content.hits.length > 0) {
    if (cursor > pageHeight - 160) {
      doc.addPage();
      cursor = 40;
    }
    const shown = content.hits;
    cursor = drawSubSectionTitle(
      doc,
      40,
      cursor,
      `Findings (${content.hits.length})`
    );
    autoTable(doc, {
      ...KV_TABLE_STYLES,
      startY: cursor,
      margin: { left: 40, right: 40 },
      head: [["Severity", "File", "Line", "Title", "Evidence"]],
      body: shown.map((h) => [
        h.severity,
        h.file,
        String(h.line),
        h.title,
        trimEvidence(h.evidence, 300),
      ]),
      styles: { fontSize: 8.5, cellPadding: 4, overflow: "linebreak", valign: "top" },
      columnStyles: {
        0: { cellWidth: 60, halign: "center" },
        1: { cellWidth: 200 },
        2: { cellWidth: 40, halign: "right" },
        3: { cellWidth: 200 },
        4: { cellWidth: "auto" },
      },
      didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
      didParseCell: (data) => {
        if (data.section !== "body" || data.column.index !== 0) return;
        const sev = String(data.cell.raw).toLowerCase();
        if (sev === "critical") applyTone(data, "bad");
        else if (sev === "warning") applyTone(data, "warn");
        else applyTone(data, "info");
      },
    });
    cursor = lastTableY(doc, cursor) + 18;
  }

  // Longest files
  if (content.longest_files.length > 0) {
    if (cursor > pageHeight - 160) {
      doc.addPage();
      cursor = 40;
    }
    cursor = drawSubSectionTitle(
      doc,
      40,
      cursor,
      `Longest files (${content.longest_files.length})`
    );
    autoTable(doc, {
      ...KV_TABLE_STYLES,
      startY: cursor,
      margin: { left: 40, right: 40 },
      head: [["#", "File", "Lines"]],
      body: content.longest_files.map((f, i) => [
        String(i + 1),
        f.file,
        String(f.lines),
      ]),
      columnStyles: {
        0: { cellWidth: 36, halign: "right" },
        1: { cellWidth: "auto" },
        2: { cellWidth: 80, halign: "right" },
      },
      didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
    });
  }
}

function renderAstPage(
  doc: import("jspdf").jsPDF,
  autoTable: AutoTableFn,
  ast: AstRichSignals,
  pageWidth: number,
  pageHeight: number,
  projectTitle: string
): void {
  if (ast.total_functions === 0) return;
  let cursor = startSectionPage(
    doc,
    pageWidth,
    "Functions & complexity",
    `${ast.total_functions.toLocaleString()} function${
      ast.total_functions === 1 ? "" : "s"
    } across ${ast.total_files_parsed.toLocaleString()} parsed file${
      ast.total_files_parsed === 1 ? "" : "s"
    }  ·  ${ast.doc_coverage_pct.toFixed(0)}% docs coverage on exports`
  );

  cursor = drawSubSectionTitle(doc, 40, cursor, "Aggregate metrics");
  autoTable(doc, {
    ...KV_TABLE_STYLES,
    startY: cursor,
    margin: { left: 40, right: 40 },
    head: [["Metric", "Value"]],
    body: [
      ["Total functions", ast.total_functions.toLocaleString()],
      ["Files parsed", ast.total_files_parsed.toLocaleString()],
      ["Files skipped", ast.total_files_skipped.toLocaleString()],
      ["Median complexity", String(ast.median_complexity)],
      ["P95 complexity", String(ast.p95_complexity)],
      ["Max complexity", String(ast.max_complexity)],
      ["Median function LOC", String(ast.median_function_loc)],
      ["P95 function LOC", String(ast.p95_function_loc)],
      ["God functions (very complex)", String(ast.god_functions)],
      ["Long functions", String(ast.long_functions)],
      ["High-param functions", String(ast.high_param_functions)],
      ["Deeply nested functions", String(ast.deeply_nested_functions)],
      ["God files", String(ast.god_files)],
      ["Exported functions", String(ast.exported_function_count)],
      ["Documented exports", String(ast.documented_export_count)],
      ["Doc coverage", `${ast.doc_coverage_pct.toFixed(1)}%`],
      ["Untested complex functions", String(ast.untested_complex_functions)],
    ],
    columnStyles: {
      0: { cellWidth: 280 },
      1: { cellWidth: 160, halign: "right" },
    },
    didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
  });
  cursor = lastTableY(doc, cursor) + 18;

  // Top functions by complexity — mirrors the UI's "Top functions by
  // cyclomatic complexity" list. Capped at 40 to stay readable.
  const fns = ast.functions ?? [];
  if (fns.length > 0) {
    if (cursor > pageHeight - 160) {
      doc.addPage();
      cursor = 40;
    }
    const cap = 40;
    const ranked = [...fns]
      .sort(
        (a, b) => b.complexity - a.complexity || b.loc - a.loc
      )
      .slice(0, cap);
    cursor = drawSubSectionTitle(
      doc,
      40,
      cursor,
      `Top functions by complexity${
        fns.length > cap ? ` (showing ${cap} of ${fns.length})` : ` (${fns.length})`
      }`
    );
    autoTable(doc, {
      ...KV_TABLE_STYLES,
      startY: cursor,
      margin: { left: 40, right: 40 },
      head: [
        [
          "Cx",
          "Function",
          "File",
          "Lines",
          "LOC",
          "Params",
          "Nest",
          "Flags",
        ],
      ],
      body: ranked.map((fn) => {
        const flags: string[] = [];
        if (fn.is_exported) flags.push("export");
        if (fn.is_exported && !fn.has_doc_comment) flags.push("no docs");
        if (fn.is_untested && fn.is_exported && fn.complexity >= 10)
          flags.push("untested");
        return [
          String(fn.complexity),
          fn.name,
          fn.file,
          `${fn.start_line}-${fn.end_line}`,
          String(fn.loc),
          String(fn.params),
          String(fn.max_nesting),
          flags.join(", ") || "—",
        ];
      }),
      styles: { fontSize: 8.5, cellPadding: 4, overflow: "linebreak", valign: "top" },
      columnStyles: {
        0: { cellWidth: 40, halign: "right" },
        1: { cellWidth: 160 },
        2: { cellWidth: 220 },
        3: { cellWidth: 70, halign: "right" },
        4: { cellWidth: 50, halign: "right" },
        5: { cellWidth: 50, halign: "right" },
        6: { cellWidth: 40, halign: "right" },
        7: { cellWidth: "auto" },
      },
      didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
      didParseCell: (data) => {
        if (data.section !== "body" || data.column.index !== 0) return;
        const cx = parseFloat(String(data.cell.raw));
        if (Number.isFinite(cx)) {
          if (cx >= 20) applyTone(data, "bad");
          else if (cx >= 15) applyTone(data, "warn");
        }
      },
    });
  }
}

function renderFactorBreakdownPage(
  doc: import("jspdf").jsPDF,
  autoTable: AutoTableFn,
  breakdown: NonNullable<ProjectScanSummary["factor_breakdown"]>,
  pageWidth: number,
  pageHeight: number,
  projectTitle: string
): void {
  const dims = (
    Object.keys(breakdown) as Array<keyof typeof breakdown>
  ).filter((k) => !!breakdown[k]);
  if (dims.length === 0) return;

  let cursor = startSectionPage(
    doc,
    pageWidth,
    "Factor breakdown",
    "Per-dimension contributions — exactly what 'Show factor breakdown' renders in the project detail page."
  );

  for (const k of dims) {
    const dim = breakdown[k];
    if (!dim) continue;
    const label = (
      DIMENSIONS.find((d) => d.key === k)?.label ?? String(k)
    ) as string;
    if (cursor > pageHeight - 160) {
      doc.addPage();
      cursor = 40;
    }
    cursor = drawSubSectionTitle(
      doc,
      40,
      cursor,
      `${label} — score ${dim.score.toFixed(1)} / 10  ·  ${
        dim.factors.length
      } factor${dim.factors.length === 1 ? "" : "s"}`
    );

    const sortedFactors = [...dim.factors].sort((a, b) => a.delta - b.delta);
    autoTable(doc, {
      ...KV_TABLE_STYLES,
      startY: cursor,
      margin: { left: 40, right: 40 },
      head: [["Factor", "Score impact", "Evidence"]],
      body:
        sortedFactors.length === 0
          ? [["(no factors emitted for this dimension)", "—", ""]]
          : sortedFactors.map((f) => [
              f.label,
              (f.delta >= 0 ? "+" : "") + f.delta.toFixed(2),
              trimEvidence(f.evidence ?? "", 220),
            ]),
      columnStyles: {
        0: { cellWidth: 240 },
        1: { cellWidth: 80, halign: "right" },
        2: { cellWidth: "auto", textColor: [71, 85, 105] },
      },
      didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
      didParseCell: (data) => {
        if (data.section !== "body" || data.column.index !== 1) return;
        const num = parseFloat(String(data.cell.raw));
        if (Number.isFinite(num)) applyTone(data, deltaTone(num));
      },
    });
    cursor = lastTableY(doc, cursor) + 18;
  }
}

export async function exportProjectReportToPdf(
  proj: ProjectScanSummary,
  attributes: ProjectAttribute[],
  filename?: string
): Promise<void> {
  const [{ jsPDF }, autoTableMod] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  const autoTable =
    (autoTableMod as { default?: typeof autoTableMod.default }).default ??
    (autoTableMod as unknown as typeof autoTableMod.default);

  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const projectTitle = proj.project_path || `project #${proj.project_id}`;
  const sorted = sortAttributes(attributes);

  // ── Cover header ──────────────────────────────────────────────────
  doc.setFillColor(248, 250, 252);
  doc.rect(0, 0, pageWidth, 80, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(15, 23, 42);
  doc.text("Code Quality Report", 40, 36);

  doc.setFontSize(12);
  doc.setTextColor(51, 65, 85);
  doc.text(projectTitle, 40, 56);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  const metaLine = [
    proj.group_path ? `Group ${proj.group_path}` : null,
    `Project #${proj.project_id}`,
    proj.last_scanned_at
      ? `Scanned ${formatDate(proj.last_scanned_at)}`
      : "Never scanned",
    proj.default_branch ? `Branch ${proj.default_branch}` : null,
    proj.commit_sha ? `Commit ${proj.commit_sha.slice(0, 8)}` : null,
    proj.scan_duration_ms != null
      ? `Duration ${(proj.scan_duration_ms / 1000).toFixed(1)}s`
      : null,
    proj.verdict ? `Verdict ${verdictLabel(proj.verdict)}` : null,
    `${sorted.length} attribute${sorted.length === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join("  ·  ");
  doc.text(metaLine, 40, 72);
  doc.setTextColor(0);

  // ── Health hero + dimension grid ──────────────────────────────────
  const heroX = 40;
  const heroY = 100;
  const heroW = 220;
  const heroH = 86;
  drawHealthHero(doc, heroX, heroY, heroW, heroH, proj.health_score, proj.grade);

  // 5 dimension cards laid out next to the hero.
  const cardsX = heroX + heroW + 14;
  const cardsTotalW = pageWidth - cardsX - 40;
  const cardW = (cardsTotalW - 4 * 8) / 5;
  for (let i = 0; i < DIMENSIONS.length; i += 1) {
    const dim = DIMENSIONS[i];
    const score = proj.scores ? proj.scores[dim.key] : null;
    drawDimensionCard(
      doc,
      cardsX + i * (cardW + 8),
      heroY,
      cardW,
      heroH,
      dim.label,
      score ?? null
    );
  }

  // File census strip — include all four buckets and the test:source ratio
  const fileLineY = heroY + heroH + 22;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text("FILES", 40, fileLineY);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  const fileBits: string[] = [
    `Total ${proj.total_files ?? "—"}`,
    `Source ${proj.source_files ?? "—"}`,
    `Tests ${proj.test_files ?? "—"}`,
    `Docs ${proj.doc_files ?? "—"}`,
    `Config ${proj.config_files ?? "—"}`,
  ];
  if (
    proj.source_files != null &&
    proj.source_files > 0 &&
    proj.test_files != null
  ) {
    const pct = Math.round((proj.test_files / proj.source_files) * 100);
    fileBits.push(`Test:Source ${pct}%`);
  }
  doc.text(fileBits.join("    ·    "), 80, fileLineY);
  doc.setTextColor(0);

  // Languages strip — show top 3 by file count (if available)
  if (proj.languages && Object.keys(proj.languages).length > 0) {
    const langLineY = fileLineY + 14;
    const totalLangFiles = Object.values(proj.languages).reduce(
      (s, n) => s + (typeof n === "number" ? n : 0),
      0
    );
    const top = Object.entries(proj.languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => {
        const pct =
          totalLangFiles > 0 ? Math.round((v / totalLangFiles) * 100) : 0;
        return `${k} ${pct}%`;
      });
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(71, 85, 105);
    doc.text("LANGS", 40, langLineY);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(15, 23, 42);
    doc.text(top.join("    ·    "), 80, langLineY);
    doc.setTextColor(0);
  }

  // ── Top issues + Strengths ────────────────────────────────────────
  const issues = topN(
    sorted.filter((a) => a.delta_to_score < -0.05),
    5,
    (a, b) => a.delta_to_score - b.delta_to_score
  );
  const strengths = topN(
    sorted.filter((a) => a.delta_to_score > 0.05),
    5,
    (a, b) => b.delta_to_score - a.delta_to_score
  );

  // Bottom of the cover header strip (file census + optional languages line).
  const hasLangs =
    !!proj.languages && Object.keys(proj.languages).length > 0;
  let cursor = fileLineY + (hasLangs ? 36 : 22);

  if (issues.length > 0) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(185, 28, 28);
    doc.text("Top issues", 40, cursor + 14);
    doc.setTextColor(0);
    cursor += 22;

    autoTable(doc, {
      startY: cursor,
      margin: { left: 40, right: 40 },
      head: [["Severity", "Category", "Scanner", "Finding", "Score impact"]],
      body: issues.map((a) => {
        const sev = effectiveSeverity(a.scanner, a.attribute_key, a.delta_to_score);
        return [
          sev.label,
          CATEGORY_LABEL[a.category] ?? a.category,
          SCANNER_LABEL[a.scanner] ?? a.scanner,
          a.attribute_label,
          (a.delta_to_score >= 0 ? "+" : "") + a.delta_to_score.toFixed(2),
        ];
      }),
      styles: { fontSize: 9, cellPadding: 5, valign: "top" },
      headStyles: {
        fillColor: [241, 245, 249],
        textColor: [51, 65, 85],
        fontStyle: "bold",
        lineColor: [226, 232, 240],
        lineWidth: 0.5,
      },
      bodyStyles: { lineColor: [226, 232, 240], lineWidth: 0.25 },
      columnStyles: {
        0: { cellWidth: 70, halign: "center" },
        1: { cellWidth: 90 },
        2: { cellWidth: 90 },
        3: { cellWidth: "auto" },
        4: { cellWidth: 50, halign: "right" },
      },
      didParseCell: (data) => {
        if (data.section !== "body") return;
        if (data.column.index === 0) {
          const sev = String(data.cell.raw).toLowerCase();
          if (sev === "critical") applyTone(data, "bad");
          else if (sev === "warning") applyTone(data, "warn");
          else applyTone(data, "info");
        }
        if (data.column.index === 4) {
          const num = parseFloat(String(data.cell.raw));
          if (Number.isFinite(num)) applyTone(data, deltaTone(num));
        }
      },
    });
    cursor =
      ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
        ?.finalY ?? cursor) + 18;
  }

  if (strengths.length > 0) {
    if (cursor > pageHeight - 140) {
      doc.addPage();
      cursor = 40;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(5, 122, 85);
    doc.text("Strengths", 40, cursor + 14);
    doc.setTextColor(0);
    cursor += 22;

    autoTable(doc, {
      startY: cursor,
      margin: { left: 40, right: 40 },
      head: [["Category", "Scanner", "Finding", "Score impact"]],
      body: strengths.map((a) => [
        CATEGORY_LABEL[a.category] ?? a.category,
        SCANNER_LABEL[a.scanner] ?? a.scanner,
        a.attribute_label,
        "+" + a.delta_to_score.toFixed(2),
      ]),
      styles: { fontSize: 9, cellPadding: 5, valign: "top" },
      headStyles: {
        fillColor: [241, 245, 249],
        textColor: [51, 65, 85],
        fontStyle: "bold",
        lineColor: [226, 232, 240],
        lineWidth: 0.5,
      },
      bodyStyles: { lineColor: [226, 232, 240], lineWidth: 0.25 },
      columnStyles: {
        0: { cellWidth: 90 },
        1: { cellWidth: 90 },
        2: { cellWidth: "auto" },
        3: { cellWidth: 50, halign: "right" },
      },
      didParseCell: (data) => {
        if (data.section !== "body") return;
        if (data.column.index === 3) {
          const num = parseFloat(String(data.cell.raw));
          if (Number.isFinite(num)) applyTone(data, deltaTone(num));
        }
      },
    });
    cursor =
      ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
        ?.finalY ?? cursor) + 18;
  }

  if (sorted.length === 0) {
    doc.setFontSize(11);
    doc.setTextColor(100, 116, 139);
    doc.text(
      "No scanner attributes captured for this project's latest scan.",
      40,
      cursor + 14
    );
    doc.setTextColor(0);
    cursor += 28;
  }

  // ── Methodology card (always appended at the bottom of the cover) ─
  if (cursor < pageHeight - 140) {
    drawMethodologyBox(doc, 40, cursor, pageWidth - 80);
  } else {
    // Cover got long — push methodology onto its own appendix page so
    // we don't crowd the per-category sections.
    doc.addPage();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(15, 23, 42);
    doc.text("Methodology", 40, 36);
    doc.setTextColor(0);
    drawMethodologyBox(doc, 40, 56, pageWidth - 80);
  }

  // ── Rich detail sections ──────────────────────────────────────────
  // Each one starts on its own page when the matching signal payload
  // is present. Order mirrors the project detail UI so the report
  // reads top-to-bottom in the same shape the user already knows.
  renderProjectDetailsPage(
    doc,
    autoTable,
    proj,
    pageWidth,
    pageHeight,
    projectTitle
  );
  if (proj.architecture && proj.architecture.has_doc) {
    renderArchitecturePage(
      doc,
      autoTable,
      proj.architecture,
      pageWidth,
      pageHeight,
      projectTitle
    );
  }
  if (proj.modules && proj.modules.length > 0) {
    renderModulesPage(
      doc,
      autoTable,
      proj.modules,
      proj.frameworks ?? null,
      pageWidth,
      pageHeight,
      projectTitle
    );
  }
  if (proj.docs) {
    renderDocsPage(
      doc,
      autoTable,
      proj.docs,
      pageWidth,
      pageHeight,
      projectTitle
    );
  }
  if (proj.vulns) {
    renderVulnsPage(
      doc,
      autoTable,
      proj.vulns,
      pageWidth,
      pageHeight,
      projectTitle
    );
  }
  if (proj.content) {
    renderContentFindingsPage(
      doc,
      autoTable,
      proj.content,
      pageWidth,
      pageHeight,
      projectTitle
    );
  }
  if (proj.ast && proj.ast.total_functions > 0) {
    renderAstPage(
      doc,
      autoTable,
      proj.ast,
      pageWidth,
      pageHeight,
      projectTitle
    );
  }
  if (
    proj.factor_breakdown &&
    Object.keys(proj.factor_breakdown).length > 0
  ) {
    renderFactorBreakdownPage(
      doc,
      autoTable,
      proj.factor_breakdown,
      pageWidth,
      pageHeight,
      projectTitle
    );
  }

  // ── Per-category sections ─────────────────────────────────────────
  const byCategory = new Map<SignalCategory, ProjectAttribute[]>();
  for (const a of sorted) {
    if (!byCategory.has(a.category)) byCategory.set(a.category, []);
    byCategory.get(a.category)!.push(a);
  }

  // Order categories by their net impact — most negative first so the
  // reviewer sees the most important section right after the cover.
  const orderedCategories = CATEGORY_ORDER.filter((c) =>
    byCategory.has(c)
  ).sort((a, b) => {
    const sa = byCategory.get(a)!.reduce((s, x) => s + x.delta_to_score, 0);
    const sb = byCategory.get(b)!.reduce((s, x) => s + x.delta_to_score, 0);
    return sa - sb;
  });

  for (const cat of orderedCategories) {
    const items = byCategory.get(cat)!;
    // Always start each category on a fresh page so the reader can
    // navigate without spending mental energy on where one ends.
    doc.addPage();
    cursor = 40;

    const totalDelta = items.reduce((s, x) => s + x.delta_to_score, 0);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(15, 23, 42);
    doc.text(CATEGORY_LABEL[cat], 40, cursor + 14);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text(
      `${items.length} finding${items.length === 1 ? "" : "s"}  ·  Net score impact ${
        totalDelta >= 0 ? "+" : ""
      }${totalDelta.toFixed(1)}`,
      40,
      cursor + 30
    );
    doc.setTextColor(0);
    cursor += 42;

    // Within a category, group by scanner so all findings from a
    // single scanner read together. Sort scanners by canonical order.
    const byScanner = new Map<ScannerName, ProjectAttribute[]>();
    for (const a of items) {
      if (!byScanner.has(a.scanner)) byScanner.set(a.scanner, []);
      byScanner.get(a.scanner)!.push(a);
    }
    const scanners = SCANNER_ORDER.filter((s) => byScanner.has(s)).concat(
      Array.from(byScanner.keys()).filter((s) => !SCANNER_ORDER.includes(s))
    );

    for (const sc of scanners) {
      const rows = byScanner.get(sc)!;

      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(71, 85, 105);
      if (cursor > pageHeight - 140) {
        doc.addPage();
        cursor = 40;
      }
      doc.text(SCANNER_LABEL[sc] ?? sc, 40, cursor + 12);
      doc.setTextColor(0);
      cursor += 18;

      autoTable(doc, {
        startY: cursor,
        margin: { left: 40, right: 40 },
        head: [["Severity", "Finding", "Value", "Score impact", "Evidence"]],
        body: rows.map((a) => {
          const sev = effectiveSeverity(a.scanner, a.attribute_key, a.delta_to_score);
          // We deliberately do *not* truncate the evidence list here —
          // the report is meant for candidates so they need to see
          // every offending file, every missing index, etc. autoTable
          // will wrap and span the row across pages as needed.
          return [
            sev.label,
            a.attribute_label,
            formatNumber(a.attribute_value),
            (a.delta_to_score >= 0 ? "+" : "") + a.delta_to_score.toFixed(2),
            expandEvidence(a.evidence),
          ];
        }),
        styles: {
          fontSize: 8.5,
          cellPadding: 5,
          overflow: "linebreak",
          valign: "top",
        },
        headStyles: {
          fillColor: [241, 245, 249],
          textColor: [51, 65, 85],
          fontStyle: "bold",
          lineColor: [226, 232, 240],
          lineWidth: 0.5,
        },
        bodyStyles: {
          lineColor: [226, 232, 240],
          lineWidth: 0.25,
          textColor: [30, 41, 59],
        },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: {
          0: { cellWidth: 56, halign: "center" },
          1: { cellWidth: 170 },
          2: { halign: "right", cellWidth: 44 },
          3: { halign: "right", cellWidth: 60 },
          4: { cellWidth: "auto", textColor: [71, 85, 105] },
        },
        didParseCell: (data) => {
          if (data.section !== "body") return;
          if (data.column.index === 0) {
            const sev = String(data.cell.raw).toLowerCase();
            if (sev === "critical") applyTone(data, "bad");
            else if (sev === "warning") applyTone(data, "warn");
            else if (sev === "strength") applyTone(data, "good");
            else applyTone(data, "info");
          }
          if (data.column.index === 3) {
            const num = parseFloat(String(data.cell.raw));
            if (Number.isFinite(num)) applyTone(data, deltaTone(num));
          }
        },
        didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle),
      });

      cursor =
        ((doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable
          ?.finalY ?? cursor) + 14;
    }
  }

  // Ensure the cover page also gets a footer (autoTable's didDrawPage
  // only fires while drawing tables — manually paint the cover footer).
  doc.setPage(1);
  setFooter(doc, pageWidth, pageHeight, projectTitle);

  doc.save(
    filename ??
      `${shortName(proj.project_path)}-scanners-${new Date()
        .toISOString()
        .slice(0, 10)}.pdf`
  );
}

// ─── Rollup report (CSV) ───────────────────────────────────────────────

/**
 * Compute portfolio-level stats over the rollup so the report header
 * has a story rather than just "here's a table".
 */
function rollupSummary(rollup: RollupAttribute[]) {
  const totalAttrs = rollup.length;
  const negDelta = rollup.reduce(
    (s, r) => s + (r.total_delta < 0 ? r.total_delta : 0),
    0
  );
  const posDelta = rollup.reduce(
    (s, r) => s + (r.total_delta > 0 ? r.total_delta : 0),
    0
  );
  const projects = new Set<number>();
  // project_count is per-attribute in the rollup; we don't know
  // distinct project ids here, so report max instead.
  let maxProjectCount = 0;
  const byCategory = new Map<SignalCategory, number>();
  const byScanner = new Map<ScannerName, number>();
  for (const r of rollup) {
    maxProjectCount = Math.max(maxProjectCount, r.project_count);
    byCategory.set(
      r.category,
      (byCategory.get(r.category) ?? 0) + r.total_delta
    );
    byScanner.set(r.scanner, (byScanner.get(r.scanner) ?? 0) + r.total_delta);
  }
  const worstCategory = Array.from(byCategory.entries()).sort(
    (a, b) => a[1] - b[1]
  )[0];
  const worstScanner = Array.from(byScanner.entries()).sort(
    (a, b) => a[1] - b[1]
  )[0];

  return {
    totalAttrs,
    negDelta,
    posDelta,
    maxProjectCount,
    projects,
    worstCategory: worstCategory ?? null,
    worstScanner: worstScanner ?? null,
  };
}

export function exportRollupReportToCsv(
  rollup: RollupAttribute[],
  filters: { category?: string; scanner?: string },
  filename?: string
): void {
  const sorted = sortAttributes(rollup);
  const summary = rollupSummary(rollup);
  const lines: string[] = [];
  const kv = (k: string, v: string | number | null | undefined) =>
    [escapeCsvCell(k), escapeCsvCell(v ?? "")].join(",");

  lines.push(escapeCsvCell("Code Quality — Portfolio Rollup"));
  lines.push(escapeCsvCell(`Generated ${new Date().toLocaleString()}`));
  lines.push("");

  lines.push(escapeCsvCell("# How to read this"));
  for (const ln of METHODOLOGY_LINES) {
    lines.push(escapeCsvCell(ln));
  }
  lines.push("");

  lines.push(escapeCsvCell("# Filters"));
  lines.push(kv("Category", filters.category ?? "all"));
  lines.push(kv("Scanner", filters.scanner ?? "all"));
  lines.push("");

  lines.push(escapeCsvCell("# Summary"));
  lines.push(kv("Attributes", summary.totalAttrs));
  lines.push(kv("Total negative impact", summary.negDelta.toFixed(2)));
  lines.push(kv("Total positive impact", "+" + summary.posDelta.toFixed(2)));
  lines.push(
    kv(
      "Worst-impact category",
      summary.worstCategory
        ? `${CATEGORY_LABEL[summary.worstCategory[0]]} (impact ${summary.worstCategory[1].toFixed(2)})`
        : "—"
    )
  );
  lines.push(
    kv(
      "Worst-impact scanner",
      summary.worstScanner
        ? `${SCANNER_LABEL[summary.worstScanner[0]] ?? summary.worstScanner[0]} (impact ${summary.worstScanner[1].toFixed(2)})`
        : "—"
    )
  );
  lines.push(kv("Largest cohort (projects per attribute)", summary.maxProjectCount));
  lines.push("");

  // Top 10 worst-impact attributes for at-a-glance review.
  const worst = topN(
    rollup.filter((r) => r.total_delta < 0),
    10,
    (a, b) => a.total_delta - b.total_delta
  );
  if (worst.length > 0) {
    lines.push(escapeCsvCell("# Top portfolio issues"));
    lines.push(
      ["Severity", "Category", "Scanner", "Attribute", "Score impact", "Projects"]
        .map(escapeCsvCell)
        .join(",")
    );
    for (const r of worst) {
      const sev = effectiveSeverity(r.scanner, r.attribute_key, r.total_delta);
      lines.push(
        [
          sev.label,
          CATEGORY_LABEL[r.category] ?? r.category,
          SCANNER_LABEL[r.scanner] ?? r.scanner,
          r.attribute_label,
          r.total_delta.toFixed(2),
          r.project_count,
        ]
          .map(escapeCsvCell)
          .join(",")
      );
    }
    lines.push("");
  }

  lines.push(escapeCsvCell("# All attributes"));
  lines.push(
    [
      "Severity",
      "Category",
      "Scanner",
      "Attribute key",
      "Attribute label",
      "Total value",
      "Score impact",
      "Avg value",
      "Projects",
    ]
      .map(escapeCsvCell)
      .join(",")
  );
  for (const r of sorted) {
    const sev = effectiveSeverity(r.scanner, r.attribute_key, r.total_delta);
    lines.push(
      [
        sev.label,
        CATEGORY_LABEL[r.category] ?? r.category,
        SCANNER_LABEL[r.scanner] ?? r.scanner,
        r.attribute_key,
        r.attribute_label,
        r.total_value,
        (r.total_delta >= 0 ? "+" : "") + r.total_delta.toFixed(2),
        formatNumber(r.avg_value),
        r.project_count,
      ]
        .map(escapeCsvCell)
        .join(",")
    );
  }

  const csv = "\uFEFF" + lines.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  downloadBlob(
    blob,
    filename ??
      `mr-analyzer-scanners-rollup-${new Date().toISOString().slice(0, 10)}.csv`
  );
}

// ─── Rollup report (PDF) ───────────────────────────────────────────────

/**
 * Render a stat tile (label on top, big number below) inside a coloured
 * background. Used in a 4-up grid on the rollup cover page.
 */
function drawStatTile(
  doc: import("jspdf").jsPDF,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: string,
  fill: [number, number, number]
) {
  doc.setFillColor(fill[0], fill[1], fill[2]);
  doc.roundedRect(x, y, w, h, 5, 5, "F");
  doc.setTextColor(255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text(label, x + 12, y + 16);
  doc.setFontSize(20);
  doc.text(value, x + 12, y + h - 12);
  doc.setTextColor(0);
}

export async function exportRollupReportToPdf(
  rollup: RollupAttribute[],
  filters: { category?: string; scanner?: string },
  filename?: string
): Promise<void> {
  const [{ jsPDF }, autoTableMod] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  const autoTable =
    (autoTableMod as { default?: typeof autoTableMod.default }).default ??
    (autoTableMod as unknown as typeof autoTableMod.default);

  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const sorted = sortAttributes(rollup);
  const summary = rollupSummary(rollup);

  // ── Cover header ──────────────────────────────────────────────────
  doc.setFillColor(248, 250, 252);
  doc.rect(0, 0, pageWidth, 80, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(15, 23, 42);
  doc.text("Code Quality — Portfolio Rollup", 40, 36);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  const filterDesc =
    !filters.category && !filters.scanner
      ? "All categories · All scanners"
      : [
          filters.category
            ? `Category: ${CATEGORY_LABEL[filters.category as SignalCategory] ?? filters.category}`
            : null,
          filters.scanner
            ? `Scanner: ${SCANNER_LABEL[filters.scanner] ?? filters.scanner}`
            : null,
        ]
          .filter(Boolean)
          .join("  ·  ");
  doc.text(filterDesc, 40, 56);
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(`Generated ${new Date().toLocaleString()}`, 40, 72);
  doc.setTextColor(0);

  // ── Stat tiles ────────────────────────────────────────────────────
  const tileY = 100;
  const tileH = 76;
  const tileGap = 12;
  const tileW = (pageWidth - 80 - tileGap * 3) / 4;
  drawStatTile(
    doc,
    40,
    tileY,
    tileW,
    tileH,
    "ATTRIBUTES",
    String(summary.totalAttrs),
    [99, 102, 241]
  );
  drawStatTile(
    doc,
    40 + (tileW + tileGap),
    tileY,
    tileW,
    tileH,
    "TOTAL NEGATIVE IMPACT",
    summary.negDelta.toFixed(1),
    [239, 68, 68]
  );
  drawStatTile(
    doc,
    40 + 2 * (tileW + tileGap),
    tileY,
    tileW,
    tileH,
    "TOTAL POSITIVE IMPACT",
    "+" + summary.posDelta.toFixed(1),
    [16, 185, 129]
  );
  drawStatTile(
    doc,
    40 + 3 * (tileW + tileGap),
    tileY,
    tileW,
    tileH,
    "MAX COHORT SIZE",
    String(summary.maxProjectCount),
    [14, 165, 233]
  );

  // ── Worst-impact tags ─────────────────────────────────────────────
  let cursor = tileY + tileH + 22;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  doc.text("WORST-IMPACT CATEGORY", 40, cursor);
  doc.text("WORST-IMPACT SCANNER", 40 + (pageWidth - 80) / 2, cursor);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(15, 23, 42);
  doc.text(
    summary.worstCategory
      ? `${CATEGORY_LABEL[summary.worstCategory[0]]}  (impact ${summary.worstCategory[1].toFixed(2)})`
      : "—",
    40,
    cursor + 16
  );
  doc.text(
    summary.worstScanner
      ? `${SCANNER_LABEL[summary.worstScanner[0]] ?? summary.worstScanner[0]}  (impact ${summary.worstScanner[1].toFixed(2)})`
      : "—",
    40 + (pageWidth - 80) / 2,
    cursor + 16
  );
  doc.setTextColor(0);
  cursor += 36;

  // ── Top portfolio issues table ────────────────────────────────────
  const worst = topN(
    rollup.filter((r) => r.total_delta < 0),
    8,
    (a, b) => a.total_delta - b.total_delta
  );
  if (worst.length > 0) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(185, 28, 28);
    doc.text("Top portfolio issues", 40, cursor + 14);
    doc.setTextColor(0);
    cursor += 22;

    autoTable(doc, {
      startY: cursor,
      margin: { left: 40, right: 40 },
      head: [
        [
          "Severity",
          "Category",
          "Scanner",
          "Attribute",
          "Score impact",
          "Projects",
        ],
      ],
      body: worst.map((r) => {
        const sev = effectiveSeverity(r.scanner, r.attribute_key, r.total_delta);
        return [
          sev.label,
          CATEGORY_LABEL[r.category] ?? r.category,
          SCANNER_LABEL[r.scanner] ?? r.scanner,
          r.attribute_label,
          r.total_delta.toFixed(2),
          r.project_count,
        ];
      }),
      styles: { fontSize: 9, cellPadding: 5, valign: "top" },
      headStyles: {
        fillColor: [241, 245, 249],
        textColor: [51, 65, 85],
        fontStyle: "bold",
        lineColor: [226, 232, 240],
        lineWidth: 0.5,
      },
      bodyStyles: { lineColor: [226, 232, 240], lineWidth: 0.25 },
      columnStyles: {
        0: { cellWidth: 70, halign: "center" },
        1: { cellWidth: 90 },
        2: { cellWidth: 90 },
        3: { cellWidth: "auto" },
        4: { halign: "right", cellWidth: 70 },
        5: { halign: "right", cellWidth: 60 },
      },
      didParseCell: (data) => {
        if (data.section !== "body") return;
        if (data.column.index === 0) {
          const sev = String(data.cell.raw).toLowerCase();
          if (sev === "critical") applyTone(data, "bad");
          else if (sev === "warning") applyTone(data, "warn");
          else applyTone(data, "info");
        }
        if (data.column.index === 4) {
          const num = parseFloat(String(data.cell.raw));
          if (Number.isFinite(num)) applyTone(data, deltaTone(num));
        }
      },
      didDrawPage: () => setFooter(doc, pageWidth, pageHeight, "Portfolio rollup"),
    });
  }

  // Methodology — sized to drop in below the issues table; pushes onto
  // the next page if there isn't enough room.
  const afterIssues =
    ((doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable
      ?.finalY ?? cursor) + 18;
  if (afterIssues < pageHeight - 140) {
    drawMethodologyBox(doc, 40, afterIssues, pageWidth - 80);
  } else {
    doc.addPage();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(15, 23, 42);
    doc.text("Methodology", 40, 36);
    doc.setTextColor(0);
    drawMethodologyBox(doc, 40, 56, pageWidth - 80);
  }

  // ── Full attribute table on a fresh page ──────────────────────────
  if (sorted.length > 0) {
    doc.addPage();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(15, 23, 42);
    doc.text("All attributes", 40, 36);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text(
      `${sorted.length} row${sorted.length === 1 ? "" : "s"}  ·  sorted by category, scanner, attribute`,
      40,
      52
    );
    doc.setTextColor(0);

    autoTable(doc, {
      startY: 64,
      margin: { left: 40, right: 40 },
      head: [
        [
          "Severity",
          "Category",
          "Scanner",
          "Attribute",
          "Total value",
          "Score impact",
          "Avg value",
          "Projects",
        ],
      ],
      body: sorted.map((r) => {
        const sev = effectiveSeverity(r.scanner, r.attribute_key, r.total_delta);
        return [
          sev.label,
          CATEGORY_LABEL[r.category] ?? r.category,
          SCANNER_LABEL[r.scanner] ?? r.scanner,
          r.attribute_label,
          formatNumber(r.total_value),
          (r.total_delta >= 0 ? "+" : "") + r.total_delta.toFixed(2),
          formatNumber(r.avg_value),
          r.project_count,
        ];
      }),
      styles: {
        fontSize: 8.5,
        cellPadding: 4,
        overflow: "linebreak",
        valign: "top",
      },
      headStyles: {
        fillColor: [241, 245, 249],
        textColor: [51, 65, 85],
        fontStyle: "bold",
        lineColor: [226, 232, 240],
        lineWidth: 0.5,
      },
      bodyStyles: {
        lineColor: [226, 232, 240],
        lineWidth: 0.25,
        textColor: [30, 41, 59],
      },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: {
        0: { cellWidth: 60, halign: "center" },
        1: { cellWidth: 80 },
        2: { cellWidth: 80 },
        3: { cellWidth: "auto" },
        4: { halign: "right", cellWidth: 60 },
        5: { halign: "right", cellWidth: 70 },
        6: { halign: "right", cellWidth: 60 },
        7: { halign: "right", cellWidth: 56 },
      },
      didParseCell: (data) => {
        if (data.section !== "body") return;
        if (data.column.index === 0) {
          const sev = String(data.cell.raw).toLowerCase();
          if (sev === "critical") applyTone(data, "bad");
          else if (sev === "warning") applyTone(data, "warn");
          else if (sev === "strength") applyTone(data, "good");
          else applyTone(data, "info");
        }
        if (data.column.index === 5) {
          const num = parseFloat(String(data.cell.raw));
          if (Number.isFinite(num)) applyTone(data, deltaTone(num));
        }
      },
      didDrawPage: () => setFooter(doc, pageWidth, pageHeight, "Portfolio rollup"),
    });
  }

  // Cover page footer (autoTable doesn't paint one for non-table pages).
  doc.setPage(1);
  setFooter(doc, pageWidth, pageHeight, "Portfolio rollup");

  doc.save(
    filename ??
      `mr-analyzer-scanners-rollup-${new Date().toISOString().slice(0, 10)}.pdf`
  );
}

function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}
