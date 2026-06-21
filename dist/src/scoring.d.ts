/**
 * Scoring algorithm for CLI scanners
 * Computes dimension scores and health grade based on signals
 */
import type { CliSignals, ScoringResult } from "./types";
export declare function computeScores(signals: CliSignals & any): ScoringResult;
