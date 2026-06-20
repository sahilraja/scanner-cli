import PDFDocument from "pdfkit";
import type { CliSignals, FrdSection, RepoGrade, RepoScores, ScoringResult } from "./types";

// ── Color palette ─────────────────────────────────────────────────────────────

const C = {
  primary: "#2D4EFF",
  text: "#1E293B",
  muted: "#64748B",
  border: "#E2E8F0",
  bg: "#F8FAFC",
  success: "#16A34A",
  warning: "#D97706",
  danger: "#DC2626",
  white: "#FFFFFF",
  nearBlack: "#0F172A",
};

const GRADE_COLOR: Record<RepoGrade, string> = {
  A: C.success,
  B: "#22c55e",
  C: C.warning,
  D: "#EA580C",
  F: C.danger,
};

const DIM_LABELS: Record<keyof RepoScores, string> = {
  code_quality: "Code Quality",
  security: "Security",
  performance: "Performance",
  test_coverage: "Test Coverage",
  readability: "Readability",
};

// ── pdfkit helpers ────────────────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 7.5) return C.success;
  if (score >= 5.5) return C.warning;
  return C.danger;
}

function drawRect(
  doc: PDFKit.PDFDocument,
  x: number, y: number, w: number, h: number,
  fill: string, radius = 0
) {
  doc.roundedRect(x, y, w, h, radius).fill(fill);
}

function drawScoreBar(
  doc: PDFKit.PDFDocument,
  x: number, y: number, w: number, h: number,
  score: number
) {
  drawRect(doc, x, y, w, h, C.border);
  const filled = (score / 10) * w;
  drawRect(doc, x, y, filled, h, scoreColor(score));
}

function drawTable(
  doc: PDFKit.PDFDocument,
  headers: string[],
  rows: string[][],
  x: number, y: number, totalWidth: number,
  colWidths?: number[]
): number {
  const ROW_H = 22;
  const PAD = 6;
  const widths = colWidths ?? headers.map(() => totalWidth / headers.length);
  let curY = y;

  // Header row
  drawRect(doc, x, curY, totalWidth, ROW_H, C.primary);
  doc.fillColor(C.white).fontSize(8).font("Helvetica-Bold");
  let curX = x;
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i] ?? "", curX + PAD, curY + 6, { width: (widths[i] ?? 0) - PAD * 2, lineBreak: false });
    curX += widths[i] ?? 0;
  }
  curY += ROW_H;

  // Data rows
  doc.font("Helvetica").fontSize(8);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const bg = r % 2 === 0 ? C.white : C.bg;
    drawRect(doc, x, curY, totalWidth, ROW_H, bg);

    // Bottom border
    doc.moveTo(x, curY + ROW_H).lineTo(x + totalWidth, curY + ROW_H).strokeColor(C.border).lineWidth(0.5).stroke();

    curX = x;
    doc.fillColor(C.text);
    for (let i = 0; i < headers.length; i++) {
      const cell = (row[i] ?? "").slice(0, 120);
      doc.text(cell, curX + PAD, curY + 6, { width: (widths[i] ?? 0) - PAD * 2, lineBreak: false });
      curX += widths[i] ?? 0;
    }
    curY += ROW_H;
  }

  return curY;
}

// ── Cover page ────────────────────────────────────────────────────────────────

