/**
 * CLI PDF Export — Generates the exact same 27-page PDF as mr-analyzer UI
 *
 * All rendering code copied directly from mr-analyzer to ensure
 * 100% identical content and layout.
 */

import type {
  ProjectAttribute,
  ProjectScanSummary,
  ArchitectureRichSignals,
  ModuleRichRow,
  DocRichSignals,
  VulnRichSignals,
  ContentRichSignals,
  AstRichSignals,
} from "./lib/scanners-export";
import { buildProjectScanSummary } from "./lib/scanners-export";
import { getFixHint, type FixHintSeverity } from "./lib/scanner-fix-hints";
import type { SignalCategory, ScannerName } from "./lib/types";

type jsPDFDoc = InstanceType<(typeof import("jspdf"))["jsPDF"]>;

export async function generatePdf(
  signals: any,
  scoring: any,
  languages?: Record<string, number>
): Promise<Buffer> {
  const [{ jsPDF }, autoTableMod] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);

  const autoTable = (
    autoTableMod as any
  ).default ?? autoTableMod;

  const rawSignals = {
    project_id: 0,
    project_path: signals.project_path || "unknown",
    health_score: scoring.health_score,
    grade: scoring.grade,
    worst_dimension: scoring.worst_dimension,
    code_quality: scoring.scores?.code_quality?.score,
    security: scoring.scores?.security?.score,
    performance: scoring.scores?.performance?.score,
    test_coverage: scoring.scores?.test_coverage?.score,
    readability: scoring.scores?.readability?.score,
    scanned_at: signals.scanned_at,
    scan_duration_ms: signals.scan_duration_ms,
    default_branch: signals.default_branch,
    ref: signals.ref,
    commit_sha: signals.commit_sha,
    total_files: signals.total_files,
    source_files: signals.source_files,
    test_files: signals.test_files,
    doc_files: signals.doc_files,
    config_files: signals.config_files,
  };

  const factorsPayload = {
    dimensions: scoring.scores,
    verdict: scoring.verdict,
    warnings: scoring.warnings || [],
    signals: {
      content: signals.content,
      vulns: signals.vulns,
      ast: signals.ast,
      docs: signals.docs,
      architecture: signals.architecture,
      modules: signals.modules,
      frameworks: signals.frameworks,
    },
  };

  const proj = buildProjectScanSummary(
    0,
    rawSignals,
    factorsPayload,
    languages || {}
  );

  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" }) as any;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const projectTitle = proj.project_path || `project #${proj.project_id}`;

  const attributes: ProjectAttribute[] = scoring.attributes ? [...scoring.attributes] : [];
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

  // File census strip
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

  // Languages strip
  if (proj.languages && Object.keys(proj.languages).length > 0) {
    const langLineY = fileLineY + 14;
    const totalLangFiles = Object.values(proj.languages || {}).reduce(
      (s: number, n: any) => s + (typeof n === "number" ? n : 0),
      0
    );
    const top = Object.entries(proj.languages || {})
      .sort((a: any, b: any) => (b[1] || 0) - (a[1] || 0))
      .slice(0, 4)
      .map(([k, v]: any) => {
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
      didParseCell: (data: any) => {
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
      didParseCell: (data: any) => {
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

  // ── Methodology card ─
  if (cursor < pageHeight - 140) {
    drawMethodologyBox(doc, 40, cursor, pageWidth - 80);
  } else {
    doc.addPage();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(15, 23, 42);
    doc.text("Methodology", 40, 36);
    doc.setTextColor(0);
    drawMethodologyBox(doc, 40, 56, pageWidth - 80);
  }

  // ── Rich detail sections ──────────────────────────────────────────
  renderProjectDetailsPage(doc, autoTable, proj, pageWidth, pageHeight, projectTitle);
  if (proj.architecture && proj.architecture.has_doc) {
    renderArchitecturePage(doc, autoTable, proj.architecture, pageWidth, pageHeight, projectTitle);
  }
  if (proj.modules && proj.modules.length > 0) {
    renderModulesPage(doc, autoTable, proj.modules, proj.frameworks ?? null, pageWidth, pageHeight, projectTitle);
  }
  if (proj.docs) {
    renderDocsPage(doc, autoTable, proj.docs, pageWidth, pageHeight, projectTitle);
  }
  if (proj.vulns) {
    renderVulnsPage(doc, autoTable, proj.vulns, pageWidth, pageHeight, projectTitle);
  }
  if (proj.content) {
    renderContentFindingsPage(doc, autoTable, proj.content, pageWidth, pageHeight, projectTitle);
  }
  if (proj.ast && proj.ast.total_functions > 0) {
    renderAstPage(doc, autoTable, proj.ast, pageWidth, pageHeight, projectTitle);
  }
  if (proj.factor_breakdown && Object.keys(proj.factor_breakdown).length > 0) {
    renderFactorBreakdownPage(doc, autoTable, proj.factor_breakdown, pageWidth, pageHeight, projectTitle);
  }

  // ── Per-category sections ─────────────────────────────────────────
  const byCategory = new Map<SignalCategory, ProjectAttribute[]>();
  for (const a of sorted) {
    if (!byCategory.has(a.category)) byCategory.set(a.category, []);
    byCategory.get(a.category)!.push(a);
  }

  const orderedCategories = CATEGORY_ORDER.filter((c) => byCategory.has(c)).sort((a, b) => {
    const sa = byCategory.get(a)!.reduce((s, x) => s + x.delta_to_score, 0);
    const sb = byCategory.get(b)!.reduce((s, x) => s + x.delta_to_score, 0);
    return sa - sb;
  });

  for (const cat of orderedCategories) {
    const items = byCategory.get(cat)!;
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
        didParseCell: (data: any) => {
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

  // Cover page footer
  doc.setPage(1);
  setFooter(doc, pageWidth, pageHeight, projectTitle);

  const pdfBuffer = doc.output("arraybuffer");
  return Buffer.from(pdfBuffer);
}

// ─── Constants (from mr-analyzer) ────────────────────────────────────

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

const DIMENSIONS: Array<{
  key: keyof NonNullable<ProjectScanSummary["scores"]>;
  label: string;
}> = [
  { key: "code_quality", label: "Code quality" },
  { key: "security", label: "Security" },
  { key: "performance", label: "Performance" },
  { key: "test_coverage", label: "Test coverage" },
  { key: "readability", label: "Readability" },
];

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

const METHODOLOGY_LINES = [
  "Each project earns 5 dimension scores (0-10): Code quality, Security, Performance, Test coverage, Readability.",
  "Dimensions start at a neutral base near 6.5 and shift up/down per detected signal. Final values are clamped to 0..10 — they never go negative.",
  "A finding's 'Score impact' is how much it shifts ONE dimension on ONE project. Negative means the project lost points, positive means it gained.",
  "Health (0-100) = average dimension * 10, minus a few global penalties (committed secrets, no CI, critical CVEs). Capped at 0 and 100.",
  "Grade is derived from the average dimension: A>=8.0, B>=6.5, C>=5.0, D>=3.5, otherwise F.",
  "In the portfolio rollup, 'Score impact' is summed across every project that triggered the finding. A large negative number means many projects share the same issue.",
];

const KV_TABLE_STYLES: any = {
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

// Helper functions

function formatDate(epochMs: number | null | undefined): string {
  if (!epochMs) return "—";
  return new Date(epochMs).toISOString().slice(0, 16).replace("T", " ");
}

function expandEvidence(evidence: unknown, opts: { maxLineChars?: number } = {}): string {
  const maxLine = opts.maxLineChars ?? 240;
  if (evidence == null) return "";

  const trimLine = (s: string) => {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > maxLine ? flat.slice(0, maxLine - 1).trimEnd() + "…" : flat;
  };

  if (typeof evidence === "string") {
    if (!evidence) return "";
    try {
      const parsed = JSON.parse(evidence);
      if (typeof parsed !== "string") return expandEvidence(parsed, opts);
    } catch {
      /**/
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

function summariseEvidence(evidence: unknown, maxItems = 12): string {
  if (evidence == null) return "";
  if (typeof evidence === "string") {
    if (!evidence) return "";
    try {
      const parsed = JSON.parse(evidence);
      if (typeof parsed !== "string") return summariseEvidence(parsed, maxItems);
    } catch {
      /**/
    }
    return evidence;
  }
  if (Array.isArray(evidence)) {
    if (evidence.length === 0) return "";
    const items = evidence.slice(0, maxItems).map((it) => (typeof it === "string" ? it : JSON.stringify(it)));
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

function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}

function applyTone(data: any, tone: Tone): void {
  const styles = data?.cell?.styles;
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

function effectiveSeverity(
  scanner: string,
  attributeKey: string,
  delta: number
): { label: string; tone: Tone } {
  if (delta > 0.05) return { label: "STRENGTH", tone: "good" };
  const hint = getFixHint(scanner, attributeKey);
  return { label: SEVERITY_LABEL[hint.severity] || "UNKNOWN", tone: SEVERITY_TONE[hint.severity] || "info" };
}

function gradeColor(grade: string | null): [number, number, number] {
  const g = (grade ?? "").toUpperCase();
  if (g === "A") return [16, 185, 129];
  if (g === "B") return [34, 197, 94];
  if (g === "C") return [234, 179, 8];
  if (g === "D") return [249, 115, 22];
  return [239, 68, 68];
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

function topN<T>(items: T[], n: number, compare: (a: T, b: T) => number): T[] {
  return [...items].sort(compare).slice(0, n);
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

function categoryRank(c: SignalCategory): number {
  const i = CATEGORY_ORDER.indexOf(c);
  return i === -1 ? 99 : i;
}

function scannerRank(s: ScannerName): number {
  const i = SCANNER_ORDER.indexOf(s);
  return i === -1 ? 99 : i;
}

function verdictLabel(v: string | null | undefined): string {
  if (v === "healthy") return "Healthy";
  if (v === "needs_attention") return "Needs attention";
  if (v === "at_risk") return "At risk";
  return "—";
}

function vulnSeverityTone(sev: string): Tone {
  const s = (sev || "").toLowerCase();
  if (s === "critical" || s === "high") return "bad";
  if (s === "medium") return "warn";
  return "info";
}

function drawHealthHero(doc: any, x: number, y: number, w: number, h: number, health: number | null, grade: string | null) {
  const [r, g, b] = healthColor(health);
  doc.setFillColor(r, g, b);
  doc.roundedRect(x, y, w, h, 6, 6, "F");
  doc.setTextColor(255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("HEALTH", x + 14, y + 18);
  doc.setFontSize(40);
  doc.text(health == null ? "—" : Math.round(health).toString(), x + 14, y + h - 14);
  doc.setFontSize(11);
  doc.text("/100", x + 14 + (health == null ? 26 : 60), y + h - 14);

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

function drawDimensionCard(doc: any, x: number, y: number, w: number, h: number, label: string, score: number | null) {
  const [r, g, b] = dimensionColor(score);
  doc.setFillColor(r, g, b);
  doc.setDrawColor(r, g, b);
  doc.roundedRect(x, y, w, h, 4, 4, "FD");
  doc.setTextColor(255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text(label, x + w / 2, y + 14, { align: "center" });
  doc.setFontSize(20);
  doc.text(score == null ? "—" : score.toFixed(1), x + w / 2, y + h - 10, { align: "center" });
  doc.setTextColor(0);
}

function drawMethodologyBox(doc: any, x: number, y: number, width: number): number {
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

function setFooter(doc: any, pageWidth: number, pageHeight: number, projectTitle: string) {
  const pageCount = doc.getNumberOfPages();
  const current = doc.getCurrentPageInfo().pageNumber;
  doc.setFontSize(8);
  doc.setTextColor(140);
  doc.text(`${projectTitle}  ·  Page ${current} of ${pageCount}`, pageWidth - 40, pageHeight - 20, { align: "right" });
  doc.setTextColor(0);
}

function startSectionPage(doc: any, pageWidth: number, title: string, subtitle?: string): number {
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

function drawSubSectionTitle(doc: any, x: number, y: number, title: string): number {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(51, 65, 85);
  doc.text(title, x, y);
  doc.setTextColor(0);
  return y + 14;
}

function lastTableY(doc: any, fallback: number): number {
  const last = (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable;
  return last?.finalY ?? fallback;
}

function trimEvidence(s: string, maxChars = 220): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 1).trimEnd() + "…";
}

function renderProjectDetailsPage(doc: any, autoTable: any, proj: ProjectScanSummary, pageWidth: number, pageHeight: number, projectTitle: string): void {
  let cursor = startSectionPage(doc, pageWidth, "Project details", "Scan metadata, file census and languages — full mirror of the UI's header strip.");
  const meta: Array<[string, string]> = [
    ["Project path", proj.project_path],
    ["Group", proj.group_path ?? "—"],
    ["Project ID", String(proj.project_id)],
    ["Scanned at", formatDate(proj.last_scanned_at)],
    ["Scan duration", proj.scan_duration_ms != null ? `${(proj.scan_duration_ms / 1000).toFixed(2)} s` : "—"],
    ["Default branch", proj.default_branch ?? "—"],
    ["Ref", proj.ref ?? "—"],
    ["Commit SHA", proj.commit_sha ? proj.commit_sha.slice(0, 12) : "—"],
    ["Verdict", verdictLabel(proj.verdict)],
    ["Worst dimension", proj.worst_dimension ?? "—"],
  ];
  cursor = drawSubSectionTitle(doc, 40, cursor, "Scan metadata");
  autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["Field", "Value"]], body: meta, columnStyles: { 0: { cellWidth: 160 }, 1: { cellWidth: "auto" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle) });
  cursor = lastTableY(doc, cursor) + 18;
  if (cursor > pageHeight - 160) { doc.addPage(); cursor = 40; }
  cursor = drawSubSectionTitle(doc, 40, cursor, "File census");
  const total = proj.total_files ?? 0;
  const bucketRow = (label: string, n: number | null | undefined) => {
    const v = n ?? 0;
    const pct = total > 0 ? Math.round((v / total) * 100) : 0;
    return [label, String(v), total > 0 ? `${pct}%` : "—"];
  };
  autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["Bucket", "Count", "Share of total"]], body: [["Total", String(total), "100%"], bucketRow("Source", proj.source_files), bucketRow("Test", proj.test_files), bucketRow("Doc", proj.doc_files), bucketRow("Config", proj.config_files)], columnStyles: { 0: { cellWidth: 160 }, 1: { cellWidth: 100, halign: "right" }, 2: { cellWidth: 140, halign: "right" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle) });
  cursor = lastTableY(doc, cursor) + 18;
  if (proj.languages && Object.keys(proj.languages).length > 0) {
    if (cursor > pageHeight - 160) { doc.addPage(); cursor = 40; }
    cursor = drawSubSectionTitle(doc, 40, cursor, "Languages");
    const totalLang = Object.values(proj.languages || {}).reduce((s: number, n: any) => s + (typeof n === "number" ? n : 0), 0);
    const langRows = Object.entries(proj.languages || {}).sort((a: any, b: any) => b[1] - a[1]).map(([lang, n]: any) => [lang, String(n), totalLang > 0 ? `${Math.round((n / totalLang) * 100)}%` : "—"]);
    autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["Language", "Files", "Share"]], body: langRows, columnStyles: { 0: { cellWidth: 200 }, 1: { cellWidth: 100, halign: "right" }, 2: { cellWidth: 100, halign: "right" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle) });
    cursor = lastTableY(doc, cursor) + 18;
  }
  if (proj.warnings && proj.warnings.length > 0) {
    if (cursor > pageHeight - 140) { doc.addPage(); cursor = 40; }
    cursor = drawSubSectionTitle(doc, 40, cursor, "Scan warnings");
    autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["#", "Warning"]], body: proj.warnings.map((w: any, i: number) => [String(i + 1), w]), columnStyles: { 0: { cellWidth: 36, halign: "right" }, 1: { cellWidth: "auto" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle) });
  }
}

function renderArchitecturePage(doc: any, autoTable: any, arch: ArchitectureRichSignals, pageWidth: number, pageHeight: number, projectTitle: string): void {
  if (!arch.has_doc) return;
  let cursor = startSectionPage(doc, pageWidth, "Architecture compliance", `Compliance ${arch.compliance_pct.toFixed(0)}%  ·  declared apps ${arch.declared_apps.length}  ·  layout match ${arch.layout.match_pct.toFixed(0)}%  ·  stack match ${arch.stack.match_pct.toFixed(0)}%`);
  cursor = drawSubSectionTitle(doc, 40, cursor, "Summary");
  autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["Field", "Value"]], body: [["Doc path", arch.doc_path ?? "—"], ["Doc word count", String(arch.doc_word_count ?? "—")], ["Compliance %", `${arch.compliance_pct.toFixed(0)}%`], ["Declared apps", arch.declared_apps.join(", ") || "—"], ["Apps present", arch.apps_present.join(", ") || "—"], ["Apps missing", arch.apps_missing.join(", ") || "—"], ["Layout paths matched", `${arch.layout.matched_paths} / ${arch.layout.total_paths} (${arch.layout.match_pct.toFixed(0)}%)`], ["Stack libs matched", `${arch.stack.matched_libs} / ${arch.stack.total_libs} (${arch.stack.match_pct.toFixed(0)}%)`]], columnStyles: { 0: { cellWidth: 220 }, 1: { cellWidth: "auto" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle) });
  cursor = lastTableY(doc, cursor) + 18;
  if (arch.convention_rules.length > 0) {
    if (cursor > pageHeight - 140) { doc.addPage(); cursor = 40; }
    cursor = drawSubSectionTitle(doc, 40, cursor, `Convention rules (${arch.convention_rules.length})`);
    autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["Type", "Rule"]], body: arch.convention_rules.map((r: any) => [r.type, r.raw]), columnStyles: { 0: { cellWidth: 160 }, 1: { cellWidth: "auto" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle) });
  }
}

function renderModulesPage(doc: any, autoTable: any, modules: ModuleRichRow[], frameworks: string[] | null | undefined, pageWidth: number, pageHeight: number, projectTitle: string): void {
  if (!modules || modules.length === 0) return;
  const subtitle = `${modules.length} module${modules.length === 1 ? "" : "s"}${frameworks && frameworks.length > 0 ? `  ·  Frameworks: ${frameworks.slice(0, 8).join(", ")}` : ""}`;
  const cursor = startSectionPage(doc, pageWidth, "Modules & frameworks", subtitle);
  autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["#", "Path", "Label", "Kind", "Framework"]], body: modules.map((m, i) => [String(i + 1), m.path, m.label, m.kind, m.framework ?? "—"]), columnStyles: { 0: { cellWidth: 36, halign: "right" }, 1: { cellWidth: 240 }, 2: { cellWidth: 140 }, 3: { cellWidth: 100 }, 4: { cellWidth: "auto" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle) });
}

function renderDocsPage(doc: any, autoTable: any, docs: DocRichSignals, pageWidth: number, pageHeight: number, projectTitle: string): void {
  if (docs.total_md_files === 0 && !docs.has_docs_dir && !docs.has_architecture_doc && !docs.has_api_doc) return;
  let cursor = startSectionPage(doc, pageWidth, "Documentation", `${docs.total_md_files} markdown file${docs.total_md_files === 1 ? "" : "s"}  ·  ${docs.total_words.toLocaleString()} words`);
  cursor = drawSubSectionTitle(doc, 40, cursor, "Summary");
  autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["Field", "Value"]], body: [["Total markdown files", String(docs.total_md_files)], ["Total words", docs.total_words.toLocaleString()], ["Has /docs directory", docs.has_docs_dir ? "Yes" : "No"], ["Files in /docs", String(docs.files_in_docs_dir)], ["Has architecture doc", docs.has_architecture_doc ? "Yes" : "No"], ["Has API doc", docs.has_api_doc ? "Yes" : "No"]], columnStyles: { 0: { cellWidth: 220 }, 1: { cellWidth: "auto" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle) });
  cursor = lastTableY(doc, cursor) + 18;
  const sectionLabels: Array<[keyof NonNullable<DocRichSignals["sections"]>, string]> = [["setup", "Setup / Getting started"], ["usage", "Usage / Examples"], ["test", "Testing"], ["deploy", "Deploy / Operations"], ["api", "API reference"], ["architecture", "Architecture"], ["contributing", "Contributing"], ["changelog", "Changelog"], ["troubleshooting", "Troubleshooting"], ["faq", "FAQ"]];
  if (cursor > pageHeight - 140) { doc.addPage(); cursor = 40; }
  cursor = drawSubSectionTitle(doc, 40, cursor, "Sections checklist");
  autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["Section", "Present"]], body: sectionLabels.map(([k, label]) => [label, docs.sections[k] ? "Yes" : "No"]), columnStyles: { 0: { cellWidth: 240 }, 1: { cellWidth: 100, halign: "center" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle), didParseCell: (data: any) => { if (data.section !== "body") return; if (data.column.index === 1) { applyTone(data, String(data.cell.raw) === "Yes" ? "good" : "warn"); } } });
}

