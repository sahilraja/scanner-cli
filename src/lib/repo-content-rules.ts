import "server-only";
import {
  type ExtractedRepo,
  countLines,
  readRepoFile,
} from "./archive-walker";

/**
 * Regex-based content scanner that runs over every source file in
 * an extracted repo. Cheap, deterministic, no AST. Each rule emits
 * zero-or-more `RuleHit`s; the orchestrator aggregates them into a
 * `RepoContentSignals` object that scoring consumes.
 *
 * Design constraints:
 *   - Bounded per-file work: skip files larger than ~512 KB.
 *   - Bounded total work: stop reading after `maxBytesScanned` bytes.
 *   - No false-positive amplification: every rule has a description
 *     of WHY it fires so the UI can show the user.
 */

export type ContentSeverity = "critical" | "warning" | "suggestion";

export type ContentHit = {
  rule_id: string;
  severity: ContentSeverity;
  /** Project-relative path of the file that triggered. */
  file: string;
  /** 1-based line number, or 0 if not line-specific. */
  line: number;
  /** Human title shown in the UI. */
  title: string;
  /** Short evidence — usually the matched line, trimmed and shortened. */
  evidence: string;
};

export type RepoContentSignals = {
  /** Every individual hit. UI may show top-N grouped by severity. */
  hits: ContentHit[];
  /** Total bytes read across every source file. */
  bytes_scanned: number;
  /** Number of source files actually opened (after size filtering). */
  files_scanned: number;
  /** Number of files skipped because they were too big to inspect. */
  files_too_large: number;
  /** Roll-ups so scoring doesn't have to re-walk hits. */
  totals: {
    critical: number;
    warning: number;
    suggestion: number;
    /** Per-rule counts. */
    by_rule: Record<string, number>;
  };
  /** File-size distribution snapshot (for readability scoring). */
  loc: {
    total: number;
    median: number;
    p95: number;
    very_long: number; // files >500 LOC
  };
  /** Top files by line count, for debugging / UI display. */
  longest_files: Array<{ file: string; lines: number }>;
};

export type ContentScanOpts = {
  /** Skip files larger than this (bytes). Default 512 KB. */
  maxFileBytes?: number;
  /** Stop reading once total bytes-read crosses this. Default 50 MB. */
  maxBytesScanned?: number;
  /** Cap on how many files we scan at all. Default 10,000. */
  maxFiles?: number;
};

const DEFAULT_OPTS: Required<ContentScanOpts> = {
  maxFileBytes: 512 * 1024,
  maxBytesScanned: 50 * 1024 * 1024,
  maxFiles: 10_000,
};

const SOURCE_EXT = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "scala",
  "swift",
  "m",
  "mm",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "vue",
  "svelte",
  "dart",
  "lua",
  "ex",
  "exs",
]);

function isSource(p: string): boolean {
  const i = p.lastIndexOf(".");
  if (i === -1) return false;
  const ext = p.slice(i + 1).toLowerCase();
  if (!SOURCE_EXT.has(ext)) return false;
  // Skip vendored/built code that produces noisy false positives.
  return !VENDORED_PREFIXES.some((pre) => p.includes(pre));
}

const VENDORED_PREFIXES = [
  "node_modules/",
  "vendor/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  "coverage/",
  ".min.",
  ".bundle.",
];

/**
 * Files where running noisy rules ({@link NOISY_IN_TESTS_AND_SCRIPTS})
 * produces signal that doesn't reflect production code health. Tests
 * intentionally hit endpoints sequentially with `await` in loops. Seed
 * scripts insert fixture rows one-at-a-time. Build / migration scripts
 * `console.log` for visibility. Excluding these files keeps the
 * candidate-facing report focused on the live application code.
 */
const TEST_OR_SCRIPT_RX =
  /(^|\/)(tests?|__tests__|spec|specs|scripts?|seed|seeds|fixtures?|migrations?|db\/migrate|prisma\/migrations|\.storybook)(\/|$)|\.(test|spec|e2e|stories)\.(ts|tsx|js|jsx|mjs|cjs|py)$/i;

