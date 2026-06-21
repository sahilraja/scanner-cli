"use strict";
/**
 * FRD (Functional Requirements Document) parser for CLI
 * Extracts requirements from markdown files and tracks coverage
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseFrdDirectory = parseFrdDirectory;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
function parseFrdDirectory(rootDir, frdDir, repo) {
    const frdPath = node_path_1.default.join(rootDir, frdDir);
    if (!node_fs_1.default.existsSync(frdPath)) {
        return [];
    }
    const sections = [];
    try {
        const files = node_fs_1.default.readdirSync(frdPath);
        for (const file of files) {
            if (!file.endsWith(".md"))
                continue;
            const filePath = node_path_1.default.join(frdPath, file);
            const content = node_fs_1.default.readFileSync(filePath, "utf-8");
            const parsed = parseMarkdown(content, filePath, repo);
            sections.push(...parsed);
        }
    }
    catch (err) {
        console.warn(`Failed to parse FRD directory: ${err}`);
    }
    return sections;
}
function parseMarkdown(content, filePath, repo) {
    const sections = [];
    const lines = content.split("\n");
    let currentSection = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Detect heading levels
        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            if (currentSection && currentSection.heading) {
                sections.push(currentSection);
            }
            const level = headingMatch[1].length;
            const heading = headingMatch[2];
            currentSection = {
                heading,
                level,
                file: filePath,
                evidence: [],
                covered: false,
            };
            continue;
        }
        // Collect evidence from current section
        if (currentSection && line.trim()) {
            const evidence = extractEvidence(line, repo);
            if (evidence) {
                currentSection.evidence = currentSection.evidence || [];
                currentSection.evidence.push(evidence);
            }
        }
    }
    // Add final section
    if (currentSection && currentSection.heading) {
        sections.push(currentSection);
    }
    // Mark covered sections
    return sections.map((section) => ({
        ...section,
        covered: section.evidence && section.evidence.length > 0,
    }));
}
function extractEvidence(line, repo) {
    // Look for file references, code blocks, or implementation notes
    const codeBlockMatch = line.match(/`([^`]+)`/);
    if (codeBlockMatch) {
        return codeBlockMatch[1];
    }
    const fileRefMatch = line.match(/([a-zA-Z0-9/_.-]+\.[a-zA-Z0-9]+)/);
    if (fileRefMatch) {
        const ref = fileRefMatch[1];
        if (repo.files.some((f) => f.includes(ref))) {
            return ref;
        }
    }
    return "";
}
