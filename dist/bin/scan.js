#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("../src/config");
const local_walker_1 = require("../src/local-walker");
const scanners_1 = require("../src/scanners");
const scoring_1 = require("../src/scoring");
const pdf_export_1 = require("../src/pdf-export");
const frd_parser_1 = require("../src/frd-parser");
const gitlab_members_1 = require("../src/gitlab-members");
const notifier_1 = require("../src/notifier");
// ── CLI args ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const args = argv.slice(2);
    let dir = ".";
    let watch = false;
    let ci = false;
    let once = false;
    let noNotify = false;
    let failBelow = 0;
    let reportDir = null;
    for (let i = 0; i < args.length; i++) {
        const a = args[i] ?? "";
        if (a === "--watch" || a === "-w") {
            watch = true;
            once = false;
        }
        else if (a === "--once") {
            once = true;
            watch = false;
        }
        else if (a === "--ci") {
            ci = true;
            once = true;
        }
        else if (a === "--no-notify") {
            noNotify = true;
        }
        else if (a === "--fail-below") {
            failBelow = parseInt(args[++i] ?? "50", 10);
        }
        else if (a === "--report-dir") {
            reportDir = args[++i] ?? null;
        }
        else if (!a.startsWith("--")) {
            dir = a;
        }
    }
    if (!watch && !ci)
        once = true; // default to --once
    return { dir, watch, ci, once, noNotify, failBelow, reportDir };
}
// ── Core scan ─────────────────────────────────────────────────────────────────
async function runScan(projectDir, opts) {
    const absDir = node_path_1.default.resolve(projectDir);
    if (!node_fs_1.default.existsSync(absDir)) {
        process.stderr.write(`[scan] Directory not found: ${absDir}\n`);
        return 1;
    }
    const config = (0, config_1.loadConfig)(absDir);
    const projectName = config.name || node_path_1.default.basename(absDir);
    const reportDir = opts.reportDir
        ? node_path_1.default.resolve(opts.reportDir)
        : (0, config_1.getReportDir)(absDir, config);
    log(`Scanning ${projectName} (${absDir})`);
    // ── Walk ──────────────────────────────────────────────────────────────────
    const repo = (0, local_walker_1.walkLocalDirectory)(absDir, config);
    log(`  ${repo.files.length} files found`);
    // ── Scan ──────────────────────────────────────────────────────────────────
    const signals = (0, scanners_1.runScanners)(repo, projectName);
    log(`  Scan complete in ${signals.scan_duration_ms}ms`);
    // ── Score ─────────────────────────────────────────────────────────────────
    const scoring = (0, scoring_1.computeScores)(signals);
    const { grade, health_score, verdict } = scoring;
    log(`  Health: ${health_score}/100  Grade: ${grade}  Verdict: ${verdict}`);
    // ── FRD ───────────────────────────────────────────────────────────────────
    let frd = [];
    if (config.frd?.dir) {
        frd = (0, frd_parser_1.parseFrdDirectory)(absDir, config.frd.dir, repo);
        const covered = frd.filter((s) => s.covered).length;
        if (frd.length > 0)
            log(`  FRD: ${covered}/${frd.length} sections covered`);
    }
    // ── PDF ───────────────────────────────────────────────────────────────────
    node_fs_1.default.mkdirSync(reportDir, { recursive: true });
    const pdfBuffer = await (0, pdf_export_1.generatePdf)(signals, scoring, signals.languages);
    const dateStr = new Date(signals.scanned_at).toISOString().slice(0, 10);
    const safeName = projectName.replace(/[^a-z0-9]/gi, "-").toLowerCase();
    const pdfName = `health-report-${safeName}-${dateStr}.pdf`;
    const pdfPath = node_path_1.default.join(reportDir, pdfName);
    // Also write a "latest" symlink-friendly copy
    const latestPath = node_path_1.default.join(reportDir, "health-report.pdf");
    node_fs_1.default.writeFileSync(pdfPath, pdfBuffer);
    node_fs_1.default.writeFileSync(latestPath, pdfBuffer);
    log(`  PDF saved to ${pdfPath}`);
    // ── Notify ────────────────────────────────────────────────────────────────
    if (!opts.noNotify && (opts.ci || !signals.has_ci_gitlab)) {
        const recipients = await (0, gitlab_members_1.resolveRecipients)(absDir, config);
        await (0, notifier_1.notify)(pdfBuffer, signals, scoring, recipients, config);
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
function runWatch(projectDir, opts) {
    const absDir = node_path_1.default.resolve(projectDir);
    const config = (0, config_1.loadConfig)(absDir);
    const exclude = new Set([
        "node_modules", "dist", "build", ".git", ".next", "coverage",
        ...(config.scan?.exclude ?? []),
    ]);
    log("Watch mode — scanning now and on file changes (Ctrl-C to stop)");
    let scanning = false;
    let pendingRescan = false;
    let lastMtime = (0, local_walker_1.getLatestMtime)(absDir, exclude);
    async function maybeScan() {
        const mtime = (0, local_walker_1.getLatestMtime)(absDir, exclude);
        if (mtime <= lastMtime)
            return;
        lastMtime = mtime;
        if (scanning) {
            pendingRescan = true;
            return;
        }
        scanning = true;
        log("Changes detected — rescanning...");
        try {
            await runScan(projectDir, { ...opts, ci: false });
        }
        catch (e) {
            process.stderr.write(`[scan] Scan error: ${e.message}\n`);
        }
        finally {
            scanning = false;
            if (pendingRescan) {
                pendingRescan = false;
                await maybeScan();
            }
        }
    }
    // Initial scan (always notify on first run)
    void runScan(projectDir, { ...opts, ci: false }).then(() => {
        lastMtime = (0, local_walker_1.getLatestMtime)(absDir, exclude);
        // Poll every 8 seconds — cheap and reliable without chokidar
        setInterval(() => { void maybeScan(); }, 8000);
    });
}
// ── Logger ─────────────────────────────────────────────────────────────────────
function log(msg) {
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
    }
    catch (e) {
        process.stderr.write(`[scan] Fatal error: ${e.message}\n`);
        if (process.env["SCAN_DEBUG"])
            console.error(e);
        process.exit(1);
    }
}
void main();