function isTestOrScriptFile(p: string): boolean {
  return TEST_OR_SCRIPT_RX.test(p);
}

/**
 * Rules whose hits are dominated by intentional patterns once you
 * leave production app code (e.g. tests, seeds, ops scripts). The
 * orchestrator skips these rules entirely for those file paths.
 */
const NOISY_IN_TESTS_AND_SCRIPTS = new Set([
  "await-in-loop",
  "console-log",
  "todo-fixme",
  "hardcoded-ipv4",
  "hardcoded-prod-url",
]);

/**
 * True if a single line is *only* a comment — `// …`, `/* …`, ` * …`,
 * `# …` (Python), or shell-style `#!`. Used to filter out string-mention
 * false positives where the rule keyword (e.g. `console.log`, `TODO`,
 * a URL) appears inside JSDoc / inline comment text rather than in a
 * real code expression.
 *
 * Note: this is intentionally a conservative line-level check. We do
 * not try to tokenise the file or follow `/* … *\/` bodies across
 * multiple lines — JSDoc bodies start with ` * ` which is what we
 * actually catch in the wild.
 */
function isLineComment(line: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed) return false;
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("#")
  );
}

// ── Rules ──────────────────────────────────────────────────────────────────

/**
 * Each rule returns an array of hits for the file. Rules are scoped
 * by extension where it matters (e.g. `eval(` differs between JS and
 * SQL). Anything with a low signal/noise ratio gets a `suggestion`
 * severity; high-confidence security smells are `critical`.
 */
type Rule = {
  id: string;
  severity: ContentSeverity;
  title: string;
  /** If set, only run on files whose lower-cased extension is in here. */
  extensions?: string[];
  apply: (file: string, lines: string[]) => ContentHit[];
};

function makeHit(
  rule: Pick<Rule, "id" | "severity" | "title">,
  file: string,
  line: number,
  matchedLine: string
): ContentHit {
  return {
    rule_id: rule.id,
    severity: rule.severity,
    file,
    line,
    title: rule.title,
    evidence: matchedLine.trim().slice(0, 200),
  };
}

/** Match a regex against every line, capping hits per-file so a single
 *  `console.log`-spammy file doesn't drown the report.
 *  Set `skipComments: true` to ignore lines that are themselves comments
 *  (JSDoc bodies, `// foo`, `# bar`). Use this for rules whose keyword
 *  routinely appears inside doc-comment bodies (e.g. `console.log`,
 *  TODO markers, URLs). */
function lineRule(
  rule: Pick<Rule, "id" | "severity" | "title">,
  rx: RegExp,
  perFileCap: number = 5,
  opts: { skipComments?: boolean } = {}
) {
  return (file: string, lines: string[]): ContentHit[] => {
    const hits: ContentHit[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (opts.skipComments && isLineComment(line)) continue;
      if (rx.test(line)) {
        hits.push(makeHit(rule, file, i + 1, line));
        if (hits.length >= perFileCap) break;
      }
    }
    return hits;
  };
}

