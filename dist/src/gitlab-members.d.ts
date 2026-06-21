import type { ScanConfig } from "./types";
/** Fetch project member emails from GitLab API, falling back to git committers. */
export declare function resolveRecipients(projectDir: string, config: ScanConfig): Promise<string[]>;
