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
  A: "#16A34A",
  B: "#22c55e",
  C: C.warning,
  D: "#EA580C",
  F: C.danger,
};

const DIM_COLORS: Record<keyof RepoScores, string> = {
  code_quality: "#10B981",
  security: "#F59E0B",
  performance: "#F59E0B",
  test_coverage: "#F59E0B",
  readability: "#F59E0B",
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

function drawTable(
  doc: PDFKit.PDFDocument,
  headers: string[],
  rows: string[][],
  x: number, y: number, totalWidth: number,
  colWidths?: number[]
): number {
  const ROW_H = 18;
  const PAD = 4;
  const widths = colWidths ?? headers.map(() => totalWidth / headers.length);
  let curY = y;

  // Header row
  drawRect(doc, x, curY, totalWidth, ROW_H + 2, C.primary);
  doc.fillColor(C.white).fontSize(7.5).font("Helvetica-Bold");
  let curX = x;
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i] ?? "", curX + PAD, curY + 4, { width: (widths[i] ?? 0) - PAD * 2, lineBreak: false });
    curX += widths[i] ?? 0;
  }
  curY += ROW_H + 2;

  // Data rows
  doc.font("Helvetica").fontSize(7.5);
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const bg = r % 2 === 0 ? C.white : C.bg;
    drawRect(doc, x, curY, totalWidth, ROW_H, bg);
    doc.moveTo(x, curY + ROW_H).lineTo(x + totalWidth, curY + ROW_H).strokeColor(C.border).lineWidth(0.5).stroke();

    curX = x;
    doc.fillColor(C.text);
    for (let i = 0; i < headers.length; i++) {
      const cell = (row[i] ?? "").slice(0, 100);
      doc.text(cell, curX + PAD, curY + 2, { width: (widths[i] ?? 0) - PAD * 2, lineBreak: false });
      curX += widths[i] ?? 0;
    }
    curY += ROW_H;
  }

  return curY;
}

// ── Cover page (consolidated with overview) ───────────────────────────────────