function renderVulnsPage(doc: any, autoTable: any, vulns: VulnRichSignals, pageWidth: number, pageHeight: number, projectTitle: string): void {
  if (vulns.total_resolved === 0 && vulns.findings.length === 0 && vulns.lockfiles.length === 0) return;
  let cursor = startSectionPage(doc, pageWidth, "Vulnerabilities", `${vulns.total_resolved.toLocaleString()} resolved package${vulns.total_resolved === 1 ? "" : "s"}  ·  ${vulns.findings.length} finding${vulns.findings.length === 1 ? "" : "s"}  ·  ${vulns.lockfiles.length} lockfile${vulns.lockfiles.length === 1 ? "" : "s"}`);
  cursor = drawSubSectionTitle(doc, 40, cursor, "Severity totals");
  autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["Severity", "Count"]], body: [["Critical", String(vulns.totals.critical)], ["High", String(vulns.totals.high)], ["Medium", String(vulns.totals.medium)], ["Low", String(vulns.totals.low)]], columnStyles: { 0: { cellWidth: 160 }, 1: { cellWidth: 120, halign: "right" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle), didParseCell: (data: any) => { if (data.section !== "body" || data.column.index !== 0) return; applyTone(data, vulnSeverityTone(String(data.cell.raw).toLowerCase())); } });
  cursor = lastTableY(doc, cursor) + 18;
  if (vulns.lockfiles.length > 0) {
    if (cursor > pageHeight - 140) { doc.addPage(); cursor = 40; }
    cursor = drawSubSectionTitle(doc, 40, cursor, "Lockfiles parsed");
    autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["Ecosystem", "Lockfile", "Packages"]], body: vulns.lockfiles.map((l: any) => [l.ecosystem, l.lockfile, String(l.package_count)]), columnStyles: { 0: { cellWidth: 100 }, 1: { cellWidth: "auto" }, 2: { cellWidth: 100, halign: "right" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle) });
    cursor = lastTableY(doc, cursor) + 18;
  }
  if (vulns.findings.length > 0) {
    if (cursor > pageHeight - 160) { doc.addPage(); cursor = 40; }
    cursor = drawSubSectionTitle(doc, 40, cursor, `Findings (${vulns.findings.length})`);
    autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["Severity", "Package", "Version", "Ecosystem", "Advisory", "Range", "Summary"]], body: vulns.findings.map((f: any) => [f.advisory.severity, f.package, f.version, f.ecosystem, f.advisory.id, f.advisory.range, f.advisory.summary]), columnStyles: { 0: { cellWidth: 60, halign: "center" }, 1: { cellWidth: 130 }, 2: { cellWidth: 70 }, 3: { cellWidth: 70 }, 4: { cellWidth: 110 }, 5: { cellWidth: 90 }, 6: { cellWidth: "auto" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle), didParseCell: (data: any) => { if (data.section !== "body" || data.column.index !== 0) return; applyTone(data, vulnSeverityTone(String(data.cell.raw).toLowerCase())); } });
  }
}

