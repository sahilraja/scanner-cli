import "server-only";
import { readRepoFile, type ExtractedRepo } from "./archive-walker";

/**
 * Documentation breadth scanner.
 *
 * The user explicitly asked us to "read .md or .MD files" and use that
 * for scoring, because Cursor-generated projects often skimp on tests
 * but ship a lot of generated planning docs / READMEs / architecture
 * notes. This module walks the extracted repo, picks up every Markdown
 * file (case-insensitive), and produces aggregate signals that the
 * scorer can reward.
 *
 * Cheap by design:
 *   - We only parse the *largest* N markdown files (default 25), but
 *     count *all* of them.
 *   - Each file is read with a bounded `maxFileBytes` cap.
 */

export type DocFileInfo = {
  /** Project-relative path. */
  file: string;
  /** Bytes on disk. */
  bytes: number;
  /** Word count (whitespace-separated tokens, post-trim). */
  word_count: number;
  /** Whether the doc has a top-level `# heading`. */
  has_top_heading: boolean;
  /** Number of `#` / `##` / `###` headings — readability proxy. */
  heading_count: number;
  /** Whether the doc has any fenced code blocks. */
  has_code_blocks: boolean;
  /** Whether the doc has at least one Markdown link. */
  has_links: boolean;
  /** Detected sections: setup, usage, api, architecture, deploy, etc. */
  sections: DocSectionFlags;
};

export type DocSectionFlags = {
  setup: boolean;
  usage: boolean;
  test: boolean;
  deploy: boolean;
  api: boolean;
  architecture: boolean;
  contributing: boolean;
  changelog: boolean;
  troubleshooting: boolean;
  faq: boolean;
};

export type RepoDocSignals = {
  /** Total number of .md / .MD files found in the repo. */
  total_md_files: number;
  /** Total bytes across all parsed docs (capped — see opts). */
  total_bytes_parsed: number;
  /** Sum of word counts across all parsed docs. */
  total_words: number;
  /** How many docs were parsed (a subset of `total_md_files`). */
  parsed_files: number;
  /** Per-file metrics for the parsed subset. */
  files: DocFileInfo[];
  /** True if there's a docs/ or doc/ directory anywhere. */
  has_docs_dir: boolean;
  /** True if at least one parsed file is named ARCHITECTURE.md / DESIGN.md. */
  has_architecture_doc: boolean;
  /** True if at least one parsed file is named API.md / API_REFERENCE.md. */
  has_api_doc: boolean;
  /** Aggregated section flags (OR across all parsed files). */
  sections: DocSectionFlags;
  /** Count of files in docs/ or doc/. */
  files_in_docs_dir: number;
  /** Total scan duration. */
  duration_ms: number;
  /** Warnings (e.g. "skipped 12 large files"). */
  warnings: string[];
};

export type DocScanOpts = {
  /** Skip files larger than this (bytes). Default 256 KB. */
  maxFileBytes?: number;
  /** Stop reading once total bytes-read crosses this. Default 4 MB. */
  maxBytesScanned?: number;
  /** Cap on how many docs we *parse*. Default 50. */
  maxFiles?: number;
};

const DEFAULT_OPTS: Required<DocScanOpts> = {
  maxFileBytes: 256 * 1024,
  maxBytesScanned: 4 * 1024 * 1024,
  maxFiles: 50,
};

const MD_EXT_RX = /\.(md|mdx|markdown)$/i;

function isMarkdownPath(p: string): boolean {
  if (!MD_EXT_RX.test(p)) return false;
  // Skip vendored docs that ship inside dependencies.
  const segs = p.split("/");
  if (segs.includes("node_modules")) return false;
  if (segs.includes("vendor")) return false;
  if (segs.includes(".cache")) return false;
  return true;
}