function drawCover(
  doc: PDFKit.PDFDocument,
  signals: CliSignals,
  scoring: ScoringResult
) {
  const W = doc.page.width;
  const H = doc.page.height;

  // Background header band
  drawRect(doc, 0, 0, W, 200, C.primary);

  // Title
  doc.fillColor(C.white).font("Helvetica-Bold").fontSize(28)
    .text("Project Health Report", 50, 50, { width: W - 100 });

  doc.font("Helvetica").fontSize(12).fillColor("rgba(255,255,255,0.8)")
    .text(signals.project_name, 50, 90, { width: W - 200 });

  const scanDate = new Date(signals.scanned_at).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });
  doc.fontSize(10).text(`Generated on ${scanDate}`, 50, 112);

  // Big grade circle
  const cx = W - 110, cy = 100, cr = 50;
  doc.circle(cx, cy, cr).fill(C.white);
  doc.fillColor(GRADE_COLOR[scoring.grade]).font("Helvetica-Bold").fontSize(42);
  doc.text(scoring.grade, cx - 18, cy - 24, { lineBreak: false });

  // Health score under grade circle
  doc.fillColor(C.text).font("Helvetica").fontSize(11)
    .text(`${scoring.health_score}/100`, cx - 20, cy + 32);

  // Verdict band
  const verdictColors: Record<string, string> = {
    healthy: C.success,
    needs_attention: C.warning,
    at_risk: C.danger,
  };
  const vColor = verdictColors[scoring.verdict] ?? C.muted;
  drawRect(doc, 0, 200, W, 36, vColor);
  doc.fillColor(C.white).font("Helvetica-Bold").fontSize(13)
    .text(
      scoring.verdict === "healthy" ? "✓  Healthy"
      : scoring.verdict === "needs_attention" ? "⚠  Needs Attention"
      : "✗  At Risk",
      50, 210
    );

  // 5-axis summary table
  let sy = 265;
  doc.fillColor(C.nearBlack).font("Helvetica-Bold").fontSize(13)
    .text("Score Summary", 50, sy);
  sy += 22;

  const BAR_W = 160;
  for (const [dim, ds] of Object.entries(scoring.scores) as [keyof RepoScores, { score: number }][]) {
    const label = DIM_LABELS[dim];
    const sc = ds.score;
    doc.fillColor(C.text).font("Helvetica").fontSize(10).text(label, 50, sy + 4, { width: 130, lineBreak: false });
    drawScoreBar(doc, 190, sy, BAR_W, 14, sc);
    doc.fillColor(scoreColor(sc)).font("Helvetica-Bold").fontSize(10)
      .text(sc.toFixed(1), 360, sy + 2, { lineBreak: false });
    sy += 28;
  }

  // Avg line
  doc.moveTo(50, sy + 6).lineTo(W - 50, sy + 6).strokeColor(C.border).lineWidth(0.5).stroke();
  sy += 14;
  doc.fillColor(C.text).font("Helvetica-Bold").fontSize(10)
    .text(`Average: ${scoring.avg_dim.toFixed(1)} / 10`, 50, sy);

  // File stats box
  sy = H - 180;
  drawRect(doc, 50, sy, W - 100, 110, C.bg, 6);
  doc.fillColor(C.text).font("Helvetica-Bold").fontSize(11).text("Repository Overview", 65, sy + 12);
  sy += 32;

  const stats: [string, string][] = [
    ["Total files", signals.total_files.toString()],
    ["Source files", signals.source_files.toString()],
    ["Test files", `${signals.test_files} (ratio: ${(signals.test_to_source_ratio * 100).toFixed(0)}%)`],
    ["Doc files", signals.doc_files.toString()],
    ["Languages", Object.keys(signals.languages).join(", ") || "—"],
    ["Frameworks", signals.frameworks.slice(0, 4).join(", ") || "—"],
  ];

  const COL = (W - 100) / 3;
  let col = 0;
  for (const [k, v] of stats) {
    const bx = 65 + col * COL;
    doc.font("Helvetica").fontSize(8).fillColor(C.muted).text(k, bx, sy, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(9).fillColor(C.text).text(v, bx, sy + 12, { width: COL - 10, lineBreak: false });
    col++;
    if (col === 3) { col = 0; sy += 30; }
  }
}

// ── Score breakdown page ──────────────────────────────────────────────────────

function drawScoreBreakdown(doc: PDFKit.PDFDocument, scoring: ScoringResult) {
  doc.addPage();
  const W = doc.page.width;
  let y = 50;

  drawRect(doc, 0, 0, W, 5, C.primary);

  doc.fillColor(C.nearBlack).font("Helvetica-Bold").fontSize(18).text("Score Breakdown", 50, y);
  y += 36;

  for (const [dim, ds] of Object.entries(scoring.scores) as [keyof RepoScores, { score: number; factors: { label: string; delta: number; evidence?: string }[] }][]) {
    if (y > doc.page.height - 120) { doc.addPage(); y = 50; }

    const label = DIM_LABELS[dim];
    const sc = ds.score;
    const color = scoreColor(sc);

    // Dimension header
    drawRect(doc, 50, y, W - 100, 30, C.bg, 4);
    doc.fillColor(C.nearBlack).font("Helvetica-Bold").fontSize(12).text(label, 60, y + 8, { lineBreak: false });
    doc.fillColor(color).fontSize(14).text(sc.toFixed(1), W - 100, y + 6, { lineBreak: false });
    y += 40;

    // Factors list
    for (const f of ds.factors) {
      if (y > doc.page.height - 60) { doc.addPage(); y = 50; }
      const bullet = f.delta >= 0 ? "+" : "";
      const fc = f.delta >= 0 ? C.success : C.danger;
      doc.fillColor(fc).font("Helvetica-Bold").fontSize(9).text(`${bullet}${f.delta.toFixed(1)}`, 60, y, { lineBreak: false, width: 35 });
      doc.fillColor(C.text).font("Helvetica").fontSize(9).text(f.label, 100, y, { lineBreak: false, width: W - 200 });
      y += 14;
      if (f.evidence) {
        doc.fillColor(C.muted).fontSize(7.5).text(f.evidence, 100, y, { width: W - 200, lineBreak: false });
        y += 12;
      }
    }
    y += 18;
  }
}

