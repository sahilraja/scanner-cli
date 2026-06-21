/**
 * Scanner implementations for local CLI scanning
 * Mirrors mr-analyzer's scanner output format
 */
import type { LocalRepo } from "./types";
import type { CliSignals } from "./types";
export declare function runScanners(repo: LocalRepo, projectName: string): CliSignals & {
    project_path: string;
    default_branch: string | null;
    commit_sha: string | null;
    ref: string | null;
};
