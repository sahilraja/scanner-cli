/**
 * FRD (Functional Requirements Document) parser for CLI
 * Extracts requirements from markdown files and tracks coverage
 */

import fs from "node:fs";
import path from "node:path";
import type { LocalRepo } from "./types";
import type { FrdSection } from "./types";

export function parseFrdDirectory(
  rootDir: string,
  frdDir: string,
  repo: LocalRepo
): FrdSection[] {
  const frdPath = path.join(rootDir, frdDir);

  if (!fs.existsSync(frdPath)) {
    return [];
  }

  const sections: FrdSection[] = [];

  try {
    const files = fs.readdirSync(frdPath);

    for (const file of files) {
      if (!file.endsWith(".md")) continue;

      const filePath = path.join(frdPath, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = parseMarkdown(content, filePath, repo);
      sections.push(...parsed);
    }
  } catch (err) {
    console.warn(`Failed to parse FRD directory: ${err}`);
  }

  return sections;
}

function parseMarkdown(
  content: string,
  filePath: string,
  repo: LocalRepo
): FrdSection[] {
  const sections: FrdSection[] = [];
  const lines = content.split("\n");
  let currentSection: Partial<FrdSection> | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect heading levels
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      if (currentSection && currentSection.heading) {
        sections.push(currentSection as FrdSection);
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
    sections.push(currentSection as FrdSection);
  }

  // Mark covered sections
  return sections.map((section) => ({
    ...section,
    covered: section.evidence && section.evidence.length > 0,
  }));
}

function extractEvidence(line: string, repo: LocalRepo): string {
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