// ── Findings page ─────────────────────────────────────────────────────────────

function drawFindings(doc: PDFKit.PDFDocument, signals: CliSignals) {
  doc.addPage();
  const W = doc.page.width;
  let y = 50;

  drawRect(doc, 0, 0, W, 5, C.danger);
  doc.fillColor(C.nearBlack).font("Helvetica-Bold").fontSize(18).text("Key Findings", 50, y);
  y += 36;

  // Secret files (critical)
  if (signals.has_secret_files.length > 0) {
    drawRect(doc, 50, y, W - 100, 22, "#FEE2E2", 3);
    doc.fillColor(C.danger).font("Helvetica-Bold").fontSize(10).text("CRITICAL — Secret files detected in repository", 60, y + 6);
    y += 30;
    for (const f of signals.has_secret_files.slice(0, 5)) {
      doc.fillColor(C.danger).font("Helvetica").fontSize(9).text(`  • ${f}`, 60, y);
      y += 13;
    }
    y += 8;
  }

  // Hardcoded secrets
  if (signals.content && signals.content.secret_hits.length > 0) {
    const hits = signals.content.secret_hits;
    drawRect(doc, 50, y, W - 100, 22, "#FEE2E2", 3);
    doc.fillColor(C.danger).font("Helvetica-Bold").fontSize(10).text(`CRITICAL — ${hits.length} potential hardcoded credential(s)`, 60, y + 6);
    y += 30;
    const rows = hits.slice(0, 8).map((h) => [h.file, h.line.toString(), h.snippet]);
    y = drawTable(doc, ["File", "Line", "Snippet"], rows, 50, y, W - 100, [200, 50, W - 350]);
    y += 12;
  }

  // Vulnerable deps
  if (signals.deps && signals.deps.vulnerable.length > 0) {
    if (y > doc.page.height - 120) { doc.addPage(); y = 50; }
    drawRect(doc, 50, y, W - 100, 22, "#FEF3C7", 3);
    doc.fillColor(C.warning).font("Helvetica-Bold").fontSize(10).text(`WARNING — ${signals.deps.vulnerable.length} vulnerable dependency/ies`, 60, y + 6);
    y += 30;
    const rows = signals.deps.vulnerable.map((v) => [v.name, v.installed, v.reason]);
    y = drawTable(doc, ["Package", "Installed", "Issue"], rows, 50, y, W - 100, [120, 80, W - 250]);
    y += 12;
  }

  // Content rule summary
  if (signals.content) {
    if (y > doc.page.height - 120) { doc.addPage(); y = 50; }
    doc.fillColor(C.nearBlack).font("Helvetica-Bold").fontSize(13).text("Content Rule Hits", 50, y);
    y += 18;

    const rules = Object.entries(signals.content.totals.by_rule)
      .sort((a, b) => b[1] - a[1])
      .filter(([, v]) => v > 0);

    if (rules.length > 0) {
      const rows = rules.map(([id, count]) => [id, count.toString()]);
      y = drawTable(doc, ["Rule", "Occurrences"], rows, 50, y, W - 100, [300, W - 350]);
    } else {
      doc.fillColor(C.success).font("Helvetica").fontSize(10).text("No content rule violations found.", 50, y);
    }
    y += 12;
  }

  // Route security summary
  if (signals.routes && signals.routes.total > 0) {
    if (y > doc.page.height - 100) { doc.addPage(); y = 50; }
    doc.fillColor(C.nearBlack).font("Helvetica-Bold").fontSize(13).text(`Route Inventory (${signals.routes.total} routes)`, 50, y);
    y += 18;
    const rows = signals.routes.routes.slice(0, 20).map((r) => [
      r.method, r.path, r.file, r.has_auth ? "Yes" : "No",
    ]);
    y = drawTable(doc, ["Method", "Path", "File", "Auth?"], rows, 50, y, W - 100, [55, 120, 220, 45]);
    if (signals.routes.routes.length > 20) {
      doc.fillColor(C.muted).fontSize(8).text(`(showing 20 of ${signals.routes.total} routes)`, 50, y + 4);
      y += 16;
    }
  }
}