function drawCover(doc: PDFKit.PDFDocument, signals: CliSignals, scoring: ScoringResult) {
  const W = doc.page.width;
  let y = 40;

  // Title + metadata
  doc.fillColor(C.nearBlack).font("Helvetica-Bold").fontSize(22).text("Code Quality Report", 50, y);
  y += 6;
  doc.fillColor(C.muted).font("Helvetica").fontSize(10)
    .text(signals.project_name, 50, y);
  y += 14;

  // Metadata line
  const metadata = [
    `Scanned ${new Date(signals.scanned_at).toLocaleString().split(",")[0]}`,
    `Duration ${signals.scan_duration_ms}ms`,
    `Verdict ${scoring.verdict.replace("_", " ")}`,
  ].filter(Boolean).join(" · ");

  doc.fillColor(C.muted).fontSize(8).text(metadata, 50, y, { lineBreak: false });
  y += 28;

  // Large health score box
  drawRect(doc, 50, y, 120, 80, GRADE_COLOR[scoring.grade], 3);
  doc.fillColor(C.white).font("Helvetica-Bold").fontSize(48).text(scoring.health_score.toString(), 60, y + 12, { lineBreak: false });
  doc.fillColor(C.white).fontSize(12).text("/100", 110, y + 42, { lineBreak: false });
  y += 90;

  // Dimension score boxes (6 boxes in a row)
  const dimOrder: (keyof RepoScores)[] = ["code_quality", "security", "performance", "test_coverage", "readability"];
  const dimLabels: Record<keyof RepoScores, string> = {
    code_quality: "Code quality",
    security: "Security",
    performance: "Performance",
    test_coverage: "Test coverage",
    readability: "Readability",
  };

  const boxW = (W - 100) / 5;
  const boxH = 50;
  let bx = 50;

  for (const dim of dimOrder) {
    const score = scoring.scores[dim].score;
    const color = scoreColor(score);
    drawRect(doc, bx, y, boxW - 4, boxH, color, 2);
    doc.fillColor(C.white).font("Helvetica-Bold").fontSize(14)
      .text(score.toFixed(1), bx + 6, y + 14, { lineBreak: false });
    doc.fillColor(C.white).fontSize(8)
      .text(dimLabels[dim], bx + 6, y + 33, { width: boxW - 12, lineBreak: false });
    bx += boxW;
  }
  y += boxH + 20;

  // Quick summary stats
  const summaryLines = [
    `FILES  Total ${signals.total_files} • Source ${signals.source_files} • Tests ${signals.test_files} • Docs ${signals.doc_files}`,
    `LANGS  ${Object.entries(signals.languages).map(([l, pct]) => `${l} ${(pct * 100).toFixed(0)}%`).join(" • ")}`,
  ];
  doc.fillColor(C.text).font("Helvetica").fontSize(9);
  for (const line of summaryLines) {
    doc.text(line, 50, y, { lineBreak: false });
    y += 11;
  }

  y += 8;

  // Top issues table
  if (y > doc.page.height - 160) { doc.addPage(); y = 40; }

  const topIssues: string[][] = [];
  if (signals.has_secret_files.length > 0) {
    topIssues.push(["CRITICAL", "Security", "Secret files", signals.has_secret_files.slice(0, 2).join(", "), "-0.95"]);
  }
  if (signals.content && signals.content.secret_hits.length > 0) {
    topIssues.push(["CRITICAL", "Security", "Hardcoded secrets", `${signals.content.secret_hits.length} found`, "-0.75"]);
  }
  if (signals.deps && signals.deps.vulnerable.length > 0) {
    topIssues.push(["WARNING", "Security", "Vulnerable deps", signals.deps.vulnerable.slice(0, 2).map(v => v.name).join(", "), "-0.60"]);
  }
  if (signals.test_files === 0) {
    topIssues.push(["WARNING", "Testing", "No tests", "Zero test files found", "-0.50"]);
  }

  if (topIssues.length > 0) {
    doc.fillColor(C.danger).font("Helvetica-Bold").fontSize(11).text("Top issues", 50, y);
    y += 14;
    y = drawTable(
      doc,
      ["Severity", "Category", "Scanner", "Finding", "Impact"],
      topIssues,
      50, y, W - 100,
      [60, 70, 80, 290, 50]
    );
    y += 8;
  }

  // Strengths table
  const strengths: string[][] = [];
  if (signals.has_readme) strengths.push(["Quality", "Documentation", "README present", "+0.25"]);
  if (signals.has_lockfile) strengths.push(["Quality", "Dependencies", "Lockfile present", "+0.30"]);
  if (signals.has_ci_gitlab || signals.has_ci_github) strengths.push(["Quality", "Process", "CI/CD configured", "+0.25"]);
  if (signals.has_typescript_config) strengths.push(["Quality", "Typing", "TypeScript configured", "+0.20"]);

  if (strengths.length > 0) {
    doc.fillColor(C.success).font("Helvetica-Bold").fontSize(11).text("Strengths", 50, y);
    y += 14;
    y = drawTable(
      doc,
      ["Category", "Scanner", "Finding", "Impact"],
      strengths,
      50, y, W - 100,
      [90, 110, 240, 50]
    );
  }
}

// ── Findings page ─────────────────────────────────────────────────────────────

function drawFindings(doc: PDFKit.PDFDocument, signals: CliSignals) {
  const W = doc.page.width;
  const y_start = 50;
  let y = y_start;

  // Only render if there are critical findings
  const findings: string[][] = [];
  if (signals.content && signals.content.secret_hits.length > 0) {
    const hits = signals.content.secret_hits.slice(0, 5);
    for (const h of hits) {
      findings.push([h.file, h.line.toString(), h.snippet.slice(0, 40)]);
    }
  }

  if (signals.routes && signals.routes.routes.length > 0) {
    const unauthed = signals.routes.routes.filter(r => !r.has_auth).slice(0, 8);
    for (const r of unauthed) {
      findings.push([r.method, r.path, r.file]);
    }
  }

  if (findings.length > 0) {
    doc.addPage();
    y = y_start;
    drawRect(doc, 0, 0, W, 5, C.danger);
    doc.fillColor(C.nearBlack).font("Helvetica-Bold").fontSize(16).text("Detailed Findings", 50, y);
    y += 24;
    y = drawTable(doc, ["File/Method", "Line/Path", "Details"], findings, 50, y, W - 100, [220, 120, W - 370]);
  }
}

