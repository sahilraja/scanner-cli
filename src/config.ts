import fs from "node:fs";
import path from "node:path";
import type { ScanConfig } from "./types";

const CONFIG_FILE = "scan.config.json";

const DEFAULTS: Required<NonNullable<ScanConfig["scan"]>> = {
  exclude: ["node_modules", "dist", "build", ".git", ".next", "coverage", ".turbo", "out"],
  reportDir: "reports",
  maxFileSizeBytes: 512 * 1024,
  failBelow: 0,
};

export function loadConfig(projectDir: string): ScanConfig {
  const configPath = path.join(projectDir, CONFIG_FILE);
  let raw: unknown;

  if (!fs.existsSync(configPath)) {
    return { name: path.basename(projectDir), scan: DEFAULTS };
  }

  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (e) {
    throw new Error(`Failed to parse ${CONFIG_FILE}: ${(e as Error).message}`);
  }

  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${CONFIG_FILE} must be a JSON object`);
  }

  const cfg = raw as ScanConfig;
  cfg.scan = { ...DEFAULTS, ...(cfg.scan ?? {}) };

  return resolveEnvVars(cfg);
}

export function getReportDir(projectDir: string, config: ScanConfig): string {
  const rel = config.scan?.reportDir ?? DEFAULTS.reportDir;
  return path.isAbsolute(rel) ? rel : path.join(projectDir, rel);
}

function resolveEnvVars(cfg: ScanConfig): ScanConfig {
  const json = JSON.stringify(cfg);
  const resolved = json.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
    const val = process.env[varName];
    if (!val) {
      process.stderr.write(`[scan] warn: env var ${varName} not set (used in scan.config.json)\n`);
    }
    return val ?? "";
  });
  return JSON.parse(resolved) as ScanConfig;
}