// ── FRD coverage page ─────────────────────────────────────────────────────────

function drawFrdCoverage(doc: PDFKit.PDFDocument, frd: FrdSection[]) {
  if (frd.length === 0) return;

  doc.addPage();
  const W = doc.page.width;
  let y = 50;

  drawRect(doc, 0, 0, W, 5, "#7C3AED");

  doc.fillColor(C.nearBlack).font("Helvetica-Bold").fontSize(18).text("Feature Requirement Coverage", 50, y);
  y += 14;

  const covered = frd.filter((s) => s.covered).length;
  const covPct = frd.length > 0 ? Math.round((covered / frd.length) * 100) : 0;
  doc.fillColor(C.muted).font("Helvetica").fontSize(11)
    .text(`${covered} of ${frd.length} FRD sections have code evidence (${covPct}%)`, 50, y);
  y += 30;

  // Show uncovered first (most actionable), then covered, capped at 80 rows
  const uncovered = frd.filter((s) => !s.covered);
  const coveredList = frd.filter((s) => s.covered);
  const display = [...uncovered, ...coveredList].slice(0, 80);

  const rows = display.map((s) => [
    "#".repeat(s.level) + " " + s.heading.slice(0, 55),
    s.file.split("/").pop() ?? s.file,
    s.covered ? "✓ Covered" : "✗ Missing",
    s.evidence.slice(0, 2).join(", ").slice(0, 55),
  ]);

  y = drawTable(
    doc,
    ["FRD Section", "File", "Status", "Evidence"],
    rows,
    50, y, W - 100,
    [200, 85, 70, W - 405]
  );

  if (frd.length > 80) {
    doc.fillColor(C.muted).font("Helvetica").fontSize(8)
      .text(`(showing 80 of ${frd.length} sections — ${uncovered.length} uncovered shown first)`, 50, y + 6);
  }
}

// ── Recommendations page ──────────────────────────────────────────────────────

