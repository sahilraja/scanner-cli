import type { LocalRepo, ScanConfig } from "./types";
export declare function walkLocalDirectory(projectDir: string, config: ScanConfig): LocalRepo;
export declare function readLocalFile(repo: LocalRepo, relPath: string, maxBytes?: number): string | null;
/** Walk directory and return the latest mtime (ms). Used by watch mode. */
export declare function getLatestMtime(dir: string, exclude?: Set<string>, depth?: number): number;