// ── FRD Coverage ───────────────────────────────────────────────────────────────

function drawFrdCoverage(doc: PDFKit.PDFDocument, frd: FrdSection[]) {
  if (frd.length === 0) return;

  const W = doc.page.width;
  let y = 50;

  if (y > doc.page.height - 150) { doc.addPage(); y = 50; }

  drawRect(doc, 0, 0, W, 5, "#7C3AED");
  doc.fillColor(C.nearBlack).font("Helvetica-Bold").fontSize(14).text("FRD Coverage", 50, y);
  y += 16;

  const covered = frd.filter((s) => s.covered).length;
  const covPct = frd.length > 0 ? Math.round((covered / frd.length) * 100) : 0;

  doc.fillColor(C.muted).font("Helvetica").fontSize(8.5)
    .text(`${covered} of ${frd.length} sections covered (${covPct}%)`, 50, y);
  y += 12;

  // Show only uncovered sections in a compact list
  const uncovered = frd.filter((s) => !s.covered).slice(0, 25);

  if (uncovered.length > 0) {
    doc.fillColor(C.text).font("Helvetica-Bold").fontSize(9).text("Missing coverage:", 50, y);
    y += 11;

    for (const s of uncovered) {
      if (y > doc.page.height - 40) { doc.addPage(); y = 50; }
      doc.fillColor(C.danger).font("Helvetica").fontSize(8)
        .text(`  • ${s.heading.slice(0, 60)}`, 50, y, { lineBreak: false });
      y += 9;
    }
  }

  if (frd.length > covered + 25) {
    y += 4;
    doc.fillColor(C.muted).font("Helvetica").fontSize(8)
      .text(`(${frd.length - covered - uncovered.length} more missing sections not shown)`, 50, y);
  }
}

// ── Recommendations ───────────────────────────────────────────────────────────

function drawRecommendations(doc: PDFKit.PDFDocument, signals: CliSignals, scoring: ScoringResult) {
  doc.addPage();
  const W = doc.page.width;
  let y = 50;

  drawRect(doc, 0, 0, W, 5, C.primary);
  doc.fillColor(C.nearBlack).font("Helvetica-Bold").fontSize(16).text("Recommendations", 50, y);
  y += 24;

  const recs: Array<{ priority: "critical" | "high" | "medium"; text: string }> = [];

  if (signals.has_secret_files.length > 0) {
    recs.push({ priority: "critical", text: "Remove committed secret files" });
  }
  if (signals.content && signals.content.secret_hits.length > 0) {
    recs.push({ priority: "critical", text: "Move hardcoded credentials to env vars" });
  }
  if (signals.deps && signals.deps.vulnerable.length > 0) {
    recs.push({ priority: "high", text: `Update ${signals.deps.vulnerable.length} vulnerable dependencies` });
  }
  if (signals.test_files === 0) {
    recs.push({ priority: "high", text: "Add a test suite" });
  }
  if (!signals.has_ci_gitlab && !signals.has_ci_github) {
    recs.push({ priority: "high", text: "Set up CI/CD pipeline" });
  }
  if (!signals.has_typescript_config && Object.keys(signals.languages).includes("JavaScript")) {
    recs.push({ priority: "medium", text: "Migrate to TypeScript" });
  }

  const sorted = [
    ...recs.filter((r) => r.priority === "critical"),
    ...recs.filter((r) => r.priority === "high"),
    ...recs.filter((r) => r.priority === "medium"),
  ].slice(0, 10);

  const rows = sorted.map((rec) => [
    rec.priority.toUpperCase(),
    rec.text,
  ]);

  y = drawTable(doc, ["Priority", "Action"], rows, 50, y, W - 100, [80, W - 180]);
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
      margins: { top: 40, bottom: 30, left: 50, right: 50 },
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
    drawFindings(doc, signals);
    if (frd.length > 0) drawFrdCoverage(doc, frd);
    drawRecommendations(doc, signals, scoring);

    // Footer on all pages
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.fillColor(C.muted).font("Helvetica").fontSize(7)
        .text(
          `${signals.project_name} • Page ${i + 1} of ${range.count}`,
          50,
          doc.page.height - 20,
          { width: doc.page.width - 100, align: "center", lineBreak: false }
        );
    }

    doc.end();
  });
}