function drawRecommendations(doc: PDFKit.PDFDocument, signals: CliSignals, scoring: ScoringResult) {
  doc.addPage();
  const W = doc.page.width;
  let y = 50;

  drawRect(doc, 0, 0, W, 5, C.primary);
  doc.fillColor(C.nearBlack).font("Helvetica-Bold").fontSize(18).text("Recommendations", 50, y);
  y += 36;

  const recs: Array<{ priority: "critical" | "high" | "medium"; text: string; why: string }> = [];

  if (signals.has_secret_files.length > 0) {
    recs.push({ priority: "critical", text: "Remove committed secret files immediately", why: `Found: ${signals.has_secret_files.slice(0, 2).join(", ")}` });
  }
  if ((signals.content?.secret_hits.length ?? 0) > 0) {
    recs.push({ priority: "critical", text: "Move hardcoded credentials to environment variables", why: `${signals.content?.secret_hits.length ?? 0} potential secret(s) in source code` });
  }
  if ((signals.deps?.vulnerable.length ?? 0) > 0) {
    recs.push({ priority: "high", text: "Update vulnerable dependencies", why: signals.deps?.vulnerable.map((v) => `${v.name}@${v.installed}`).slice(0, 2).join(", ") ?? "" });
  }
  if (signals.test_files === 0) {
    recs.push({ priority: "high", text: "Add a test suite", why: "No test files detected — untested code has no safety net for refactors" });
  } else if (signals.test_to_source_ratio < 0.25) {
    recs.push({ priority: "high", text: "Increase test coverage", why: `Only ${(signals.test_to_source_ratio * 100).toFixed(0)}% test/source ratio` });
  }
  if (!signals.has_ci_gitlab && !signals.has_ci_github) {
    recs.push({ priority: "high", text: "Add CI/CD pipeline", why: "No automated checks on push — bugs reach production uncaught" });
  }
  if (!signals.has_eslint_config) {
    recs.push({ priority: "medium", text: "Configure ESLint for consistent code style", why: "Linting catches bugs before they ship" });
  }
  if (!signals.has_typescript_config && Object.keys(signals.languages).some((l) => l === "JavaScript")) {
    recs.push({ priority: "medium", text: "Migrate to TypeScript", why: "Type errors are the most common category of runtime bugs" });
  } else if (signals.has_typescript_config && !signals.tsconfig_strict) {
    recs.push({ priority: "medium", text: "Enable TypeScript strict mode", why: "Non-strict TS misses ~40% of type errors" });
  }
  if (!signals.has_lockfile) {
    recs.push({ priority: "medium", text: "Commit a lockfile (package-lock.json / yarn.lock)", why: "Without a lockfile, installs are non-reproducible across environments" });
  }
  if (!signals.has_readme) {
    recs.push({ priority: "medium", text: "Add a README.md", why: "New team members have no onboarding guide" });
  }
  if ((signals.content?.totals.by_rule["empty-catch"] ?? 0) >= 3) {
    recs.push({ priority: "medium", text: "Replace empty catch blocks with error handling or explicit logging", why: "Silent failures make debugging impossible" });
  }
  if (signals.env_vars_undocumented > 3) {
    recs.push({ priority: "medium", text: "Document all env vars in .env.example", why: `${signals.env_vars_undocumented} vars in use but not documented` });
  }

  // Trim to top 10
  const sorted = [
    ...recs.filter((r) => r.priority === "critical"),
    ...recs.filter((r) => r.priority === "high"),
    ...recs.filter((r) => r.priority === "medium"),
  ].slice(0, 10);

  const PRIORITY_COLOR: Record<string, string> = { critical: C.danger, high: C.warning, medium: C.primary };

  for (let i = 0; i < sorted.length; i++) {
    if (y > doc.page.height - 80) { doc.addPage(); y = 50; }
    const rec = sorted[i]!;
    drawRect(doc, 50, y, W - 100, 46, C.bg, 4);
    drawRect(doc, 50, y, 4, 46, PRIORITY_COLOR[rec.priority] ?? C.primary, 2);

    const pLabel = rec.priority.toUpperCase();
    doc.fillColor(PRIORITY_COLOR[rec.priority] ?? C.primary).font("Helvetica-Bold").fontSize(7.5)
      .text(pLabel, 62, y + 8, { lineBreak: false });
    doc.fillColor(C.nearBlack).font("Helvetica-Bold").fontSize(10)
      .text(`${i + 1}. ${rec.text}`, 62, y + 20, { width: W - 130, lineBreak: false });
    doc.fillColor(C.muted).font("Helvetica").fontSize(8.5)
      .text(rec.why, 62, y + 33, { width: W - 130, lineBreak: false });
    y += 54;
  }

  if (sorted.length === 0) {
    doc.fillColor(C.success).font("Helvetica-Bold").fontSize(12)
      .text("No critical or high-priority issues found. Keep up the great work!  ", 50, y);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function generatePdf(
  signals: CliSignals,
  scoring: ScoringResult,
  frd: FrdSection[]
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 40, bottom: 40, left: 50, right: 50 },
      bufferPages: true,
      info: {
        Title: `Health Report — ${signals.project_name}`,
        Author: "@webileapps/scan",
        Subject: "Project Health Report",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    drawCover(doc, signals, scoring);
    drawScoreBreakdown(doc, scoring);
    drawFindings(doc, signals);
    if (frd.length > 0) drawFrdCoverage(doc, frd);
    drawRecommendations(doc, signals, scoring);

    // Footer on all pages
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.fillColor(C.muted).font("Helvetica").fontSize(7.5)
        .text(
          `Generated by @webileapps/scan  •  ${new Date(signals.scanned_at).toISOString().slice(0, 10)}  •  Page ${i + 1} of ${range.count}`,
          50,
          doc.page.height - 30,
          { width: doc.page.width - 100, align: "center", lineBreak: false }
        );
    }

    doc.end();
  });
}
