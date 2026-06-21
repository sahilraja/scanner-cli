import type { ScanConfig } from "./types";
export declare function loadConfig(projectDir: string): ScanConfig;
export declare function getReportDir(projectDir: string, config: ScanConfig): string;