const RULES: Rule[] = [
  // ── Hardcoded credentials ──────────────────────────────────────────────
  {
    id: "hardcoded-aws-key",
    severity: "critical",
    title: "Possible AWS access key id in source",
    apply: lineRule(
      {
        id: "hardcoded-aws-key",
        severity: "critical",
        title: "Possible AWS access key id in source",
      },
      /\bAKIA[0-9A-Z]{16}\b/
    ),
  },
  {
    id: "hardcoded-private-key",
    severity: "critical",
    title: "PEM private key block in source",
    apply: lineRule(
      {
        id: "hardcoded-private-key",
        severity: "critical",
        title: "PEM private key block in source",
      },
      /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/
    ),
  },
  {
    id: "hardcoded-bearer",
    severity: "critical",
    title: "Bearer token literal in source",
    apply: lineRule(
      {
        id: "hardcoded-bearer",
        severity: "critical",
        title: "Bearer token literal in source",
      },
      /\b(?:authorization|api[_-]?key|secret|password)\s*[:=]\s*["'][a-z0-9._-]{16,}["']/i
    ),
  },
  {
    id: "hardcoded-jwt",
    severity: "critical",
    title: "Hardcoded JWT in source",
    apply: lineRule(
      {
        id: "hardcoded-jwt",
        severity: "critical",
        title: "Hardcoded JWT in source",
      },
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/
    ),
  },

  // ── Dangerous JS/TS patterns ──────────────────────────────────────────
  {
    id: "js-eval",
    severity: "warning",
    title: "Use of eval()",
    extensions: ["js", "jsx", "ts", "tsx", "mjs", "cjs"],
    apply: lineRule(
      { id: "js-eval", severity: "warning", title: "Use of eval()" },
      /(^|[^A-Za-z0-9_$.])eval\s*\(/
    ),
  },
  {
    id: "js-new-function",
    severity: "warning",
    title: "Use of new Function()",
    extensions: ["js", "jsx", "ts", "tsx", "mjs", "cjs"],
    apply: lineRule(
      {
        id: "js-new-function",
        severity: "warning",
        title: "Use of new Function()",
      },
      /\bnew\s+Function\s*\(/
    ),
  },
  {
    id: "js-document-write",
    severity: "warning",
    title: "Use of document.write()",
    extensions: ["js", "jsx", "ts", "tsx", "html"],
    apply: lineRule(
      {
        id: "js-document-write",
        severity: "warning",
        title: "Use of document.write()",
      },
      /\bdocument\.write\s*\(/
    ),
  },
  {
    id: "js-inner-html",
    severity: "suggestion",
    title: "innerHTML assignment (XSS risk if value is untrusted)",
    extensions: ["js", "jsx", "ts", "tsx"],
    apply: lineRule(
      {
        id: "js-inner-html",
        severity: "suggestion",
        title: "innerHTML assignment (XSS risk if value is untrusted)",
      },
      /\.innerHTML\s*=/
    ),
  },
  {
    id: "console-log",
    severity: "suggestion",
    title: "console.log left in source",
    extensions: ["js", "jsx", "ts", "tsx", "mjs", "cjs"],
    apply: lineRule(
      {
        id: "console-log",
        severity: "suggestion",
        title: "console.log left in source",
      },
      /(^|[^A-Za-z0-9_$.])console\.log\s*\(/,
      3,
      { skipComments: true }
    ),
  },

  // ── SQL / shell injection ──────────────────────────────────────────────
  {
    id: "sql-string-concat",
    severity: "warning",
    title: "SQL built via string concatenation (injection risk)",
    apply: (file: string, lines: string[]): ContentHit[] => {
      const out: ContentHit[] = [];
      const rx = /\b(SELECT|INSERT|UPDATE|DELETE)\b[^;]{0,200}["'`]\s*\+/i;
      for (let i = 0; i < lines.length && out.length < 3; i += 1) {
        if (rx.test(lines[i])) {
          out.push(
            makeHit(
              {
                id: "sql-string-concat",
                severity: "warning",
                title: "SQL built via string concatenation (injection risk)",
              },
              file,
              i + 1,
              lines[i]
            )
          );
        }
      }
      return out;
    },
  },
  {
    id: "shell-exec",
    severity: "warning",
    title: "Shell command executed via exec()/spawn() with string template",
    extensions: ["js", "jsx", "ts", "tsx", "mjs", "cjs"],
    apply: lineRule(
      {
        id: "shell-exec",
        severity: "warning",
        title: "Shell command executed via exec()/spawn() with string template",
      },
      /\b(execSync|exec|spawnSync|spawn)\s*\(\s*[`"]/
    ),
  },

  // ── Python smells ──────────────────────────────────────────────────────
  {
    id: "py-eval-exec",
    severity: "warning",
    title: "Use of eval()/exec() in Python",
    extensions: ["py"],
    apply: lineRule(
      {
        id: "py-eval-exec",
        severity: "warning",
        title: "Use of eval()/exec() in Python",
      },
      /^[^#]*\b(eval|exec)\s*\(/
    ),
  },
  {
    id: "py-pickle-load",
    severity: "warning",
    title: "pickle.load on untrusted data is unsafe",
    extensions: ["py"],
    apply: lineRule(
      {
        id: "py-pickle-load",
        severity: "warning",
        title: "pickle.load on untrusted data is unsafe",
      },
      /\bpickle\.(loads?|Unpickler)\s*\(/
    ),
  },
  {
    id: "py-shell-true",
    severity: "warning",
    title: "subprocess(... shell=True) with non-literal args",
    extensions: ["py"],
    apply: lineRule(
      {
        id: "py-shell-true",
        severity: "warning",
        title: "subprocess(... shell=True) with non-literal args",
      },
      /shell\s*=\s*True/
    ),
  },

  // ── Cryptography weakness ──────────────────────────────────────────────
  {
    id: "weak-hash-md5",
    severity: "warning",
    title: "MD5 used (broken for cryptographic uses)",
    apply: lineRule(
      {
        id: "weak-hash-md5",
        severity: "warning",
        title: "MD5 used (broken for cryptographic uses)",
      },
      /\b(md5|MD5)\s*\(/
    ),
  },
  {
    id: "weak-hash-sha1",
    severity: "warning",
    title: "SHA1 used (broken for cryptographic uses)",
    apply: lineRule(
      {
        id: "weak-hash-sha1",
        severity: "warning",
        title: "SHA1 used (broken for cryptographic uses)",
      },
      /\b(sha1|SHA1|SHA-1)\b/
    ),
  },

  // ── Code quality smells ────────────────────────────────────────────────
  {
    id: "todo-fixme",
    severity: "suggestion",
    title: "TODO/FIXME/HACK marker",
    // Only fire when the marker appears as part of a comment marker
    // (`// TODO …`, `/* FIXME …`, `# HACK …`, ` * XXX …`). The previous
    // permissive `\bTODO\b` regex matched literal status enum values
    // like `{ status: "TODO" }`, producing dozens of false positives in
    // codebases that happen to use the word as a domain term.
    apply: lineRule(
      {
        id: "todo-fixme",
        severity: "suggestion",
        title: "TODO/FIXME/HACK marker",
      },
      /(?:\/\/|\/\*+|\*|#)\s*\b(TODO|FIXME|HACK|XXX)\b[\s:]/,
      3
    ),
  },
  {
    id: "ts-any",
    severity: "suggestion",
    title: "Use of `any` type weakens TS guarantees",
    extensions: ["ts", "tsx"],
    apply: lineRule(
      {
        id: "ts-any",
        severity: "suggestion",
        title: "Use of `any` type weakens TS guarantees",
      },
      /:\s*any\b|<\s*any\s*>/,
      3
    ),
  },
  {
    id: "ts-ts-ignore",
    severity: "suggestion",
    title: "@ts-ignore / @ts-expect-error suppression",
    extensions: ["ts", "tsx"],
    apply: lineRule(
      {
        id: "ts-ts-ignore",
        severity: "suggestion",
        title: "@ts-ignore / @ts-expect-error suppression",
      },
      /@ts-(ignore|expect-error)/
    ),
  },

  // ── Error-handling smells ─────────────────────────────────────────────
  {
    id: "empty-catch",
    severity: "warning",
    title: "Empty catch swallows errors",
    extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs"],
    // Matches both `catch {}` (TS 4.0+) and `catch (e) {}` with optional
    // whitespace/newlines between the brace pair. Multi-line scan via
    // a single concatenated string + global regex; per-file capped to
    // avoid runaway logs on auto-generated files.
    apply: (file, lines) => {
      const text = lines.join("\n");
      const rx = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
      const hits: ContentHit[] = [];
      let m: RegExpExecArray | null;
      while ((m = rx.exec(text)) !== null && hits.length < 5) {
        const lineNo = text.slice(0, m.index).split("\n").length;
        hits.push(
          makeHit(
            {
              id: "empty-catch",
              severity: "warning",
              title: "Empty catch swallows errors",
            },
            file,
            lineNo,
            (lines[lineNo - 1] ?? "").trim() || "catch {}"
          )
        );
      }
      return hits;
    },
  },
  {
    id: "swallowed-promise",
    severity: "suggestion",
    title: "Promise rejection silently swallowed",
    extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs"],
    apply: lineRule(
      {
        id: "swallowed-promise",
        severity: "suggestion",
        title: "Promise rejection silently swallowed",
      },
      /\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)|\.catch\s*\(\s*\(\s*[^)]*\s*\)\s*=>\s*\{\s*\}\s*\)/,
      3
    ),
  },

  // ── Performance / async smells ────────────────────────────────────────
  {
    id: "await-in-loop",
    severity: "warning",
    title: "Sequential await inside a loop (N+1 risk)",
    extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs"],
    apply: (file, lines) => {
      // Two-line stateful walk: track whether the most recent statement
      // opened a `for`/`while` block, then flag any subsequent `await`
      // before the matching brace closes. Coarse but effective at
      // catching the classic N+1 pattern.
      const hits: ContentHit[] = [];
      let depth = 0;
      let loopAtDepth: number | null = null;
      for (let i = 0; i < lines.length && hits.length < 4; i += 1) {
        const line = lines[i] ?? "";
        if (/\b(for|while)\s*\([^)]*\)\s*\{/.test(line) || /\bfor\s*\([^)]*\)\s*$/.test(line)) {
          loopAtDepth = depth + 1;
        }
        // Track brace depth — naive but only used as a contains-check.
        const opens = (line.match(/\{/g) ?? []).length;
        const closes = (line.match(/\}/g) ?? []).length;
        depth += opens - closes;
        if (loopAtDepth !== null && depth < loopAtDepth) loopAtDepth = null;
        if (
          loopAtDepth !== null &&
          /(^|[^A-Za-z0-9_$])await\s+/.test(line) &&
          // Skip Promise.all(...) which is the *fix*, not the smell.
          !/await\s+Promise\.(all|allSettled|race)\b/.test(line)
        ) {
          hits.push(
            makeHit(
              {
                id: "await-in-loop",
                severity: "warning",
                title: "Sequential await inside a loop (N+1 risk)",
              },
              file,
              i + 1,
              line
            )
          );
        }
      }
      return hits;
    },
  },

  // ── Web security ──────────────────────────────────────────────────────
  {
    id: "cors-wildcard",
    severity: "warning",
    title: "Permissive CORS (Access-Control-Allow-Origin: *)",
    apply: lineRule(
      {
        id: "cors-wildcard",
        severity: "warning",
        title: "Permissive CORS (Access-Control-Allow-Origin: *)",
      },
      /(Access-Control-Allow-Origin\s*[:=]\s*["']?\*|origin\s*:\s*["']?\*["']?|cors\(\s*\{[^}]*origin\s*:\s*["']?\*["']?)/i
    ),
  },
  {
    id: "cookie-insecure",
    severity: "warning",
    title: "Set-Cookie / cookie() missing httpOnly+secure+sameSite",
    extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs"],
    apply: (file, lines) => {
      // Grep for cookie-set sites, then check the same line + one or
      // two adjacent lines for the three flags. If any of them are
      // missing we emit a single hit per call site.
      const hits: ContentHit[] = [];
      for (let i = 0; i < lines.length && hits.length < 5; i += 1) {
        const line = lines[i] ?? "";
        if (
          !/\b(setHeader\s*\(\s*['"]Set-Cookie|res\.cookie\s*\(|reply\.setCookie\s*\(|cookies\.set\s*\(|new\s+Cookie\s*\()/.test(
            line
          )
        )
          continue;
        const window = [
          lines[i] ?? "",
          lines[i + 1] ?? "",
          lines[i + 2] ?? "",
        ].join(" ");
        const httpOnly = /httpOnly/i.test(window);
        const secure = /\bsecure\b/i.test(window);
        const sameSite = /sameSite/i.test(window);
        if (httpOnly && secure && sameSite) continue;
        const missing = [
          !httpOnly && "httpOnly",
          !secure && "secure",
          !sameSite && "sameSite",
        ]
          .filter(Boolean)
          .join(", ");
        hits.push(
          makeHit(
            {
              id: "cookie-insecure",
              severity: "warning",
              title: "Set-Cookie / cookie() missing httpOnly+secure+sameSite",
            },
            file,
            i + 1,
            `${line.trim()}  // missing: ${missing}`
          )
        );
      }
      return hits;
    },
  },
  {
    id: "hardcoded-prod-url",
    severity: "suggestion",
    title: "Hardcoded production-looking URL in source",
    apply: lineRule(
      {
        id: "hardcoded-prod-url",
        severity: "suggestion",
        title: "Hardcoded production-looking URL in source",
      },
      // URLs whose host ends in .com/.io/.net/.dev/.app/.cloud — exclude
      // common docs hosts and example.* placeholders. Test files are
      // skipped at the orchestrator level for noisy rules.
      /https?:\/\/(?!(?:www\.)?(?:example|localhost|0\.0\.0\.0|127\.0\.0\.1|github\.com|gitlab\.com|npmjs\.com|nodejs\.org|developer\.mozilla\.org|reactjs\.org|nextjs\.org|tailwindcss\.com|vercel\.com)[\/:])[a-z0-9.-]+\.(com|io|net|dev|app|cloud|co|ai|sh|aws|azure|gcp)\b/i,
      3,
      { skipComments: true }
    ),
  },
  {
    id: "hardcoded-ipv4",
    severity: "suggestion",
    title: "Hardcoded IPv4 address (likely a real host)",
    apply: lineRule(
      {
        id: "hardcoded-ipv4",
        severity: "suggestion",
        title: "Hardcoded IPv4 address (likely a real host)",
      },
      // Standalone IPv4, excluding loopback / RFC1918 placeholders we
      // commonly see in dev configs.
      /(?<![\d.])(?!0\.0\.0\.0|127\.0\.0\.1|255\.255\.255\.255|10\.\d|192\.168\.\d|172\.(?:1[6-9]|2\d|3[01])\.\d)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])/,
      3,
      { skipComments: true }
    ),
  },

  // ── Frontend / a11y ───────────────────────────────────────────────────
  {
    id: "jsx-img-no-alt",
    severity: "suggestion",
    title: "<img> missing alt attribute (a11y)",
    extensions: ["jsx", "tsx"],
    apply: (file, lines) => {
      const hits: ContentHit[] = [];
      for (let i = 0; i < lines.length && hits.length < 4; i += 1) {
        const line = lines[i] ?? "";
        // Look for `<img …>` openings with no `alt=` anywhere in the
        // visible chunk. We only check the same line — multi-line JSX
        // tags will produce a small false-negative rate, acceptable.
        if (!/<img\b/.test(line)) continue;
        if (/\balt\s*=/.test(line)) continue;
        hits.push(
          makeHit(
            {
              id: "jsx-img-no-alt",
              severity: "suggestion",
              title: "<img> missing alt attribute (a11y)",
            },
            file,
            i + 1,
            line
          )
        );
      }
      return hits;
    },
  },
  {
    id: "jsx-dangerous-html",
    severity: "warning",
    title: "dangerouslySetInnerHTML — XSS risk if user-controlled",
    extensions: ["jsx", "tsx"],
    apply: lineRule(
      {
        id: "jsx-dangerous-html",
        severity: "warning",
        title: "dangerouslySetInnerHTML — XSS risk if user-controlled",
      },
      /dangerouslySetInnerHTML/,
      3
    ),
  },
  // ── Operations / migrations ───────────────────────────────────────────
  {
    id: "destructive-migration",
    severity: "warning",
    title: "Destructive change in migration file",
    apply: (file, lines) => {
      // Only fire on files under a migrations/ folder. Other paths
      // legitimately reference these statements in seed scripts.
      const lower = file.toLowerCase();
      if (!/(^|\/)(migrations?|prisma\/migrations|db\/migrate)(\/|$)/.test(lower))
        return [];
      const hits: ContentHit[] = [];
      const rx =
        /\b(DROP\s+(TABLE|COLUMN|INDEX|SCHEMA|DATABASE|VIEW)|TRUNCATE\s+TABLE|ALTER\s+TABLE\s+\S+\s+DROP\s+(COLUMN|CONSTRAINT))\b/i;
      for (let i = 0; i < lines.length && hits.length < 5; i += 1) {
        const line = lines[i] ?? "";
        if (rx.test(line)) {
          hits.push(
            makeHit(
              {
                id: "destructive-migration",
                severity: "warning",
                title: "Destructive change in migration file",
              },
              file,
              i + 1,
              line
            )
          );
        }
      }
      return hits;
    },
  },
];

// ── Orchestrator ──────────────────────────────────────────────────────────

export function scanRepoContent(
  repo: ExtractedRepo,
  opts?: ContentScanOpts
): RepoContentSignals {
  const merged = { ...DEFAULT_OPTS, ...opts };
  const hits: ContentHit[] = [];
  const byRule: Record<string, number> = {};
  const totals = { critical: 0, warning: 0, suggestion: 0 };

  let bytesScanned = 0;
  let filesScanned = 0;
  let filesTooLarge = 0;

  const sources = repo.files.filter(isSource);
  const sliced = sources.slice(0, merged.maxFiles);

  const lineCounts: number[] = [];
  let totalLoc = 0;
  let veryLong = 0;
  const longestList: Array<{ file: string; lines: number }> = [];

  for (const f of sliced) {
    if (bytesScanned > merged.maxBytesScanned) break;

    const text = readRepoFile(repo, f, merged.maxFileBytes);
    if (text === null) {
      filesTooLarge += 1;
      // For too-large files we still get a line count cheaply (no string in RAM).
      const lc = countLines(repo, f);
      lineCounts.push(lc);
      totalLoc += lc;
      if (lc >= 500) {
        veryLong += 1;
        if (longestList.length < 50)
          longestList.push({ file: f, lines: lc });
      }
      continue;
    }

    bytesScanned += text.length;
    filesScanned += 1;

    const lines = text.split(/\r?\n/);
    const lc = lines.length;
    lineCounts.push(lc);
    totalLoc += lc;
    if (lc >= 500) {
      veryLong += 1;
      if (longestList.length < 50)
        longestList.push({ file: f, lines: lc });
    }

    const fileExt = (f.split(".").pop() ?? "").toLowerCase();
    const isTestOrScript = isTestOrScriptFile(f);
    for (const rule of RULES) {
      if (rule.extensions && !rule.extensions.includes(fileExt)) continue;
      // Skip rules that produce systematic false positives in test /
      // seed / migration / script files. The patterns these rules
      // detect (sequential awaits, hardcoded fixture IPs, console.log
      // for visibility) are intentional in those contexts.
      if (isTestOrScript && NOISY_IN_TESTS_AND_SCRIPTS.has(rule.id)) continue;
      const fileHits = rule.apply(f, lines);
      for (const h of fileHits) {
        hits.push(h);
        totals[h.severity] += 1;
        byRule[h.rule_id] = (byRule[h.rule_id] ?? 0) + 1;
      }
    }
  }

  // Stat summary from collected line counts.
  const sorted = [...lineCounts].sort((a, b) => a - b);
  const median =
    sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
  const p95 =
    sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length * 0.95)];

  longestList.sort((a, b) => b.lines - a.lines);

  return {
    hits,
    bytes_scanned: bytesScanned,
    files_scanned: filesScanned,
    files_too_large: filesTooLarge,
    totals: { ...totals, by_rule: byRule },
    loc: {
      total: totalLoc,
      median,
      p95,
      very_long: veryLong,
    },
    longest_files: longestList.slice(0, 10),
  };
}