function renderContentFindingsPage(doc: any, autoTable: any, content: ContentRichSignals, pageWidth: number, pageHeight: number, projectTitle: string): void {
  if (content.hits.length === 0 && content.longest_files.length === 0 && content.totals.critical === 0 && content.totals.warning === 0 && content.totals.suggestion === 0) return;
  let cursor = startSectionPage(doc, pageWidth, "Content scan", `${content.hits.length} hit${content.hits.length === 1 ? "" : "s"}  ·  ${content.totals.critical} critical / ${content.totals.warning} warning / ${content.totals.suggestion} suggestion  ·  ${content.files_scanned} files scanned`);
  cursor = drawSubSectionTitle(doc, 40, cursor, "LOC distribution");
  autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["Metric", "Value"]], body: [["Total lines of code", content.loc.total.toLocaleString()], ["Median file LOC", String(content.loc.median)], ["P95 file LOC", String(content.loc.p95)], ["Very long files (>500 LOC)", String(content.loc.very_long)], ["Files scanned", String(content.files_scanned)]], columnStyles: { 0: { cellWidth: 240 }, 1: { cellWidth: 160, halign: "right" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle) });
  cursor = lastTableY(doc, cursor) + 18;
  const byRule = Object.entries(content.totals.by_rule as any).sort((a: any, b: any) => b[1] - a[1]);
  if (byRule.length > 0) {
    if (cursor > pageHeight - 160) { doc.addPage(); cursor = 40; }
    cursor = drawSubSectionTitle(doc, 40, cursor, `Hits by rule (${byRule.length})`);
    autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["Rule", "Count"]], body: byRule.map(([r, n]) => [r, String(n)]), columnStyles: { 0: { cellWidth: 320 }, 1: { cellWidth: 100, halign: "right" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle) });
    cursor = lastTableY(doc, cursor) + 18;
  }
  if (content.hits.length > 0) {
    if (cursor > pageHeight - 160) { doc.addPage(); cursor = 40; }
    cursor = drawSubSectionTitle(doc, 40, cursor, `Findings (${content.hits.length})`);
    autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["Severity", "File", "Line", "Title", "Evidence"]], body: content.hits.map((h: any) => [h.severity, h.file, String(h.line), h.title, trimEvidence(h.evidence, 300)]), styles: { fontSize: 8.5, cellPadding: 4, overflow: "linebreak", valign: "top" }, columnStyles: { 0: { cellWidth: 60, halign: "center" }, 1: { cellWidth: 200 }, 2: { cellWidth: 40, halign: "right" }, 3: { cellWidth: 200 }, 4: { cellWidth: "auto" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle), didParseCell: (data: any) => { if (data.section !== "body" || data.column.index !== 0) return; const sev = String(data.cell.raw).toLowerCase(); applyTone(data, sev === "critical" ? "bad" : sev === "warning" ? "warn" : "info"); } });
    cursor = lastTableY(doc, cursor) + 18;
  }
  if (content.longest_files.length > 0) {
    if (cursor > pageHeight - 160) { doc.addPage(); cursor = 40; }
    cursor = drawSubSectionTitle(doc, 40, cursor, `Longest files (${content.longest_files.length})`);
    autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["#", "File", "Lines"]], body: content.longest_files.map((f: any, i: number) => [String(i + 1), f.file, String(f.lines)]), columnStyles: { 0: { cellWidth: 36, halign: "right" }, 1: { cellWidth: "auto" }, 2: { cellWidth: 80, halign: "right" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle) });
  }
}

