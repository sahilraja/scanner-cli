import type { CliSignals, ScanConfig, ScoringResult } from "./types";
export declare function sendEmail(pdfBuffer: Buffer, signals: CliSignals, scoring: ScoringResult, recipients: string[], config: ScanConfig): Promise<void>;
export declare function sendGoogleChat(signals: CliSignals, scoring: ScoringResult, config: ScanConfig): Promise<void>;
export declare function notify(pdfBuffer: Buffer, signals: CliSignals, scoring: ScoringResult, recipients: string[], config: ScanConfig): Promise<void>;
