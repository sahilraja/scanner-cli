"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadConfig = loadConfig;
exports.getReportDir = getReportDir;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const CONFIG_FILE = "scan.config.json";
const DEFAULTS = {
    exclude: ["node_modules", "dist", "build", ".git", ".next", "coverage", ".turbo", "out"],
    reportDir: "reports",
    maxFileSizeBytes: 512 * 1024,
    failBelow: 0,
};
function loadConfig(projectDir) {
    const configPath = node_path_1.default.join(projectDir, CONFIG_FILE);
    let raw;
    if (!node_fs_1.default.existsSync(configPath)) {
        return { name: node_path_1.default.basename(projectDir), scan: DEFAULTS };
    }
    try {
        raw = JSON.parse(node_fs_1.default.readFileSync(configPath, "utf-8"));
    }
    catch (e) {
        throw new Error(`Failed to parse ${CONFIG_FILE}: ${e.message}`);
    }
    if (typeof raw !== "object" || raw === null) {
        throw new Error(`${CONFIG_FILE} must be a JSON object`);
    }
    const cfg = raw;
    cfg.scan = { ...DEFAULTS, ...(cfg.scan ?? {}) };
    return resolveEnvVars(cfg);
}
function getReportDir(projectDir, config) {
    const rel = config.scan?.reportDir ?? DEFAULTS.reportDir;
    return node_path_1.default.isAbsolute(rel) ? rel : node_path_1.default.join(projectDir, rel);
}
function resolveEnvVars(cfg) {
    const json = JSON.stringify(cfg);
    const resolved = json.replace(/\$\{([^}]+)\}/g, (_, varName) => {
        const val = process.env[varName];
        if (!val) {
            process.stderr.write(`[scan] warn: env var ${varName} not set (used in scan.config.json)\n`);
        }
        return val ?? "";
    });
    return JSON.parse(resolved);
}
