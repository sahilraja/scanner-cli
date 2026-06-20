#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { loadConfig, getReportDir } from "../src/config";
import { walkLocalDirectory, getLatestMtime } from "../src/local-walker";
import { runScanners } from "../src/scanners";
import { computeScores } from "../src/scoring";
import { generatePdf } from "../src/pdf-report";
import { parseFrdDirectory } from "../src/frd-parser";
import { resolveRecipients } from "../src/gitlab-members";
import { notify } from "../src/notifier";

// ── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  dir: string;
  watch: boolean;
  ci: boolean;
  once: boolean;
  noNotify: boolean;
  failBelow: number;
  reportDir: string | null;
} {
  const args = argv.slice(2);
  let dir = ".";
  let watch = false;
  let ci = false;
  let once = false;
  let noNotify = false;
  let failBelow = 0;
  let reportDir: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--watch" || a === "-w") { watch = true; once = false; }
    else if (a === "--once") { once = true; watch = false; }
    else if (a === "--ci") { ci = true; once = true; }
    else if (a === "--no-notify") { noNotify = true; }
    else if (a === "--fail-below") { failBelow = parseInt(args[++i] ?? "50", 10); }
    else if (a === "--report-dir") { reportDir = args[++i] ?? null; }
    else if (!a.startsWith("--")) { dir = a; }
  }

  if (!watch && !ci) once = true; // default to --once

  return { dir, watch, ci, once, noNotify, failBelow, reportDir };
}

// ── Core scan ─────────────────────────────────────────────────────────────────

async function runScan(projectDir: string, opts: {
  noNotify: boolean;
  reportDir: string | null;
  ci: boolean;
  failBelow: number;
}): Promise<number> {
  const absDir = path.resolve(projectDir);

  if (!fs.existsSync(absDir)) {
    process.stderr.write(`[scan] Directory not found: ${absDir}\n`);
    return 1;
  }

  const config = loadConfig(absDir);
  const projectName = config.name || path.basename(absDir);
  const reportDir = opts.reportDir
    ? path.resolve(opts.reportDir)
    : getReportDir(absDir, config);

  log(`Scanning ${projectName} (${absDir})`);

  // ── Walk ──────────────────────────────────────────────────────────────────
  const repo = walkLocalDirectory(absDir, config);
  log(`  ${repo.files.length} files found`);

  // ── Scan ──────────────────────────────────────────────────────────────────
  const signals = runScanners(repo, projectName);
  log(`  Scan complete in ${signals.scan_duration_ms}ms`);

  // ── Score ─────────────────────────────────────────────────────────────────
  const scoring = computeScores(signals);
  const { grade, health_score, verdict } = scoring;
  log(`  Health: ${health_score}/100  Grade: ${grade}  Verdict: ${verdict}`);

  // ── FRD ───────────────────────────────────────────────────────────────────
  let frd: import("../src/types").FrdSection[] = [];
  if (config.frd?.dir) {
    frd = parseFrdDirectory(absDir, config.frd.dir, repo);
    const covered = frd.filter((s) => s.covered).length;
    if (frd.length > 0) log(`  FRD: ${covered}/${frd.length} sections covered`);
  }

  // ── PDF ───────────────────────────────────────────────────────────────────
  fs.mkdirSync(reportDir, { recursive: true });
  const pdfBuffer = await generatePdf(signals, scoring, frd);

  const dateStr = new Date(signals.scanned_at).toISOString().slice(0, 10);
  const safeName = projectName.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  const pdfName = `health-report-${safeName}-${dateStr}.pdf`;
  const pdfPath = path.join(reportDir, pdfName);

  // Also write a "latest" symlink-friendly copy
  const latestPath = path.join(reportDir, "health-report.pdf");

  fs.writeFileSync(pdfPath, pdfBuffer);
  fs.writeFileSync(latestPath, pdfBuffer);
  log(`  PDF saved to ${pdfPath}`);

  // ── Notify ────────────────────────────────────────────────────────────────
  if (!opts.noNotify && (opts.ci || !signals.has_ci_gitlab)) {
    const recipients = await resolveRecipients(absDir, config);
    await notify(pdfBuffer, signals, scoring, recipients, config);
  }

  // ── Exit code ─────────────────────────────────────────────────────────────
  const threshold = opts.failBelow || config.scan?.failBelow || 0;
  if (threshold > 0 && health_score < threshold) {
    process.stderr.write(`[scan] Health score ${health_score} is below threshold ${threshold}\n`);
    return 2;
  }

  return 0;
}

// ── Watch mode ────────────────────────────────────────────────────────────────

function runWatch(projectDir: string, opts: {
  noNotify: boolean;
  reportDir: string | null;
  failBelow: number;
}) {
  const absDir = path.resolve(projectDir);
  const config = loadConfig(absDir);
  const exclude = new Set([
    "node_modules", "dist", "build", ".git", ".next", "coverage",
    ...(config.scan?.exclude ?? []),
  ]);

  log("Watch mode — scanning now and on file changes (Ctrl-C to stop)");

  let scanning = false;
  let pendingRescan = false;
  let lastMtime = getLatestMtime(absDir, exclude);

  async function maybeScan() {
    const mtime = getLatestMtime(absDir, exclude);
    if (mtime <= lastMtime) return;
    lastMtime = mtime;

    if (scanning) { pendingRescan = true; return; }
    scanning = true;
    log("Changes detected — rescanning...");

    try {
      await runScan(projectDir, { ...opts, ci: false });
    } catch (e) {
      process.stderr.write(`[scan] Scan error: ${(e as Error).message}\n`);
    } finally {
      scanning = false;
      if (pendingRescan) {
        pendingRescan = false;
        await maybeScan();
      }
    }
  }

  // Initial scan (always notify on first run)
  void runScan(projectDir, { ...opts, ci: false }).then(() => {
    lastMtime = getLatestMtime(absDir, exclude);
    // Poll every 8 seconds — cheap and reliable without chokidar
    setInterval(() => { void maybeScan(); }, 8000);
  });
}

// ── Logger ─────────────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`[scan ${ts}] ${msg}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.watch) {
    runWatch(opts.dir, {
      noNotify: opts.noNotify,
      reportDir: opts.reportDir,
      failBelow: opts.failBelow,
    });
    // Keep process alive
    process.stdin.resume();
    return;
  }

  try {
    const code = await runScan(opts.dir, {
      noNotify: opts.noNotify,
      reportDir: opts.reportDir,
      ci: opts.ci,
      failBelow: opts.failBelow,
    });
    process.exit(code);
  } catch (e) {
    process.stderr.write(`[scan] Fatal error: ${(e as Error).message}\n`);
    if (process.env["SCAN_DEBUG"]) console.error(e);
    process.exit(1);
  }
}

void main();
