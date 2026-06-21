/**
 * FRD (Functional Requirements Document) parser for CLI
 * Extracts requirements from markdown files and tracks coverage
 */
import type { LocalRepo } from "./types";
import type { FrdSection } from "./types";
export declare function parseFrdDirectory(rootDir: string, frdDir: string, repo: LocalRepo): FrdSection[];