export function scanRepoDocs(
  repo: ExtractedRepo,
  opts?: DocScanOpts
): RepoDocSignals {
  const startedAt = Date.now();
  const merged = { ...DEFAULT_OPTS, ...opts };
  const warnings: string[] = [];

  const allMd = repo.files.filter(isMarkdownPath);
  const filesInDocsDir = allMd.filter(
    (p) => p.startsWith("docs/") || p.startsWith("doc/") || p.includes("/docs/") || p.includes("/doc/")
  ).length;

  // Decide which files to parse. Prefer docs that look "important":
  //   1. Anything named README / ARCHITECTURE / API / DESIGN at any depth.
  //   2. Anything inside docs/ or doc/.
  //   3. Then by file size (largest first — likely most informative).
  const importanceScore = (p: string): number => {
    const name = (p.split("/").pop() ?? "").toUpperCase();
    let score = 0;
    if (/^README/.test(name)) score += 10;
    if (/^ARCHITECTURE/.test(name)) score += 8;
    if (/^API/.test(name)) score += 8;
    if (/^DESIGN/.test(name)) score += 6;
    if (/^DEPLOY/.test(name)) score += 5;
    if (/^GETTING_STARTED/.test(name)) score += 5;
    if (/^USAGE/.test(name)) score += 4;
    if (/^CONTRIBUTING/.test(name)) score += 4;
    if (/^CHANGELOG/.test(name)) score += 2;
    if (/^TROUBLESHOOT/.test(name)) score += 3;
    if (/^FAQ/.test(name)) score += 2;
    if (p.startsWith("docs/") || p.includes("/docs/")) score += 3;
    return score;
  };
  const sorted = [...allMd].sort((a, b) => {
    const sa = importanceScore(a);
    const sb = importanceScore(b);
    if (sa !== sb) return sb - sa;
    // Secondary: shallower paths first, then alphabetical for stability.
    const da = a.split("/").length;
    const db = b.split("/").length;
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });
  const sliced = sorted.slice(0, merged.maxFiles);
  if (sorted.length > merged.maxFiles) {
    warnings.push(
      `Doc scan capped at ${merged.maxFiles} files; ${sorted.length - merged.maxFiles} skipped.`
    );
  }

  const aggSections: DocSectionFlags = {
    setup: false,
    usage: false,
    test: false,
    deploy: false,
    api: false,
    architecture: false,
    contributing: false,
    changelog: false,
    troubleshooting: false,
    faq: false,
  };
  const files: DocFileInfo[] = [];
  let totalBytes = 0;
  let totalWords = 0;
  let hasArchitectureDoc = false;
  let hasApiDoc = false;

  for (const filePath of sliced) {
    if (totalBytes > merged.maxBytesScanned) {
      warnings.push(
        `Doc scan capped at ${merged.maxBytesScanned} bytes; truncated.`
      );
      break;
    }
    const text = readRepoFile(repo, filePath, merged.maxFileBytes);
    if (text === null) continue;
    totalBytes += text.length;

    const info = analyseDocFile(filePath, text);
    files.push(info);
    totalWords += info.word_count;
    aggSections.setup ||= info.sections.setup;
    aggSections.usage ||= info.sections.usage;
    aggSections.test ||= info.sections.test;
    aggSections.deploy ||= info.sections.deploy;
    aggSections.api ||= info.sections.api;
    aggSections.architecture ||= info.sections.architecture;
    aggSections.contributing ||= info.sections.contributing;
    aggSections.changelog ||= info.sections.changelog;
    aggSections.troubleshooting ||= info.sections.troubleshooting;
    aggSections.faq ||= info.sections.faq;

    const upperName = (filePath.split("/").pop() ?? "").toUpperCase();
    if (/^(ARCHITECTURE|DESIGN|SYSTEM)/.test(upperName)) hasArchitectureDoc = true;
    if (/^API/.test(upperName)) hasApiDoc = true;
  }

  return {
    total_md_files: allMd.length,
    total_bytes_parsed: totalBytes,
    total_words: totalWords,
    parsed_files: files.length,
    files,
    has_docs_dir: filesInDocsDir > 0,
    has_architecture_doc: hasArchitectureDoc || aggSections.architecture,
    has_api_doc: hasApiDoc || aggSections.api,
    sections: aggSections,
    files_in_docs_dir: filesInDocsDir,
    duration_ms: Date.now() - startedAt,
    warnings,
  };
}

function analyseDocFile(filePath: string, text: string): DocFileInfo {
  const trimmed = text.trim();
  const lines = trimmed.split(/\r?\n/);
  let headingCount = 0;
  let hasTopHeading = false;
  for (const line of lines) {
    if (/^#{1,6}\s+\S/.test(line)) {
      headingCount += 1;
      if (/^#\s+\S/.test(line)) hasTopHeading = true;
    }
  }
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const hasCodeBlocks = /```/.test(text) || /^\s{4}\S/m.test(text);
  const hasLinks = /\[[^\]]+\]\([^)]+\)/.test(text);

  const sections: DocSectionFlags = {
    setup: /^#{1,6}\s+(setup|installation|getting started|quick ?start|prerequisites)/im.test(
      text
    ),
    usage: /^#{1,6}\s+(usage|how to use|examples?|tutorial|guide)/im.test(text),
    test: /^#{1,6}\s+(tests?|testing|running tests?|qa)/im.test(text),
    deploy: /^#{1,6}\s+(deploy|deployment|release|publishing|hosting)/im.test(
      text
    ),
    api: /^#{1,6}\s+(api|api ?reference|endpoints?|routes?|graphql)/im.test(
      text
    ),
    architecture: /^#{1,6}\s+(architecture|design|system|overview|tech ?stack|components|data ?flow)/im.test(
      text
    ),
    contributing: /^#{1,6}\s+(contribut(ing|ions?))/im.test(text),
    changelog: /^#{1,6}\s+(changelog|release notes|history)/im.test(text),
    troubleshooting: /^#{1,6}\s+(troubleshoot|known issues|debugging)/im.test(
      text
    ),
    faq: /^#{1,6}\s+(faq|frequently asked)/im.test(text),
  };

  return {
    file: filePath,
    bytes: text.length,
    word_count: wordCount,
    has_top_heading: hasTopHeading,
    heading_count: headingCount,
    has_code_blocks: hasCodeBlocks,
    has_links: hasLinks,
    sections,
  };
}