function renderAstPage(doc: any, autoTable: any, ast: AstRichSignals, pageWidth: number, pageHeight: number, projectTitle: string): void {
  if (ast.total_functions === 0) return;
  let cursor = startSectionPage(doc, pageWidth, "Functions & complexity", `${ast.total_functions.toLocaleString()} function${ast.total_functions === 1 ? "" : "s"} across ${ast.total_files_parsed.toLocaleString()} parsed file${ast.total_files_parsed === 1 ? "" : "s"}  ·  ${ast.doc_coverage_pct.toFixed(0)}% docs coverage on exports`);
  cursor = drawSubSectionTitle(doc, 40, cursor, "Aggregate metrics");
  autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["Metric", "Value"]], body: [["Total functions", ast.total_functions.toLocaleString()], ["Files parsed", ast.total_files_parsed.toLocaleString()], ["Files skipped", ast.total_files_skipped.toLocaleString()], ["Median complexity", String(ast.median_complexity)], ["P95 complexity", String(ast.p95_complexity)], ["Max complexity", String(ast.max_complexity)], ["Median function LOC", String(ast.median_function_loc)], ["P95 function LOC", String(ast.p95_function_loc)], ["God functions (very complex)", String(ast.god_functions)], ["Long functions", String(ast.long_functions)], ["High-param functions", String(ast.high_param_functions)], ["Deeply nested functions", String(ast.deeply_nested_functions)], ["God files", String(ast.god_files)], ["Exported functions", String(ast.exported_function_count)], ["Documented exports", String(ast.documented_export_count)], ["Doc coverage", `${ast.doc_coverage_pct.toFixed(1)}%`], ["Untested complex functions", String(ast.untested_complex_functions)]], columnStyles: { 0: { cellWidth: 280 }, 1: { cellWidth: 160, halign: "right" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle) });
  cursor = lastTableY(doc, cursor) + 18;
  const fns = ast.functions ?? [];
  if (fns.length > 0) {
    if (cursor > pageHeight - 160) { doc.addPage(); cursor = 40; }
    const cap = 40;
    const ranked = [...fns].sort((a, b) => b.complexity - a.complexity || b.loc - a.loc).slice(0, cap);
    cursor = drawSubSectionTitle(doc, 40, cursor, `Top functions by complexity${fns.length > cap ? ` (showing ${cap} of ${fns.length})` : ` (${fns.length})`}`);
    autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["Cx", "Function", "File", "Lines", "LOC", "Params", "Nest", "Flags"]], body: ranked.map((fn) => { const flags: string[] = []; if (fn.is_exported) flags.push("export"); if (fn.is_exported && !fn.has_doc_comment) flags.push("no docs"); if (fn.is_untested && fn.is_exported && fn.complexity >= 10) flags.push("untested"); return [String(fn.complexity), fn.name, fn.file, `${fn.start_line}-${fn.end_line}`, String(fn.loc), String(fn.params), String(fn.max_nesting), flags.join(", ") || "—"]; }), styles: { fontSize: 8.5, cellPadding: 4, overflow: "linebreak", valign: "top" }, columnStyles: { 0: { cellWidth: 40, halign: "right" }, 1: { cellWidth: 160 }, 2: { cellWidth: 220 }, 3: { cellWidth: 70, halign: "right" }, 4: { cellWidth: 50, halign: "right" }, 5: { cellWidth: 50, halign: "right" }, 6: { cellWidth: 40, halign: "right" }, 7: { cellWidth: "auto" } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle), didParseCell: (data: any) => { if (data.section !== "body" || data.column.index !== 0) return; const cx = parseFloat(String(data.cell.raw)); if (Number.isFinite(cx)) { applyTone(data, cx >= 20 ? "bad" : cx >= 15 ? "warn" : "info"); } } });
  }
}

