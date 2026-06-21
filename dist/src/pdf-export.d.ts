/**
 * CLI PDF Export — Generates the exact same 27-page PDF as mr-analyzer UI
 *
 * All rendering code copied directly from mr-analyzer to ensure
 * 100% identical content and layout.
 */
export declare function generatePdf(signals: any, scoring: any, languages?: Record<string, number>): Promise<Buffer>;