function renderFactorBreakdownPage(doc: any, autoTable: any, breakdown: NonNullable<ProjectScanSummary["factor_breakdown"]>, pageWidth: number, pageHeight: number, projectTitle: string): void {
  if (!breakdown) return;
  const dims = (Object.keys(breakdown) as Array<keyof typeof breakdown>).filter((k) => !!breakdown[k]);
  if (dims.length === 0) return;
  let cursor = startSectionPage(doc, pageWidth, "Factor breakdown", "Per-dimension contributions — exactly what 'Show factor breakdown' renders in the project detail page.");
  for (const k of dims) {
    const dim = breakdown[k];
    if (!dim || !dim.factors) continue;
    const label = (DIMENSIONS.find((d) => d.key === k)?.label ?? String(k)) as string;
    if (cursor > pageHeight - 160) { doc.addPage(); cursor = 40; }
    cursor = drawSubSectionTitle(doc, 40, cursor, `${label} — score ${dim.score.toFixed(1)} / 10  ·  ${dim.factors.length} factor${dim.factors.length === 1 ? "" : "s"}`);
    const sortedFactors = [...dim.factors].sort((a, b) => a.delta - b.delta);
    autoTable(doc, { ...KV_TABLE_STYLES, startY: cursor, margin: { left: 40, right: 40 }, head: [["Factor", "Score impact", "Evidence"]], body: sortedFactors.length === 0 ? [["(no factors emitted for this dimension)", "—", ""]] : sortedFactors.map((f) => [f.label, (f.delta >= 0 ? "+" : "") + f.delta.toFixed(2), trimEvidence(f.evidence ?? "", 220)]), columnStyles: { 0: { cellWidth: 240 }, 1: { cellWidth: 80, halign: "right" }, 2: { cellWidth: "auto", textColor: [71, 85, 105] } }, didDrawPage: () => setFooter(doc, pageWidth, pageHeight, projectTitle), didParseCell: (data: any) => { if (data.section !== "body" || data.column.index !== 1) return; const num = parseFloat(String(data.cell.raw)); if (Number.isFinite(num)) applyTone(data, deltaTone(num)); } });
    cursor = lastTableY(doc, cursor) + 18;
  }
}
